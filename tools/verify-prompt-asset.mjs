// 验"成熟提示词进资产库"（v1.11.0）。
//
// 为什么要有这一套：资产靠**属性筛选**被找出来，frontmatter 的每个字段都是一条检索路。
// 让模型每次手写 YAML，漏一个字段就少一条路，而且不报错。本套件把三件事钉死：
//   1. 纯函数：文件名归一（不许造子目录、不许以点开头）、提交信息剔字符、frontmatter 形状
//   2. 占位文本必须被拒 —— 批次刚建时 entries[].prompt 就是「（待填…」，收进去等于建空壳
//   3. 穿过真实 apply()：落盘 + 能被 describeNote 解析出可筛选属性 + add/commit 指向那个资产
//
// 完全离线：git 走桩，不碰真实 vault。
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

// ───────────────────────────────────────────── 1. 纯函数
console.log('— 1. 文件名归一与提交信息 —')
ok('正常标题原样保留', mod.assetSlug('竖屏悬疑开场·稳运镜') === '竖屏悬疑开场·稳运镜', mod.assetSlug('竖屏悬疑开场·稳运镜'))
ok('斜杠换成短横，不会造出子目录', mod.assetSlug('a/b') === 'a-b', mod.assetSlug('a/b'))
ok('反斜杠同样被换掉（Windows 路径分隔）', mod.assetSlug('a\\b') === 'a-b', mod.assetSlug('a\\b'))
ok('Windows 非法字符被换掉', mod.assetSlug('a:b*c?d') === 'a-b-c-d', mod.assetSlug('a:b*c?d'))
ok('开头的点被剥掉（notePath 会拒 . 开头的路径段）', mod.assetSlug('..隐藏') === '隐藏', mod.assetSlug('..隐藏'))
ok('纯点号标题归一成空串（调用方据此报错，不硬写文件名）', mod.assetSlug('...') === '', '[' + mod.assetSlug('...') + ']')
ok('过长标题截到 60', mod.assetSlug('x'.repeat(200)).length === 60, 'len=' + mod.assetSlug('x'.repeat(200)).length)
ok('null 不炸', mod.assetSlug(null) === '')

