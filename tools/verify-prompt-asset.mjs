// 验"创作要求与偏好库"的采集（v1.12.0）。
//
// 这个库**不是固定话术仓库**：主体是「要什么、什么算达标、什么值得参考」。所以本套件盯三件事：
//   1. 三个控制位 —— binding（绑多紧）/ scope（何时被引用）/ origin（谁说的）——
//      管的是「何时被引用、以多强的约束生效」，而不是内容怎么写
//   2. 两条硬判定：批次占位文本拒收；binding=必须 只许配 origin=用户明说
//   3. 不适用的字段（model/engine/aspect/duration…）可以整体缺席，且不会污染筛选
//
// **完全离线 + 隔离库**：落盘在 os.tmpdir 下的临时 vault 里，git 走桩，不碰真实 vault。
const fs = await import('node:fs')
const pathMod = await import('node:path')
const os = await import('node:os')
const url = await import('node:url')
const __dir = pathMod.dirname(url.fileURLToPath(import.meta.url))
const INDEX = process.env.DNC_INDEX || pathMod.resolve(__dir, '../index.js')
const { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } = fs

const { describeNote } = await import(url.pathToFileURL(pathMod.resolve(__dir, '../lib/vault-browser.mjs')).href)

const ROOT = pathMod.join(os.tmpdir(), 'dsh-nc-prompt-asset')
const VAULT = ROOT.replace(/\\/g, '/') + '/vault'
const ASSET_DIR = '40-提示词'
const diskPath = (rel) => pathMod.join(ROOT, 'vault', rel.replace(/\//g, pathMod.sep))

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(diskPath(ASSET_DIR), { recursive: true })
mkdirSync(pathMod.join(ROOT, 'vault', '00-收件箱', '日记'), { recursive: true })
const HOME = ROOT + '/home'
mkdirSync(pathMod.join(HOME, 'dsh-note-changes'), { recursive: true })
writeFileSync(pathMod.join(HOME, 'dsh-note-changes', 'vault.txt'), VAULT + '\n', 'utf8')
process.env.DSH_HOME = HOME.replace(/\\/g, '/')

const mod = await import(url.pathToFileURL(INDEX).href + '?asset' + Date.now())

// ───────────────────────────────────────────── 1. 词表与控制位
console.log('— 1. 词表与约束强度判定 —')
ok('类型词表含「要求/偏好/参考」（库的主体，不只是话术）',
  ['要求', '偏好', '参考'].every((v) => mod.ASSET_TYPES.includes(v)), mod.ASSET_TYPES.join(','))
ok('类型词表仍有「模板」（固定话术只是其中一类）', mod.ASSET_TYPES.includes('模板'))
ok('约束强度三档齐全', mod.ASSET_BINDINGS.join(',') === '必须,优先,参考', mod.ASSET_BINDINGS.join(','))
ok('来源三档齐全', mod.ASSET_ORIGINS.join(',') === '用户明说,参考案例,AI推测', mod.ASSET_ORIGINS.join(','))
ok('scope 缺省是最窄那一档', mod.DEFAULT_SCOPE === '任务', mod.DEFAULT_SCOPE)

ok('什么都不传 → 无冲突（默认最松：参考 / AI推测）', mod.bindingConflict({}) === null)
ok('binding=必须 但来源缺省（AI推测）→ 冲突', !!mod.bindingConflict({ binding: '必须' }),
  JSON.stringify(mod.bindingConflict({ binding: '必须' })))
ok('binding=必须 + origin=参考案例 → 仍冲突（案例不等于用户明说）',
  !!mod.bindingConflict({ binding: '必须', origin: '参考案例' }))
ok('binding=必须 + origin=用户明说 → 放行',
  mod.bindingConflict({ binding: '必须', origin: '用户明说' }) === null)
ok('binding=优先 + origin=AI推测 → 放行（推测可以当参考，只是不能当必须）',
  mod.bindingConflict({ binding: '优先', origin: 'AI推测' }) === null)
ok('bindingConflict 对 null 不炸', mod.bindingConflict(null) === null)

// ───────────────────────────────────────────── 2. 文件名与提交信息
console.log('\n— 2. 文件名归一与提交信息 —')
ok('正常标题原样保留', mod.assetSlug('成片必须竖屏 9:16') === '成片必须竖屏 9-16', mod.assetSlug('成片必须竖屏 9:16'))
ok('斜杠换成短横，不会造出子目录', mod.assetSlug('a/b') === 'a-b', mod.assetSlug('a/b'))
ok('反斜杠同样被换掉（Windows 路径分隔）', mod.assetSlug('a\\b') === 'a-b', mod.assetSlug('a\\b'))
ok('开头的点被剥掉（notePath 会拒 . 开头的路径段）', mod.assetSlug('..隐藏') === '隐藏', mod.assetSlug('..隐藏'))
ok('纯点号标题归一成空串（调用方据此报错，不硬写文件名）', mod.assetSlug('...') === '', '[' + mod.assetSlug('...') + ']')
ok('过长标题截到 60', mod.assetSlug('x'.repeat(200)).length === 60)
ok('null 不炸', mod.assetSlug(null) === '')

const msg = mod.buildAssetMessage('a"b`c$d\\e\nf\tg')
ok('提交信息剔掉引号/反引号/$/反斜杠/换行（否则切断 shell 引号）',
  !/["`$\\\n\t]/.test(msg.slice(msg.indexOf('：') + 1)), msg)
ok('提交信息标的是提示词资产、带标题', /^提示词资产/.test(mod.buildAssetMessage('稳运镜')), mod.buildAssetMessage('稳运镜'))

// ───────────────────────────────────────────── 3. 记录文件形状
console.log('\n— 3. buildAssetFile：控制位与字段必须被 describeNote 读出来 —')
const sample = mod.buildAssetFile({
  title: 'a: b # c', type: '要求', binding: '必须', scope: '全局', origin: '用户明说',
  task: '图生视频', model: 'x-1.2', engine: 'Grok', aspect: '9:16', duration: '8s',
  source: 'runs/batch-1', tags: ['交付'], keywords: ['竖屏', '字幕'],
}, '成片必须竖屏，不许出字幕。', '2026-10-09')
const parsed = describeNote(ASSET_DIR + '/t.md', sample)
ok('标题里的冒号/井号不会截断字段', parsed.properties.title[0] === 'a: b # c', JSON.stringify(parsed.properties.title))
ok('type 可筛选', parsed.properties.type[0] === '要求', JSON.stringify(parsed.properties.type))
ok('binding 可筛选（这是「绑多紧」的落点）', parsed.properties.binding[0] === '必须', JSON.stringify(parsed.properties.binding))
ok('scope 可筛选（这是「何时被引用」的落点）', parsed.properties.scope[0] === '全局', JSON.stringify(parsed.properties.scope))
ok('origin 可筛选（谁说的）', parsed.properties.origin[0] === '用户明说', JSON.stringify(parsed.properties.origin))
ok('aspect 里的冒号不会被当成新字段', parsed.properties.aspect[0] === '9:16', JSON.stringify(parsed.properties.aspect))
ok('status 默认「草稿」（没实测过不算生效）', parsed.properties.status[0] === '草稿', JSON.stringify(parsed.properties.status))
ok('tags 带默认分类 + 自定义', parsed.properties.tags.join(',') === '创作要求,交付', JSON.stringify(parsed.properties.tags))
ok('keywords 是列表', parsed.properties.keywords.join(',') === '竖屏,字幕', JSON.stringify(parsed.properties.keywords))
ok('H1 用记录名', parsed.title === 'a: b # c', parsed.title)

const defaults = describeNote('x.md', mod.buildAssetFile({ title: 'T' }, 'p', '2026-10-09'))
ok('type 缺省为「要求」', defaults.properties.type[0] === '要求', JSON.stringify(defaults.properties.type))
ok('binding 缺省为「参考」（最松，不默认绑死）', defaults.properties.binding[0] === '参考', JSON.stringify(defaults.properties.binding))
ok('scope 缺省为「任务」（最窄，不默认全局）', defaults.properties.scope[0] === '任务', JSON.stringify(defaults.properties.scope))
ok('origin 缺省为「AI推测」（不默认冒充用户）', defaults.properties.origin[0] === 'AI推测', JSON.stringify(defaults.properties.origin))
ok('不适用的字段整体缺席 → 空列表，不污染筛选',
  JSON.stringify([defaults.properties.task, defaults.properties.model, defaults.properties.engine,
    defaults.properties.aspect, defaults.properties.duration]) === '[[],[],[],[],[]]',
  JSON.stringify([defaults.properties.task, defaults.properties.model, defaults.properties.aspect]))

ok('四节标题齐全（内容 / 验收 / 适用与例外 / 使用记录）',
  ['## 内容', '## 验收', '## 适用与例外', '## 使用记录'].every((h) => sample.includes(h)))
ok('旧的话术专用节名已不再出现', !sample.includes('## 变量') && !sample.includes('## 提示词原文'))

const quoted = describeNote('x.md', mod.buildAssetFile({ title: 'he said "hi"' }, 'p', '2026-10-09'))
ok('标题里的双引号换单引号，frontmatter 没被解析坏', quoted.properties.title[0] === "he said 'hi'", JSON.stringify(quoted.properties.title))

const fenced = mod.buildAssetFile({ title: 'T' }, 'use ```js\ncode\n``` here', '2026-10-09')
ok('正文含 ``` 时围栏加长（否则文件被撑破）', fenced.includes('````text') && fenced.includes('\n````\n'))
ok('body 里那四节没有被 describeNote 当成 frontmatter', describeNote('x.md', fenced).properties.title[0] === 'T')

// ───────────────────────────────────────────── 4. 穿过真实 apply()
console.log('\n— 4. 接线：落盘、可筛选、add/commit 指向该条记录 —')
const registered = {}
const commands = []
const handlers = {}
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: () => () => {} }
    if (name === 'fs') {
      return {
        resolve: async (p) => p,
        stat: async (p) => (existsSync(p) ? { size: readFileSync(p).length, type: 'file', version: 'v1' } : null),
        readText: async (p) => (existsSync(p) ? readFileSync(p, 'utf8') : ''),
        writeText: async (p, text) => {
          mkdirSync(pathMod.dirname(p), { recursive: true })
          writeFileSync(p, text, 'utf8')
        },
      }
    }
    if (name === 'shell') {
      return {
        resolve: (spec) => spec,
        run: async (spec) => {
          commands.push(String(spec.command))
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        },
      }
    }
    if (name === 'agents') {
      return { on: () => () => {}, list: async () => [], currentInitiator: () => ({ id: 'session-asset0001' }) }
    }
    return undefined
  },
  effect: (fn) => { try { fn() } catch { /* 路由注册失败不影响本套件 */ } return () => {} },
  tools: { register: (def) => { if (def && def.name) registered[def.name] = def } },
  on: (name, fn) => { handlers[name] = fn; return () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

await (mod.apply || mod.default.apply)(ctx)
const tool = registered['prompt_asset_save']
ok('prompt_asset_save 已注册', !!tool && typeof tool.execute === 'function', Object.keys(registered).join(','))
ok('schema 是标准 JSON Schema，必填 title + content',
  JSON.stringify(tool && tool.parameters && tool.parameters.required) === '["title","content"]',
  JSON.stringify(tool && tool.parameters && tool.parameters.required))
ok('schema 的 enum 直接引用词表常量（不另写一份字面量，否则必然漂移）',
  JSON.stringify(tool.parameters.properties.type.enum) === JSON.stringify(mod.ASSET_TYPES)
  && JSON.stringify(tool.parameters.properties.binding.enum) === JSON.stringify(mod.ASSET_BINDINGS)
  && JSON.stringify(tool.parameters.properties.origin.enum) === JSON.stringify(mod.ASSET_ORIGINS))
ok('模型/引擎/画幅/时长等不适用的字段都不在 required 里',
  !tool.parameters.required.some((k) => ['model', 'engine', 'aspect', 'duration', 'task'].includes(k)),
  JSON.stringify(tool.parameters.required))
if (!tool) { console.log('\n结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败'); process.exit(1) }

// 4a. 硬判定
const guard = await tool.execute({
  vault: VAULT, title: '占位空壳',
  content: '（待填：a.jpg 的图片生成提示词。可由「派发到会话」产出后回填，或在这里直接写。）',
})
ok('批次占位文本被拒（不建空壳记录）', /^没存：/.test(guard) && guard.includes('待填'), guard.slice(0, 48))
ok('被拒时盘上一个字都没写', !existsSync(diskPath(ASSET_DIR + '/占位空壳.md')))
ok('被拒时不发任何 git 命令', commands.length === 0, commands.length + ' 条')

const overreach = await tool.execute({
  vault: VAULT, title: '越权的必须项', content: '以后所有片子都要加片头。',
  binding: '必须', origin: 'AI推测',
})
ok('binding=必须 配 origin=AI推测 被拒（推测不许变成必须满足的要求）',
  /^没存：/.test(overreach) && overreach.includes('用户明说'), overreach.slice(0, 56))
ok('越权被拒时也不落盘', !existsSync(diskPath(ASSET_DIR + '/越权的必须项.md')))

ok('空 title 被拒', /^没存：title/.test(await tool.execute({ vault: VAULT, content: 'x' })))
ok('空 content 被拒', /^没存：content/.test(await tool.execute({ vault: VAULT, title: 'x' })))
ok('纯点号标题被拒', /^没存：/.test(await tool.execute({ vault: VAULT, title: '...', content: 'x' })))

// 4b. 存一条「必须满足的要求」
const T1 = '成片必须竖屏 9:16 且无字幕'
const REL1 = ASSET_DIR + '/' + mod.assetSlug(T1) + '.md'
const at = commands.length
const r1 = await tool.execute({
  vault: VAULT, title: T1, content: '交付成片一律竖屏 9:16，不允许出现字幕。',
  type: '要求', binding: '必须', scope: '全局', origin: '用户明说',
  aspect: '9:16', keywords: ['竖屏', '字幕'],
})
ok('回执以「已存」开头', /^已存 /.test(String(r1)), String(r1).slice(0, 30))
ok('回执带提交结果', /，已提交并推送/.test(String(r1)), String(r1).slice(-14))
ok('落盘位置在库目录', existsSync(diskPath(REL1)), REL1)

const saved1 = describeNote(REL1, readFileSync(diskPath(REL1), 'utf8'))
ok('控制位与内容都能被筛选读到',
  saved1.properties.binding[0] === '必须' && saved1.properties.scope[0] === '全局'
  && saved1.properties.origin[0] === '用户明说' && saved1.properties.type[0] === '要求',
  JSON.stringify({ b: saved1.properties.binding, s: saved1.properties.scope, o: saved1.properties.origin }))
ok('这条没给 model/engine/duration，属性为空列表（字段可选真的成立）',
  JSON.stringify([saved1.properties.model, saved1.properties.engine, saved1.properties.duration]) === '[[],[],[]]',
  JSON.stringify([saved1.properties.model, saved1.properties.engine, saved1.properties.duration]))

const cmds = commands.slice(at)
ok('发起 rev-parse → add → commit → push 四条',
  cmds.length === 4 && /rev-parse/.test(cmds[0] || '') && / add -- /.test(cmds[1] || '')
  && /commit -m/.test(cmds[2] || '') && / push$/.test(cmds[3] || ''), cmds.length + ' 条')
ok('add 的正是这条记录（不是 -A）',
  String(cmds[1] || '').includes(REL1) && !/\s-A\b|--all/.test(String(cmds[1] || '')), cmds[1] || '(没有这条命令)')

// 4c. 存一条「可调整的偏好」——推测出来的偏好允许存在，只是绑不紧
const T2 = '运镜偏好稳一点'
const REL2 = ASSET_DIR + '/' + mod.assetSlug(T2) + '.md'
const r2 = await tool.execute({
  vault: VAULT, title: T2, content: '倾向稳定运镜；手持晃动只在需要紧张感时用。',
  type: '偏好', binding: '优先', scope: '全局', origin: '用户明说', task: '图生视频',
})
ok('偏好类记录照常收录（库不只有话术）', /^已存 /.test(String(r2)), String(r2).slice(0, 30))
const saved2 = describeNote(REL2, readFileSync(diskPath(REL2), 'utf8'))
ok('偏好没有 model/engine/aspect，仍能按 type+binding 筛出来',
  saved2.properties.type[0] === '偏好' && saved2.properties.binding[0] === '优先'
  && JSON.stringify(saved2.properties.model) === '[]', JSON.stringify(saved2.properties.model))

// 4d. 同名不覆盖
const dup = await tool.execute({ vault: VAULT, title: T1, content: '换一版写法' })
ok('同名已存在时拒绝覆盖（记录优先新建）', /^没存：/.test(dup) && dup.includes('已存在'), String(dup).slice(0, 40))
ok('拒绝时旧文件没被改写', readFileSync(diskPath(REL1), 'utf8').includes('不允许出现字幕'))

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
