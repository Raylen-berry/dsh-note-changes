// 验「创作要求与偏好」的**采集与写入校验**（v1.13.0）。
//
// 分工：本套件管**存**（字段、硬校验、落盘、同步）；引用行为由 verify-creative-context.mjs 管。
// 两者都要——「能存」不等于「存下来的东西会被正确引用」，反之亦然。
//
// **完全离线 + 隔离库**：落盘在 os.tmpdir 下的临时 vault 里，git 走桩，不碰真实 vault。
const fs = await import('node:fs')
const pathMod = await import('node:path')
const os = await import('node:os')
const url = await import('node:url')
const __dir = pathMod.dirname(url.fileURLToPath(import.meta.url))
const INDEX = process.env.DNC_INDEX || pathMod.resolve(__dir, '../index.js')
const { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } = fs

const { describeNote } = await import(url.pathToFileURL(pathMod.resolve(__dir, '../lib/vault-browser.mjs')).href)
const CTX = await import(url.pathToFileURL(pathMod.resolve(__dir, '../lib/creative-context.mjs')).href)

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

// ───────────────────────────────────────────── 1. 词表与写入硬校验
console.log('— 1. 词表与写入前硬校验 —')
ok('类型词表含「要求/偏好/参考」（库的主体，不只是话术）',
  ['要求', '偏好', '参考'].every((v) => mod.ASSET_TYPES.includes(v)), mod.ASSET_TYPES.join(','))
ok('约束强度三档齐全', mod.ASSET_BINDINGS.join(',') === '必须,优先,参考')
ok('来源三档齐全', mod.ASSET_ORIGINS.join(',') === '用户明说,参考案例,AI推测')
ok('范围种类四档齐全（与解析器同一份词表）',
  CTX.SCOPE_KINDS.join(',') === 'global,project,task_type,task_instance', CTX.SCOPE_KINDS.join(','))
ok('缺省范围是最窄的 task_instance（不自动生效）', mod.DEFAULT_SCOPE_KIND === 'task_instance', mod.DEFAULT_SCOPE_KIND)

ok('什么都不传 → 无冲突', mod.bindingConflict({}) === null)
ok('binding=必须 但来源缺省 → must-needs-user',
  (mod.bindingConflict({ binding: '必须' }) || {}).reason === 'must-needs-user')
ok('binding=必须 + origin=用户明说 但没锚点 → user-needs-source（v1.13.0 新增）',
  (mod.bindingConflict({ binding: '必须', origin: '用户明说' }) || {}).reason === 'user-needs-source')
ok('带上来源锚点就放行',
  mod.bindingConflict({ binding: '必须', origin: '用户明说', source_ref: '用户原话：一律竖屏', scope_kind: 'global' }) === null)
ok('origin=用户明说 缺锚点一律被拒（与 binding 无关）',
  (mod.bindingConflict({ binding: '参考', origin: '用户明说' }) || {}).reason === 'user-needs-source')
ok('scope_kind=project 缺 scope_id → scope-needs-id（v1.13.0 新增）',
  (mod.bindingConflict({ scope_kind: 'project' }) || {}).reason === 'scope-needs-id')
ok('scope_kind=project 带 scope_id 放行', mod.bindingConflict({ scope_kind: 'project', scope_id: '悬疑短剧' }) === null)
ok('scope_kind=global 不需要 scope_id', mod.bindingConflict({ scope_kind: 'global' }) === null)
ok('scope_kind=task_instance 不需要 scope_id（它本来就不自动生效）',
  mod.bindingConflict({ scope_kind: 'task_instance' }) === null)
ok('不认识的 scope_kind 被拒', (mod.bindingConflict({ scope_kind: '随便' }) || {}).reason === 'scope-kind-unknown')
ok('binding=优先 + origin=AI推测 放行（推测可以当参考）',
  mod.bindingConflict({ binding: '优先', origin: 'AI推测' }) === null)

console.log('\n— 2. 状态由依据决定，不由「成功过一次」决定（设计文档 §6.2）—')
ok('用户明说 + 来源锚点 + 范围清楚 ⇒ 当场生效',
  mod.creativeStatus({ origin: '用户明说', source_ref: '原话', scope_kind: 'global' }) === '生效')
