// 路由级回归：四条 exact 路由（log / note / settings / sync）+ 两条模型工具 + 版本闸门。
//
// 为什么单独写一份：verify-append-lock 与 verify-git-sync 只覆盖"导出函数 + 工具路径"，
// **不碰路由 handler** —— 而查询参数解析（queryParam）、settings 的 lastSync 字段、
// sync 路由的命令序列都只活在 handler 里。本脚本用 ctx 桩把 handler 抓出来直接调用
// （不起 HTTP、不联网、不读真实 vault）；client 半用 __ModuleLoader__ 桩加载 factory，
// 只取 exports.internals 与日志字面量。
//
//   node tools/verify-note-changes-routes.mjs
//   DNC_INDEX=<别的 index.js> 可对旧版本跑（应能看到 sync / lastSync / search 相关断言全 FAIL）
const pathMod = await import('node:path')
const url = await import('node:url')
const fsMod = await import('node:fs')
const ROOT = pathMod.resolve(pathMod.dirname(url.fileURLToPath(import.meta.url)), '..')
const INDEX = process.env.DNC_INDEX || pathMod.join(ROOT, 'index.js')
const CLIENT = process.env.DNC_CLIENT || pathMod.join(ROOT, 'client.js')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const GIT_LOG = [
  'commit 0123456789abcdef0123456789abcdef01234567',
  'Author: Zhang San <zs@example.com>',
  'Date:   2026-09-23',
  '',
  '    日记 2026-09-23 要点：瘦身',
  '',
  '00-收件箱/日记/2026-09-23.md',
  '99-模板/日记模板.md',
  'notes.txt',
  '',
].join('\n')

const SETTINGS_TEXT = [
  '---',
  'title: 插件设置',
  'scanVault: true',
  'autoWriteOnSessionEnd: true',
  '---',
  '',
  '# 插件设置',
  '',
].join('\n')

// ---- ctx 桩 ---------------------------------------------------------------
const routes = {}
const tools = []
const calls = { resolve: [], readText: [], writeText: [], git: [] }
const disk = new Map()
let gitQueue = []          // 每次 git 调用前 shift 一个结果；空则默认成功
let lastResult = null      // 上一次 git 返回体（断言用）

const gitResult = (code, stdout = '', stderr = '') => ({ exitCode: code, stdout: { text: stdout }, stderr: { text: stderr } })

const fsStub = {
  resolve: async (p) => { calls.resolve.push(p); return p },
  stat: async (p) => (disk.has(p) ? { size: disk.get(p).length } : null),
  readText: async (p) => { calls.readText.push(p); return disk.get(p) || '' },
  writeText: async (p, text) => { calls.writeText.push(p); disk.set(p, text) },
}
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (r) => { routes[r.path] = r.handler; return () => {} } }
    if (name === 'fs') return fsStub
    if (name === 'agents') return { on: () => () => {}, currentInitiator: () => null }
    if (name === 'shell') {
      return {
        resolve: (spec) => spec,
        run: async (spec) => {
          calls.git.push({ command: spec.command, sandbox: spec.sandboxPolicy })
          const next = gitQueue.shift()
          if (next) { lastResult = next; return next }
          lastResult = gitResult(0, GIT_LOG)
          return lastResult
        },
      }
    }
    return undefined
  },
  effect: (fn) => { try { fn() } catch (err) { console.log('  (effect 抛错: ' + err.message + ')') } return () => {} },
  tools: { register: (t) => { tools.push(t); return () => {} } },
  on: () => () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

function fakeReq(reqUrl, method = 'GET', payload = '') {
  const handlers = {}
  const req = { url: reqUrl, method, on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return req } }
  setTimeout(() => {
    if (payload) (handlers.data || []).forEach((f) => f(Buffer.from(payload)))
    ;(handlers.end || []).forEach((f) => f())
  }, 0)
  return req
}

async function call(path, reqUrl, method = 'GET', payload = '') {
  const res = { status: 0, body: '' }
  res.writeHead = (s) => { res.status = s }
  res.end = (b) => { res.body = b }
  await routes[path](fakeReq(reqUrl, method, payload), res)
  let body = null
  try { body = JSON.parse(res.body) } catch (err) { body = null }
  return { status: res.status, body, raw: res.body }
}