const msg = mod.buildAssetMessage('a"b`c$d\\e\nf\tg')
ok('提交信息剔掉引号/反引号/$/反斜杠/换行（否则切断 shell 引号）',
  !/["`$\\\n\t]/.test(msg.slice(msg.indexOf('：') + 1)), msg)
ok('提交信息标的是提示词资产、带标题', mod.buildAssetMessage('稳运镜') === '提示词资产：稳运镜', mod.buildAssetMessage('稳运镜'))
ok('提交信息里的标题也被截到 60', mod.buildAssetMessage('x'.repeat(200)).length <= 60 + 8)

// ───────────────────────────────────────────── 2. frontmatter 形状
console.log('\n— 2. buildAssetFile：字段必须被 describeNote 读出来 —')
const sample = mod.buildAssetFile({
  title: 'a: b # c', type: '模板', task: '图生视频', model: 'x-1.2', engine: 'Grok',
  aspect: '9:16', duration: '8s', source: 'runs/batch-1', tags: ['悬疑'], keywords: ['开场', '竖屏'],
}, '一段提示词正文', '2026-10-09')
const parsed = describeNote(ASSET_DIR + '/t.md', sample)
ok('标题里的冒号/井号不会截断字段', parsed.properties.title[0] === 'a: b # c', JSON.stringify(parsed.properties.title))
ok('task 可筛选', parsed.properties.task[0] === '图生视频', JSON.stringify(parsed.properties.task))
ok('aspect 里的冒号不会被当成新字段', parsed.properties.aspect[0] === '9:16', JSON.stringify(parsed.properties.aspect))
ok('status 默认「草稿」（没实测过不算可用）', parsed.properties.status[0] === '草稿', JSON.stringify(parsed.properties.status))
ok('tags 带默认分类 + 自定义', parsed.properties.tags.join(',') === '提示词,悬疑', JSON.stringify(parsed.properties.tags))
ok('keywords 是列表', parsed.properties.keywords.join(',') === '开场,竖屏', JSON.stringify(parsed.properties.keywords))
ok('H1 用资产名', parsed.title === 'a: b # c', parsed.title)
ok('空字段写成裸 key（读成空列表，不是 [""]）', JSON.stringify(parsed.properties.duration) === '["8s"]' && parsed.properties.model[0] === 'x-1.2')

const empty = describeNote('x.md', mod.buildAssetFile({ title: 'T' }, 'p', '2026-10-09'))
ok('没给的字段一律空列表（不会污染筛选）', JSON.stringify(empty.properties.task) === '[]', JSON.stringify(empty.properties.task))
ok('type 缺省为模板', empty.properties.type[0] === '模板', JSON.stringify(empty.properties.type))

const quoted = describeNote('x.md', mod.buildAssetFile({ title: 'he said "hi"' }, 'p', '2026-10-09'))
ok('标题里的双引号换单引号，frontmatter 没被解析坏', quoted.properties.title[0] === "he said 'hi'", JSON.stringify(quoted.properties.title))

const fenced = mod.buildAssetFile({ title: 'T' }, 'use ```js\ncode\n``` here', '2026-10-09')
ok('正文含 ``` 时围栏加长（否则资产文件被撑破）',
  fenced.includes('````text') && fenced.includes('\n````\n'), fenced.split('\n').filter((l) => /^`+/.test(l)).join(' | '))
ok('四节标题齐全', ['## 提示词原文', '## 变量', '## 适用条件', '## 使用记录'].every((h) => fenced.includes(h)))
ok('body 里那四节没有被 describeNote 当成 frontmatter', describeNote('x.md', fenced).properties.title[0] === 'T')

// ───────────────────────────────────────────── 3. 穿过真实 apply()
console.log('\n— 3. 接线：落盘、可筛选、add/commit 指向该资产 —')
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
ok('schema 是标准 JSON Schema（严格 provider 会校验顶层 required）',
  JSON.stringify(tool && tool.parameters && tool.parameters.required) === '["title","prompt"]',
  JSON.stringify(tool && tool.parameters && tool.parameters.required))
if (!tool) { console.log('\n结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败'); process.exit(1) }

// 3a. 占位文本 —— 本工具最值钱的判定
const guard = await tool.execute({
  vault: VAULT, title: '占位空壳',
  prompt: '（待填：a.jpg 的图片生成提示词。可由「派发到会话」产出后回填，或在这里直接写。）',
})
ok('批次占位文本被拒（不建空壳资产）', /^没存：/.test(guard) && guard.includes('待填'), guard.slice(0, 60))
ok('被拒时盘上一个字都没写', !existsSync(diskPath(ASSET_DIR + '/占位空壳.md')))
ok('被拒时不发任何 git 命令', commands.length === 0, commands.length + ' 条')

ok('空 title 被拒', /^没存：title/.test(await tool.execute({ vault: VAULT, prompt: 'x' })))
ok('空 prompt 被拒', /^没存：prompt/.test(await tool.execute({ vault: VAULT, title: 'x' })))
ok('纯点号标题被拒（归一成空串，不硬写文件名）',
  /^没存：/.test(await tool.execute({ vault: VAULT, title: '...', prompt: 'x' })))

// 3b. 正常收录
const TITLE = '竖屏悬疑开场·稳运镜'
const REL = ASSET_DIR + '/' + TITLE + '.md'
const PROMPT = '竖屏开场，雨夜天台，镜头缓推，人物背对镜头，冷调霓虹反射，8 秒内不出字幕。'
const at = commands.length
const reply = await tool.execute({
  vault: VAULT, title: TITLE, prompt: PROMPT,
  task: '图生视频', model: 'x-1.2', engine: 'Grok', aspect: '9:16', duration: '8s',
  source: 'runs/batch-1', tags: ['悬疑'], keywords: ['开场', '竖屏'],
})
ok('回执以「已存」开头', /^已存 /.test(String(reply)), String(reply).slice(0, 32))
ok('回执带提交结果', /，已提交并推送/.test(String(reply)), String(reply).slice(-16))
ok('落盘位置在资产目录', existsSync(diskPath(REL)), REL)
ok('正文原文进得去', existsSync(diskPath(REL)) && readFileSync(diskPath(REL), 'utf8').includes(PROMPT))

const saved = describeNote(REL, readFileSync(diskPath(REL), 'utf8'))
ok('筛选字段真的能读到（这是本工具存在的理由）',
  saved.properties.task[0] === '图生视频' && saved.properties.aspect[0] === '9:16'
  && saved.properties.status[0] === '草稿' && saved.properties.model[0] === 'x-1.2',
  JSON.stringify({ task: saved.properties.task, aspect: saved.properties.aspect, status: saved.properties.status }))

const cmds = commands.slice(at)
ok('发起 rev-parse → add → commit → push 四条',
  cmds.length === 4 && /rev-parse/.test(cmds[0] || '') && / add -- /.test(cmds[1] || '')
  && /commit -m/.test(cmds[2] || '') && / push$/.test(cmds[3] || ''), cmds.length + ' 条')
ok('add 的正是这个资产文件（不是 -A）',
  String(cmds[1] || '').includes(REL) && !/\s-A\b|--all/.test(String(cmds[1] || '')), cmds[1] || '(没有这条命令)')
ok('commit 信息标的是提示词资产', /提示词资产/.test(String(cmds[2] || '')), cmds[2] || '(没有这条命令)')

// 3c. 同名不覆盖
const dup = await tool.execute({ vault: VAULT, title: TITLE, prompt: PROMPT })
ok('同名已存在时拒绝覆盖（资产优先新建）', /^没存：/.test(dup) && dup.includes('已存在'), String(dup).slice(0, 48))
ok('拒绝时旧文件内容没被改写',
  readFileSync(diskPath(REL), 'utf8').includes('x-1.2'))

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