ok('AI 推测 ⇒ 草稿', mod.creativeStatus({ origin: 'AI推测', scope_kind: 'global' }) === '草稿')
ok('用户明说但没锚点 ⇒ 草稿', mod.creativeStatus({ origin: '用户明说', scope_kind: 'global' }) === '草稿')
ok('范围没标识 ⇒ 草稿', mod.creativeStatus({ origin: '用户明说', source_ref: '原话', scope_kind: 'task_instance' }) === '草稿')

const id1 = mod.newAssetId(new Date('2026-10-09T10:00:00Z'), 'abcdef1234567890')
ok('记录 id 格式固定（宿主生成，改名后仍可追溯）', /^ca-\d{8}-abcdef12$/.test(id1), id1)
ok('两次生成不同 id', mod.newAssetId(new Date(), null) !== mod.newAssetId(new Date(), null))

// ───────────────────────────────────────────── 3. 文件名与提交信息
console.log('\n— 3. 文件名归一与提交信息 —')
ok('Windows 非法字符换短横（画幅里的冒号不进文件名）',
  mod.assetSlug('成片必须竖屏 9:16') === '成片必须竖屏 9-16', mod.assetSlug('成片必须竖屏 9:16'))
ok('斜杠换成短横，不会造出子目录', mod.assetSlug('a/b') === 'a-b')
ok('开头的点被剥掉（notePath 会拒 . 开头的路径段）', mod.assetSlug('..隐藏') === '隐藏')
ok('纯点号标题归一成空串', mod.assetSlug('...') === '')
ok('过长标题截到 60', mod.assetSlug('x'.repeat(200)).length === 60)
ok('提交信息剔掉引号/反引号/$/反斜杠/换行', !/["`$\\\n\t]/.test(mod.buildAssetMessage('a"b`c$d\\e\nf').slice(4)))

// ───────────────────────────────────────────── 4. 记录文件形状
console.log('\n— 4. buildAssetFile：控制位必须被 describeNote 读出来 —')
const sample = mod.buildAssetFile({
  id: 'ca-20261009-deadbeef', schema_version: 2,
  title: 'a: b # c', type: '要求', binding: '必须', scope_kind: 'project', scope_id: '悬疑短剧',
  origin: '用户明说', source_ref: '用户 2026-10-09 原话', valid_until: '2999-01-01', supersedes: 'ca-old',
  task: '图生视频', model: 'x-1.2', aspect: '9:16', tags: ['交付'], keywords: ['竖屏'],
}, '成片必须竖屏，不许出字幕。', '2026-10-09')
const parsed = describeNote(ASSET_DIR + '/t.md', sample)
ok('标题里的冒号/井号不会截断字段', parsed.properties.title[0] === 'a: b # c')
ok('id 落盘', parsed.properties.id[0] === 'ca-20261009-deadbeef')
ok('schema_version 落盘', parsed.properties.schema_version[0] === '2')
ok('scope_kind / scope_id 落盘',
  parsed.properties.scope_kind[0] === 'project' && parsed.properties.scope_id[0] === '悬疑短剧')
ok('scope 是派生的展示串（不与 kind/id 漂移）', parsed.properties.scope[0] === '项目：悬疑短剧', parsed.properties.scope[0])
ok('source_ref 落盘（可追溯的来源锚点）', parsed.properties.source_ref[0] === '用户 2026-10-09 原话')
ok('valid_until / supersedes 落盘',
  parsed.properties.valid_until[0] === '2999-01-01' && parsed.properties.supersedes[0] === 'ca-old')
ok('status 由依据推出「生效」', parsed.properties.status[0] === '生效', parsed.properties.status[0])
ok('四节标题齐全（内容 / 验收 / 适用与例外 / 使用记录）',
  ['## 内容', '## 验收', '## 适用与例外', '## 使用记录'].every((h) => sample.includes(h)))

const defaults = describeNote('x.md', mod.buildAssetFile({ title: 'T' }, 'p', '2026-10-09'))
ok('scope_kind 缺省 task_instance', defaults.properties.scope_kind[0] === 'task_instance')
ok('status 缺省草稿（没依据就不生效）', defaults.properties.status[0] === '草稿')
ok('binding 缺省参考（最松）', defaults.properties.binding[0] === '参考')
ok('origin 缺省 AI推测（不冒充用户）', defaults.properties.origin[0] === 'AI推测')
ok('不适用的生成参数整体缺席 → 空列表',
  JSON.stringify([defaults.properties.task, defaults.properties.model, defaults.properties.aspect]) === '[[],[],[]]')

{
  const rec = CTX.normalizeRecord(ASSET_DIR + '/t.md', sample)
  ok('解析器读回的记录与写入字段一致（存/用同一口径）',
    rec.id === 'ca-20261009-deadbeef' && rec.scopeKind === 'project' && rec.scopeId === '悬疑短剧'
    && rec.schemaVersion === 2 && rec.sourceRef === '用户 2026-10-09 原话' && rec.status === '生效',
    JSON.stringify({ id: rec.id, k: rec.scopeKind, i: rec.scopeId, v: rec.schemaVersion }))
}

// ───────────────────────────────────────────── 5. 穿过真实 apply()
console.log('\n— 5. 接线：落盘、可筛选、add/commit 指向该条记录 —')
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
        listDir: async (p) => (existsSync(p) ? readdirSync(p).map((name) => ({ name })) : []),
        writeText: async (p, text) => { mkdirSync(pathMod.dirname(p), { recursive: true }); writeFileSync(p, text, 'utf8') },
      }
    }
    if (name === 'shell') {
      return {
        resolve: (spec) => spec,
        run: async (spec) => { commands.push(String(spec.command)); return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } } },
      }
    }
    if (name === 'agents') return { on: () => () => {}, list: async () => [], currentInitiator: () => ({ id: 'session-asset0001' }) }
    return undefined
  },
  effect: (fn) => { try { fn() } catch { /* 路由注册失败不影响本套件 */ } return () => {} },
  tools: { register: (def) => { if (def && def.name) registered[def.name] = def } },
  on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

await (mod.apply || mod.default.apply)(ctx)
const tool = registered['prompt_asset_save']
const resolveTool = registered['creative_context_resolve']
ok('prompt_asset_save 已注册', !!tool && typeof tool.execute === 'function', Object.keys(registered).join(','))
ok('creative_context_resolve 已注册（只读解析入口）', !!resolveTool && typeof resolveTool.execute === 'function')
ok('schema 必填 title + content', JSON.stringify(tool.parameters.required) === '["title","content"]')
ok('scope_kind 的 enum 直接引用词表常量', JSON.stringify(tool.parameters.properties.scope_kind.enum) === JSON.stringify(CTX.SCOPE_KINDS))
ok('agent/pre-step 钩子已挂上', (handlers['agent/pre-step'] || []).length === 1, String((handlers['agent/pre-step'] || []).length))
if (!tool) { console.log('\n结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败'); process.exit(1) }

// 5a. 硬判定
const guard = await tool.execute({ vault: VAULT, title: '占位空壳', content: '（待填：a.jpg 的图片生成提示词。可由「派发到会话」产出后回填。）' })
ok('批次占位文本被拒（不建空壳记录）', /^没存：/.test(guard) && guard.includes('待填'))
ok('被拒时盘上一个字都没写', !existsSync(diskPath(ASSET_DIR + '/占位空壳.md')))
ok('被拒时不发任何 git 命令', commands.length === 0, commands.length + ' 条')

ok('binding=必须 + origin=AI推测 被拒',
  /^没存：/.test(await tool.execute({ vault: VAULT, title: '越权的必须项', content: 'x', binding: '必须', origin: 'AI推测', scope_kind: 'global' })))
ok('origin=用户明说 缺 source_ref 被拒（自报不算来源）',
  /source_ref/.test(await tool.execute({ vault: VAULT, title: '没锚点的', content: 'x', origin: '用户明说', scope_kind: 'global' })))
ok('scope_kind=project 缺 scope_id 被拒',
  /scope_id/.test(await tool.execute({ vault: VAULT, title: '没标识的', content: 'x', scope_kind: 'project' })))
ok('以上三条被拒时都没落盘',
  !existsSync(diskPath(ASSET_DIR + '/越权的必须项.md')) && !existsSync(diskPath(ASSET_DIR + '/没锚点的.md'))
  && !existsSync(diskPath(ASSET_DIR + '/没标识的.md')))

// 5b. 存一条「用户明说的全局必须项」
const T1 = '成片必须竖屏 9:16 且无字幕'
const REL1 = ASSET_DIR + '/' + mod.assetSlug(T1) + '.md'
const at = commands.length
const r1 = await tool.execute({
  vault: VAULT, title: T1, content: '交付成片一律竖屏 9:16，不允许出现字幕。',
  type: '要求', binding: '必须', origin: '用户明说',
  source_ref: '用户 2026-10-09 原话：「成片一律竖屏，不要字幕」',
  scope_kind: 'global', aspect: '9:16', keywords: ['竖屏', '字幕'],
})
ok('回执以「已存」开头', /^已存 /.test(String(r1)), String(r1).slice(0, 30))
ok('回执带提交结果', /，已提交并推送/.test(String(r1)), String(r1).slice(-14))
ok('落盘位置在库目录', existsSync(diskPath(REL1)), REL1)

const saved1 = describeNote(REL1, readFileSync(diskPath(REL1), 'utf8'))
ok('控制位与来源都能被筛选读到',
  saved1.properties.binding[0] === '必须' && saved1.properties.scope_kind[0] === 'global'
  && saved1.properties.origin[0] === '用户明说' && saved1.properties.status[0] === '生效'
  && String(saved1.properties.source_ref[0]).includes('原话'),
  JSON.stringify({ b: saved1.properties.binding, k: saved1.properties.scope_kind, st: saved1.properties.status }))
ok('id 与 schema_version 由宿主生成',
  /^ca-\d{8}-/.test(String(saved1.properties.id[0])) && saved1.properties.schema_version[0] === '2',
  String(saved1.properties.id[0]))
ok('没给 model/engine/duration，属性为空列表（不适用字段真的可选）',
  JSON.stringify([saved1.properties.model, saved1.properties.engine, saved1.properties.duration]) === '[[],[],[]]')

const cmds = commands.slice(at)
ok('发起 rev-parse → add → commit → push 四条',
  cmds.length === 4 && /rev-parse/.test(cmds[0] || '') && / add -- /.test(cmds[1] || '')
  && /commit -m/.test(cmds[2] || '') && / push$/.test(cmds[3] || ''), cmds.length + ' 条')
ok('add 的正是这条记录（不是 -A）', String(cmds[1] || '').includes(REL1) && !/\s-A\b|--all/.test(String(cmds[1] || '')))

// 5c. 存一条 AI 推测的偏好 —— 允许存在，但只能是草稿
const T2 = '运镜偏好稳一点'
const REL2 = ASSET_DIR + '/' + mod.assetSlug(T2) + '.md'
const r2 = await tool.execute({
  vault: VAULT, title: T2, content: '倾向稳定运镜。', type: '偏好', binding: '优先',
  origin: 'AI推测', scope_kind: 'global',
})
ok('推测出来的偏好可以存（不阻塞记录）', /^已存 /.test(String(r2)), String(r2).slice(0, 30))
const saved2 = describeNote(REL2, readFileSync(diskPath(REL2), 'utf8'))
ok('但状态停在草稿（不冒充用户已确认）', saved2.properties.status[0] === '草稿', saved2.properties.status[0])

// 5d. 解析工具跑通真实目录
const resolved = JSON.parse(await resolveTool.execute({ vault: VAULT }))
ok('只读解析：用户明说的全局必须项进了 required',
  resolved.required.some((r) => r.title === T1), JSON.stringify(resolved.required.map((r) => r.title)))
ok('推测的偏好停在草稿：既不进 required 也不自动进 reference',
  !resolved.required.some((r) => r.title === T2) && !resolved.reference.some((r) => r.title === T2)
  && resolved.omitted.some((o) => o.reason === 'status-draft'),
  JSON.stringify(resolved.omitted.map((o) => o.reason)))
{
  const picked = JSON.parse(await resolveTool.execute({ vault: VAULT, explicit: [T2] }))
  ok('被显式选用后才作为参考进来，且仍不成为必须项',
    picked.reference.some((r) => r.title === T2) && !picked.required.some((r) => r.title === T2),
    JSON.stringify(picked.reference.map((r) => r.title)))
}
ok('返回里带 block（可直接读的成稿）', typeof resolved.block === 'string' && resolved.block.includes(T1))
ok('coverage 如实标了扫了几条', resolved.coverage.scanned >= 2, String(resolved.coverage.scanned))

// 5e. 同名不覆盖
const dup = await tool.execute({ vault: VAULT, title: T1, content: '换一版写法' })
ok('同名已存在时拒绝覆盖', /^没存：/.test(dup) && dup.includes('已存在'))
ok('拒绝时旧文件没被改写', readFileSync(diskPath(REL1), 'utf8').includes('不允许出现字幕'))

// ───────────────────────────────────────────── 6. agent/pre-step：按宿主契约驱动钩子本体
console.log('\n— 6. agent/pre-step：按 waterfall 契约驱动钩子本体 —')
const hook = (handlers['agent/pre-step'] || [])[0]
const baseDecision = () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '原始用户消息' }] }] })
/** 按宿主的方式调：先由 next() 给出基础决策，钩子返回的才是真正进入这一步的东西。 */
const fire = (payload = {}, decision) => {
  const base = decision === undefined ? baseDecision() : decision
  return hook(
    { agent: { id: 's1' }, messages: [], turn: 1, step: 1, signal: { aborted: false }, ...payload },
    async () => base,
  )
}
const DECISION_FILE = pathMod.join(ROOT, 'home', 'dsh-note-changes', 'creative-context.json')

{
  const d = await fire()
  ok('库里有生效的全局必须项时，钩子确实往这一步塞了消息',
    d.kind === 'enter' && d.messages.length === 2, JSON.stringify(d.messages.length))
  ok('原始用户消息原样保留，附加的排在它后面',
    d.messages[0].content[0].text === '原始用户消息', JSON.stringify(d.messages[0].content[0].text))
  ok('附加消息是一条 user 消息且标了插件来源',
    d.messages[1].role === 'user' && d.messages[1].source.kind === 'plugin:dsh-note-changes',
    JSON.stringify(d.messages[1].source.kind))
  ok('附加内容里有那条要求', String(d.messages[1].content[0].text).includes(T1))
  ok('附加内容里带优先级规则（本次要求 > 长期记录）',
    String(d.messages[1].content[0].text).includes('用户本次明确说出的要求优先'))
  ok('注入的是**一条**消息，不是把整库倒进去',
    String(d.messages[1].content[0].text).length < 2000, String(d.messages[1].content[0].text).length + ' 字符')
}
{
  const d = await fire({ step: 2 })
  ok('不是第一步就不碰（step !== 1）', d.messages.length === 1)
}
{
  const rejected = { kind: 'reject' }
  const d = await fire({}, rejected)
  ok('基础决策是 reject 时原样返回（不把一步否决改回 enter）', d === rejected)
}
{
  const d = await fire({ signal: { aborted: true } })
  ok('这一轮已取消时不注入', d.messages.length === 1)
}
{
  const settingsPath = pathMod.join(ROOT, 'vault', '00-索引', '插件设置.md')
  mkdirSync(pathMod.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, '---\nvault: ' + JSON.stringify(VAULT) + '\ncreativeContext: off\n---\n\n# 插件设置\n', 'utf8')
  const d = await fire()
  ok('设置里 creativeContext: off ⇒ 不注入（关得掉）', d.messages.length === 1)
  writeFileSync(settingsPath, '---\nvault: ' + JSON.stringify(VAULT) + '\ncreativeContext: auto\n---\n\n# 插件设置\n', 'utf8')
  const back = await fire()
  ok('改回 auto 当场恢复（不用重启）', back.messages.length === 2)
}
{
  process.env.DNC_CREATIVE_CONTEXT = 'off'
  const d = await fire()
  ok('环境变量 DNC_CREATIVE_CONTEXT=off 也能关', d.messages.length === 1)
  delete process.env.DNC_CREATIVE_CONTEXT
}
{
  const EMPTY = ROOT.replace(/\\/g, '/') + '/emptyvault'
  mkdirSync(EMPTY, { recursive: true })
  process.env.DNC_VAULT = EMPTY
  const d = await fire()
  ok('空库时不加空消息（零候选 ⇒ 原样返回）', d.messages.length === 1)
  delete process.env.DNC_VAULT
}
{
  ok('决策记录落到了机器本地', existsSync(DECISION_FILE), DECISION_FILE)
  const rec = JSON.parse(readFileSync(DECISION_FILE, 'utf8'))
  ok('决策记录记的是计数与状态', typeof rec.scanned === 'number' && typeof rec.injected === 'boolean', JSON.stringify(rec))
  ok('决策记录**不含**要求正文（不把库内容复制到库外）',
    !JSON.stringify(rec).includes(T1) && !JSON.stringify(rec).includes('不允许出现字幕'))
}
{
  const realGet = ctx.get
  ctx.get = (n) => { if (n === 'fs') throw new Error('模拟宿主故障'); return realGet(n) }
  let thrown = null
  let d = null
  try { d = await fire() } catch (error) { thrown = error }
  ctx.get = realGet
  ok('宿主服务抛异常时不把故障传染给这一回合（返回原决策、不抛）',
    thrown === null && d && d.messages.length === 1, thrown ? String(thrown.message) : '未抛')
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