const mod = await import(url.pathToFileURL(INDEX).href + '?routes' + Date.now())
await (mod.apply || mod.default.apply)(ctx)

const ROUTES = mod.ROUTES || {}
const gitCommands = () => calls.git.map((c) => c.command.replace(/^git -c core\.quotepath=false -C "[^"]*" /, ''))
const resetGit = () => { calls.git.length = 0; gitQueue = [] }

console.log('— 0. 四条路由都注册上了，且注册顺序/路径与导出的 ROUTES 一致 —')
for (const [key, p] of Object.entries(ROUTES)) ok('ROUTES.' + key + ' = ' + p + ' 已注册', typeof routes[p] === 'function')
ok('恰好四条（多一条少一条都要改这里）', Object.keys(ROUTES).length === 4, String(Object.keys(ROUTES).length))
if (Object.keys(routes).length === 0) { console.log('\n结果：' + pass + ' / ' + (fail + 1)); process.exit(1) }

console.log('\n— 1. log：编码过的 ?vault= 解码正确 —')
calls.git.length = 0
let r = await call('/note-changes/log', '/note-changes/log?vault=E%3A%2Fvault')
ok('HTTP 200', r.status === 200)
ok('ok:true', r.body && r.body.ok === true, JSON.stringify(r.body && r.body.error))
ok('git 命令用的是解码后的路径', calls.git[0] && calls.git[0].command.includes('-C "E:/vault"'),
  String(calls.git[0] && calls.git[0].command).slice(0, 64))
ok('vaultSource 仍是 explicit', r.body && r.body.vaultSource === 'explicit', String(r.body && r.body.vaultSource))

console.log('\n— 2. parseLog 输出形状 —')
const c0 = (r.body && r.body.commits && r.body.commits[0]) || {}
ok('hash 取前 8 位', c0.hash === '01234567', String(c0.hash))
ok('author 已剥掉 <> 邮箱', c0.author === 'Zhang San', String(c0.author))
ok('date 正确', c0.date === '2026-09-23', String(c0.date))
ok('subject 取缩进行', c0.subject === '日记 2026-09-23 要点：瘦身', String(c0.subject))
ok('files 只留 .md', JSON.stringify(c0.files) === JSON.stringify(['00-收件箱/日记/2026-09-23.md', '99-模板/日记模板.md']),
  JSON.stringify(c0.files))

console.log('\n— 3. 非法 % 转义：不 500，且这一档被当无效、退回下一档 —')
process.env.DNC_VAULT = 'D:/nc-test-vault'
resetGit()
r = await call('/note-changes/log', '/note-changes/log?vault=E%3A%2Fva%ZZult')
ok('没炸成 500', r.status === 200, 'status=' + String(r.status))
ok('坏转义没进命令', !calls.git.some((c) => c.command.includes('%ZZ')))
ok('退回 env 那一档', calls.git[0] && calls.git[0].command.includes('-C "D:/nc-test-vault"'), gitCommands()[0])
ok('vaultSource 是 env', r.body && r.body.vaultSource === 'env', String(r.body && r.body.vaultSource))
delete process.env.DNC_VAULT

console.log('\n— 4. note：path 解码 + 只读 vault 内 .md —')
const rel = '00-收件箱/日记/2026-09-23.md'
const enc = '/note-changes/note?vault=E%3A%2Fvault&path=' + encodeURIComponent(rel)
disk.set('E:/vault/' + rel, '# 今日\n\n- 一条要点\n')
calls.readText.length = 0
r = await call('/note-changes/note', enc)
ok('ok:true', r.body && r.body.ok === true, JSON.stringify(r.body && r.body.error))
ok('读的是解码后的相对路径', calls.readText[0] === 'E:/vault/' + rel, String(calls.readText[0]))
ok('正文带回来了', r.body && String(r.body.text).includes('一条要点'))
r = await call('/note-changes/note', '/note-changes/note?vault=E%3A%2Fvault&path=' + encodeURIComponent('../../etc/passwd.md'))
ok('拒绝 .. 越界', r.body && r.body.ok === false && /\.\./.test(String(r.body.error)), String(r.body && r.body.error))
r = await call('/note-changes/note', '/note-changes/note?vault=E%3A%2Fvault&path=' + encodeURIComponent('AGENTS.md'))
ok('拒绝非 .md', r.body && r.body.ok === false, String(r.body && r.body.error))

console.log('\n— 5. settings GET：尾斜杠归一 + 首次没有同步回执 —')
disk.set('E:/vault/00-索引/插件设置.md', SETTINGS_TEXT)
calls.resolve.length = 0
r = await call('/note-changes/settings', '/note-changes/settings?vault=E%3A%2Fvault%2F')
ok('ok:true', r.body && r.body.ok === true, JSON.stringify(r.body && r.body.error))
ok('拼出的路径没有双斜杠', calls.resolve[0] === 'E:/vault/00-索引/插件设置.md', String(calls.resolve[0]))
ok('vaultPath 就是归一化后的 seed.vault', r.body && r.body.vaultPath === 'E:/vault', String(r.body && r.body.vaultPath))
ok('设置读出来了', r.body && r.body.settings && r.body.settings.scanVault === true, JSON.stringify(r.body && r.body.settings))
// 还没写过任何东西 ⇒ 回执必须是 null（而不是 {} 或 "undefined"）：前端据此显示"还没有回执"
ok('lastSync 此刻是 null', r.body && r.body.lastSync === null, JSON.stringify(r.body && r.body.lastSync))

console.log('\n— 6. settings POST：写回读到的 frontmatter —')
calls.writeText.length = 0
r = await call('/note-changes/settings', '/note-changes/settings?vault=E%3A%2Fvault', 'POST',
  JSON.stringify({ patch: { autoWriteOnSessionEnd: false } }))
ok('ok:true', r.body && r.body.ok === true, JSON.stringify(r.body && r.body.error))
ok('只写了那一个设置文件', calls.writeText.length === 1 && calls.writeText[0] === 'E:/vault/00-索引/插件设置.md',
  JSON.stringify(calls.writeText))
ok('wrote 列出改动字段', JSON.stringify(r.body && r.body.wrote) === '["autoWriteOnSessionEnd"]', JSON.stringify(r.body && r.body.wrote))
ok('回执里的 settings 已是新值', r.body && r.body.settings && r.body.settings.autoWriteOnSessionEnd === false,
  JSON.stringify(r.body && r.body.settings))
ok('正文其余部分一字未动', String(disk.get('E:/vault/00-索引/插件设置.md')).includes('# 插件设置'))
ok('POST 回执也带 lastSync 字段', r.body && 'lastSync' in r.body)

console.log('\n— 7. 两条模型工具都注册了，search 只读 —')
const byName = {}
for (const t of tools) byName[t.name] = t
ok('vault_note_append 已注册', typeof (byName.vault_note_append || {}).execute === 'function')
ok('vault_note_search 已注册', typeof (byName.vault_note_search || {}).execute === 'function')
ok('search 的 query 是必填', JSON.stringify((byName.vault_note_search || {}).parameters?.required) === '["query"]',
  JSON.stringify((byName.vault_note_search || {}).parameters?.required))
ok('append 仍然在（没被 search 挤掉）', typeof (byName.vault_note_append || {}).execute === 'function')

console.log('\n— 8. vault_note_search：git grep、无命中、命中计数 —')
const search = byName.vault_note_search
resetGit()
gitQueue = [gitResult(1, '', '')]
let out = await search.execute({ query: '沙箱', vault: 'E:/vault' })
ok('命令是 git grep（只读，不碰工作区）', (gitCommands()[0] || '').startsWith('grep -n -i -e '), gitCommands()[0])
ok('搜的是日记目录', (gitCommands()[0] || '').includes('"00-收件箱/日记"'), gitCommands()[0])
ok('退出码 1 = 无命中，不是故障', /^没找到含/.test(out), out)
resetGit()
gitQueue = [gitResult(0, '00-收件箱/日记/2026-09-23.md:12:沙箱下 git 被拦\n00-收件箱/日记/2026-09-22.md:3:沙箱\n')]
out = await search.execute({ query: '沙箱', vault: 'E:/vault' })
ok('命中数列出来', /^命中 2 行/.test(out), out.split('\n')[0])
ok('带回 文件:行号:内容', out.includes('2026-09-23.md:12:'), out.split('\n')[1])
resetGit()
out = await search.execute({ query: '  ', vault: 'E:/vault' })
ok('空 query 不发命令', calls.git.length === 0 && /^没查/.test(out), out)
resetGit()
gitQueue = [gitResult(0, '00-收件箱/日记/2026-09-23.md:1:a"b`c$d\\e\n')]
out = await search.execute({ query: 'a"b`c$d\\e', vault: 'E:/vault' })
ok('引号/反斜杠被剥掉，命令没被拆坏', (gitCommands()[0] || '').includes('-e "a b c d e"'), gitCommands()[0])
ok('回执用的是用户原词', out.includes('a"b`c$d\\e'), out.split('\n')[0])

console.log('\n— 9. sync 路由：只推不提交，命令序列与沙箱泳道 —')
r = await call('/note-changes/sync', '/note-changes/sync?vault=E%3A%2Fvault')
ok('GET 被拒', r.body && r.body.ok === false, String(r.body && r.body.error))
resetGit()
r = await call('/note-changes/sync', '/note-changes/sync?vault=E%3A%2Fvault', 'POST')
ok('推成功 → ok:true', r.body && r.body.ok === true, JSON.stringify(r.body && r.body.error))
ok('命令只有一条 push（不 add / 不 commit）', JSON.stringify(gitCommands()) === '["push"]', JSON.stringify(gitCommands()))
ok('push 走 network 泳道（danger-full-access）',
  calls.git[0] && calls.git[0].sandbox && calls.git[0].sandbox.mode === 'danger-full-access',
  JSON.stringify(calls.git[0] && calls.git[0].sandbox))
ok('回执说的是「已推送到远端」而不是「已提交并推送」（这条路上一个提交都没建）',
  r.body && r.body.message === '已推送到远端', String(r.body && r.body.message))
ok('回执带 lastSync 且 ok:true', r.body && r.body.lastSync && r.body.lastSync.ok === true, JSON.stringify(r.body && r.body.lastSync))
ok('lastSync.note 是"，"开头的成功句式', r.body && r.body.lastSync && r.body.lastSync.note.charAt(0) === '，',
  String(r.body && r.body.lastSync && r.body.lastSync.note))
ok('lastSync.at 像 ISO 时间', r.body && /^\d{4}-\d{2}-\d{2}T/.test(String(r.body.lastSync.at)), String(r.body && r.body.lastSync.at))

console.log('\n— 10. sync 路由：被拒 → pull --rebase → 重推；rebase 失败要说人话 —')
resetGit()
gitQueue = [
  gitResult(1, '', '! [rejected] main -> main (non-fast-forward)'),
  gitResult(0, '成功 rebase', ''),
  gitResult(0, '', ''),
]
r = await call('/note-changes/sync', '/note-changes/sync?vault=E%3A%2Fvault', 'POST')
ok('命令序列 push / pull --rebase / push', JSON.stringify(gitCommands()) === '["push","pull --rebase","push"]', JSON.stringify(gitCommands()))
ok('三条都在 network 泳道',
  calls.git.every((c) => c.sandbox && c.sandbox.mode === 'danger-full-access'),
  JSON.stringify(calls.git.map((c) => c.sandbox && c.sandbox.mode)))
ok('回执说明先 rebase', r.body && r.body.message === '已推送到远端（先 rebase）', String(r.body && r.body.message))
resetGit()
gitQueue = [gitResult(1, '', '! [rejected] (non-fast-forward)'), gitResult(1, '', 'CONFLICT (content): Merge conflict')]
r = await call('/note-changes/sync', '/note-changes/sync?vault=E%3A%2Fvault', 'POST')
ok('rebase 失败 → ok:false', r.body && r.body.ok === false)
ok('明说需人工处理', r.body && /需人工处理/.test(r.body.message), String(r.body && r.body.message))
ok('没再重推第三次', JSON.stringify(gitCommands()) === '["push","pull --rebase"]', JSON.stringify(gitCommands()))
ok('lastSync.ok 跟失败一致', r.body && r.body.lastSync && r.body.lastSync.ok === false)
ok('lastSync.note 是"（"开头的失败句式', r.body && r.body.lastSync && r.body.lastSync.note.charAt(0) === '（',
  String(r.body && r.body.lastSync && r.body.lastSync.note))

console.log('\n— 11. 回执留得住：settings GET 现在读得到刚才那次同步 —')
resetGit()
r = await call('/note-changes/settings', '/note-changes/settings?vault=E%3A%2Fvault')
ok('settings GET 带回了失败回执', r.body && r.body.lastSync && r.body.lastSync.ok === false, JSON.stringify(r.body && r.body.lastSync))
ok('vault 记在回执里', r.body && r.body.lastSync && r.body.lastSync.vault === 'E:/vault', String(r.body && r.body.lastSync.vault))

console.log('\n— 12. 版本闸门：host / client / package.json 三处必须同号 —')
const hostText = fsMod.readFileSync(INDEX, 'utf8')
const clientText = fsMod.readFileSync(CLIENT, 'utf8')
const pkg = JSON.parse(fsMod.readFileSync(pathMod.join(ROOT, 'package.json'), 'utf8'))
const hostV = (/host up \(v([\d.]+)\)/.exec(hostText) || [])[1]
const clientV = (/client up \(v([\d.]+)\)/.exec(clientText) || [])[1]
ok('host 字面量 = package.json', hostV === pkg.version, 'host=' + String(hostV) + ' pkg=' + String(pkg.version))
ok('client 字面量 = package.json', clientV === pkg.version, 'client=' + String(clientV) + ' pkg=' + String(pkg.version))
ok('client 文件头也标了同一版', clientText.includes('· Client half (v' + String(pkg.version) + ')'),
  String(pkg.version))

console.log('\n— 13. client factory：internals 与 host 的 ROUTES 逐条对齐 —')
const loaded = []
globalThis.window = {
  location: { search: '' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  __ModuleLoader__: { load: (def) => { loaded.push(def) } },
}
globalThis.document = { createElement: () => ({ appendChild: () => {} }), head: { appendChild: () => {} } }
await import(url.pathToFileURL(CLIENT).href + '?client' + Date.now())
const def = loaded[0]
ok('client 半自己声明了 id', def && def.id === 'dsh-note-changes', String(def && def.id))
const exportsStub = def.factory((name) => (name === 'react' ? { createElement: () => null } : null))
const internals = exportsStub.internals || {}
ok('LOG_PATH 对齐 ROUTES.log', internals.LOG_PATH === ROUTES.log, String(internals.LOG_PATH))
ok('NOTE_PATH 对齐 ROUTES.note', internals.NOTE_PATH === ROUTES.note, String(internals.NOTE_PATH))
ok('SETTINGS_PATH 对齐 ROUTES.settings', internals.SETTINGS_PATH === ROUTES.settings, String(internals.SETTINGS_PATH))
ok('SYNC_PATH 对齐 ROUTES.sync', internals.SYNC_PATH === ROUTES.sync, String(internals.SYNC_PATH))
ok('client 用 POST 打 sync', /fetch\(withQuery\(SYNC_PATH\), \{ method: 'POST'/.test(clientText))
// 外部协议链接在这个 GUI 里永远点不动（桌面版 secureWindow 只放行 http/https），
// 所以钉住"别再把 obsidian:// 之类的死链接塞回来"；真要跳转得 Host 半去 shell.openExternal。
ok('client 里没有点不动的外部协议链接', !/href:\s*['"]?(obsidian|vscode|file):/i.test(clientText))
ok('复制路径走 execCommand（有确定返回值，失败能如实显示）', /document\.execCommand\('copy'\)/.test(clientText))

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)