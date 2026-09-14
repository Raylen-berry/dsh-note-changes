// 验"并发追加不会丢记录"（2026-09-14 审计 P1）。
//
// 缺陷形状：追加是"读全文 → 拼接 → 写回全文"。两个并发调用各读各的旧内容时，
// 后写的那次把先写的**整段覆盖**掉，而两次都返回成功 —— 用户只看到记录少了一条。
//
// 本套件用**人工延迟**把 await 之间的交错窗口撑开（真实场景是磁盘慢/工具被并发调用），
// 然后并发跑两次 append，断言两条记录都在。
//
// A/B 用法：同一个脚本对着"改动前"的 index.js 跑一遍应当**失败**（证明它测得出这个 bug），
// 对着改动后的跑应当通过。用环境变量 DNC_INDEX 指定被测文件，默认取仓库工作副本。
const fs = await import('node:fs')
const pathMod = await import('node:path')
const os = await import('node:os')
const url = await import('node:url')
const __dir = pathMod.dirname(url.fileURLToPath(import.meta.url))
const INDEX = process.env.DNC_INDEX || pathMod.resolve(__dir, '../index.js')
const ROOT = pathMod.join(os.tmpdir(), 'dsh-nc-append-lock')
const { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } = fs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(pathMod.join(ROOT, 'vault', '00-收件箱', '日记'), { recursive: true })
const VAULT = ROOT.replace(/\\/g, '/') + '/vault'
const DAILY = pathMod.join(ROOT, 'vault', '00-收件箱', '日记')
  ;['2026-09-14.md'] // 只留注释：具体文件名由下面按当天日期算，测试里不依赖固定日期

// ---- 抓工具注册（host 半的 apply 会把 vault_note_append 注册进来）----
const registered = {}
const writes = []
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: () => () => {} }
    if (name === 'fs') {
      return {
        resolve: async (p) => p,
        stat: async (p) => { await sleep(8); return existsSync(p) ? { size: readFileSync(p).length } : null },
        // 读慢一点：这就是交错窗口的来源
        readText: async (p) => { await sleep(8); return existsSync(p) ? readFileSync(p, 'utf8') : '' },
        writeText: async (p, text) => { await sleep(8); writes.push(p); mkdirSync(pathMod.dirname(p), { recursive: true }); writeFileSync(p, text, 'utf8') },
      }
    }
    if (name === 'agents') return { on: () => () => {}, list: async () => [], currentInitiator: () => null }
    return undefined
  },
  effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
  tools: { register: (def) => { if (def && def.name) registered[def.name] = def } },
  on: () => () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

// 指针文件也指到夹具，确保任何引导路径都落在临时目录里
const HOME = ROOT + '/home'
mkdirSync(pathMod.join(HOME, 'dsh-note-changes'), { recursive: true })
writeFileSync(pathMod.join(HOME, 'dsh-note-changes', 'vault.txt'), VAULT + '\n', 'utf8')
process.env.DSH_HOME = HOME.replace(/\\/g, '/')

const mod = await import(url.pathToFileURL(INDEX).href + '?lock' + Date.now())
await (mod.apply || mod.default.apply)(ctx)

console.log('— 1. 工具注册 —')
const tool = registered['vault_note_append']
ok('vault_note_append 已注册', !!tool && typeof tool.execute === 'function', Object.keys(registered).join(','))
if (!tool) { console.log('\n结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败'); process.exit(1) }

console.log('\n— 2. 并发两次追加（同一份日记）—')
const [r1, r2] = await Promise.all([
  tool.execute({ vault: VAULT, title: '并发批次A', points: ['A 的第一条要点'] }),
  tool.execute({ vault: VAULT, title: '并发批次B', points: ['B 的第一条要点'] }),
])
const files = fs.readdirSync(DAILY)
ok('日记文件只有一个', files.length === 1, files.join(','))
const text = readFileSync(pathMod.join(DAILY, files[0]), 'utf8')
ok('A 的要点在盘上', text.includes('A 的第一条要点'), 'txt len=' + text.length)
ok('B 的要点在盘上', text.includes('B 的第一条要点'), 'txt len=' + text.length)
ok('两条都没丢（这就是原缺陷会丢掉一条的地方）',
  text.includes('A 的第一条要点') && text.includes('B 的第一条要点'))
ok('两个标题也都在', text.includes('并发批次A') && text.includes('并发批次B'))
ok('两次都自报成功', String(r1).startsWith('已写入') && String(r2).startsWith('已写入'), String(r1).slice(0, 24) + ' | ' + String(r2).slice(0, 24))
ok('只写了两次盘（没有多余的整篇重写）', writes.length === 2, 'writes=' + writes.length)

console.log('\n— 3. 顺序追加仍然叠加（防"修过头"）—')
const r3 = await tool.execute({ vault: VAULT, title: '串行批次C', points: ['C 的一条要点'] })
const text2 = readFileSync(pathMod.join(DAILY, files[0]), 'utf8')
ok('串行追加后三条都在', ['A 的第一条要点', 'B 的第一条要点', 'C 的一条要点'].every((s) => text2.includes(s)))
ok('返回里带了长度变化', /→/.test(String(r3)), String(r3).slice(0, 40))

console.log('\n— 4. 日志版本号与 package.json 一致（防"日志写死版本"变成误导源）—')
// 现场：日志长期打 `host up (v1.5.0)` 而 package.json 已是 1.5.2 —— 排查时会把人往错版本上带。
// 不放开运行时去读 package.json（给宿主加载路径加一次 IO 不值当），改为把"字面量 == 真版本"钉进门禁。
const PKG_DIR = pathMod.dirname(pathMod.resolve(INDEX))
const pkgVersion = JSON.parse(readFileSync(pathMod.join(PKG_DIR, 'package.json'), 'utf8')).version
const hostSrc = readFileSync(pathMod.resolve(INDEX), 'utf8')
const logVersions = [...hostSrc.matchAll(/host up \((?:v)?(\d+\.\d+\.\d+)/g)].map((m) => m[1])
ok('日志里找得到版本号字面量', logVersions.length > 0, logVersions.join(','))
ok('日志版本 == package.json 版本', logVersions.length > 0 && logVersions.every((v) => v === pkgVersion),
  '日志=' + (logVersions.join(',') || '(无)') + '  package.json=' + pkgVersion)

// 清场（夹具在临时区，不影响真实 vault）
rmSync(ROOT, { recursive: true, force: true })

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
