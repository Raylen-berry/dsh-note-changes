// ============================================================================
// dsh-note-changes · Host half (v1.1.0)
// ============================================================================
// 只读地读取一个 Obsidian vault 的 git 历史，返回「每次提交改动了哪些 .md」。
//
// 设计原则（重要）：
//   本插件**绝不写入** vault。它只跑 `git log`，不改文件、不提交、不推送。
//   让 AI 有写权限是另一件事（见 vault 里的 AGENTS.md），不在这里做。
//
// 路由：
//   GET /note-changes/log?vault=<绝对路径>  ->  { ok, vault, commits[] }
//   git 失败时也返回 HTTP 200 + { ok:false, error }，让前端把原因显示出来，
//   而不是把它当成网络错误（这是从动态原型踩出来的坑：静默失败最难查）。
//
// git 依赖提醒：
//   若 vault 目录属主不是当前用户，git 会报 "dubious ownership"。
//   修法：git config --global --add safe.directory <vault 路径>
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'

export const name = 'dsh-note-changes'

// Cordis 的服务是异步出现的。不声明 inject，apply 会在 webServer 就绪之前
// 就跑完，ctx.get('webServer') 拿到 undefined，然后提前 return —— 路由永远
// 注册不上，前端表现为「响应体为空 → Unexpected end of JSON input」。
// v1.0.0 漏了这两行（v1.1.0 修）。
// 诊断依据：harness.log 里的 `[dsh-note-changes] webServer 服务不存在，路由无法注册`。
export const inject = ['webServer', 'shell', 'tools']

/** 默认 vault 路径；可以通过路由的 ?vault= 覆盖。 */
const DEFAULT_VAULT = 'E:/vault'

/** 本插件唯一的路由。 */
const LOG_PATH = '/note-changes/log'

/** 读单篇笔记正文的路由（供抽屉下方「相关笔记」用）。 */
const NOTE_PATH = '/note-changes/note'

/** 单篇笔记返回的字符上限，防止把超大文件塞进响应。 */
const MAX_NOTE_CHARS = 60000

/** 插件设置：读写 vault 里这个文件的 frontmatter。 */
const SETTINGS_PATH = '/note-changes/settings'
const SETTINGS_REL = '00-索引/插件设置.md'

/** 设置默认值（设置文件不存在或缺键时用）。 */
const DEFAULT_SETTINGS = {
  vault: DEFAULT_VAULT,
  scanVault: true,
  autoWriteOnSessionEnd: true,
}

// ---- 机器本地引导（v1.5.0）-------------------------------------------------
// 为什么非要有这一段：`vault:` 这个键存在 vault 里，而「读 vault 里那个键」必须
// 先知道 vault 在哪。换到新机器上 DEFAULT_VAULT 指向一个不存在的路径 ⇒ 名片寄丢
// 了没人看，「设置随 git 迁移」在这一环是死循环：抽屉空白，AI 侧的写入选路
// （vault_note_append / idle 兜底）同样读不到设置，只能靠调用时显式传 vault。
// 解法是给一条**不依赖 vault** 的引导：环境变量 DNC_VAULT，或指针文件
//   $DSH_HOME/dsh-note-changes/vault.txt（本机几十字节，不进 git）。
// 优先级（越靠前越大）。机器本地三档**压过** vault 里的 git 值，否则换机又被上一台盖回去：
//   1 explicit（?vault= / args.vault） 2 env（DNC_VAULT） 3 pointer（指针文件）
//   4 vaultFile（vault 里的 vault:）   5 default（DEFAULT_VAULT）
const ENV_VAULT_KEY = 'DNC_VAULT'
const POINTER_REL = 'dsh-note-changes/vault.txt'

/** 归一化 vault 路径：反斜杠→正斜杠、去尾斜杠；不是绝对路径返回空串（视为无效）。 */
export function normalizeVaultPath(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/')
  s = s.replace(/\/+$/, '')
  if (s.length === 0) return ''
  if (/^[A-Za-z]:\/.+/.test(s)) return s // Windows 盘符绝对路径
  if (s.indexOf('/') === 0 && s.length > 1) return s // POSIX 绝对路径
  return '' // 相对路径一律不收：它跟着 cwd 走，会指到别的库
}

/** 指针文件内容：第一条非注释非空的行 = 路径，其余忽略。坏内容 ⇒ 空串（当没写过）。 */
export function parsePointerFile(text) {
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.length === 0 || t.charAt(0) === '#') continue
    return normalizeVaultPath(t)
  }
  return ''
}

/** 纯函数版优先级裁决 —— 不碰 IO，所以能在离线夹具里逐档验。 */
export function pickVaultSeed(sources) {
  const src = sources || {}
  const ladder = [
    ['explicit', src.explicit],
    ['env', src.env],
    ['pointer', src.pointer],
    ['vaultFile', src.vaultFile],
    ['default', src.fallback],
  ]
  for (let i = 0; i < ladder.length; i++) {
    const normalized = normalizeVaultPath(ladder[i][1])
    if (normalized.length > 0) return { vault: normalized, source: ladder[i][0] }
  }
  return { vault: '', source: 'none' }
}

/** $DSH_HOME，退到 %APPDATA%/dsh-desktop/harness（与宿主其它插件同口径）。 */
export function guessDshHome(env) {
  const e = env || {}
  const direct = normalizePath(String(e.DSH_HOME || ''))
  if (direct.length > 0) return direct
  const appdata = normalizePath(String(e.APPDATA || ''))
  return appdata.length > 0 ? appdata + '/dsh-desktop/harness' : ''

  function normalizePath(value) {
    return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  }
}

/** 只认 frontmatter 里的单行 `key: value`；不引入 YAML 库，行为完全可控。 */
export function parseFrontmatter(text) {
  const lines = String(text || '').split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return {}
  const out = {}
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    let value = m[2].trim()
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    out[m[1]] = value
  }
  return out
}

/** 把 frontmatter 里的字符串值转成设置类型。 */
function coerceSetting(key, raw) {
  if (key === 'scanVault' || key === 'autoWriteOnSessionEnd') {
    return raw === true || raw === 'true' || raw === '1' || raw === 'yes'
  }
  return String(raw == null ? '' : raw)
}

/** 把解析结果补齐成完整设置。 */
export function resolveSettings(parsed) {
  const src = parsed || {}
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k)
  const vault = typeof src.vault === 'string' && src.vault.trim().length > 0
    ? src.vault.trim()
    : DEFAULT_SETTINGS.vault
  return {
    vault,
    scanVault: has('scanVault') ? coerceSetting('scanVault', src.scanVault) : DEFAULT_SETTINGS.scanVault,
    autoWriteOnSessionEnd: has('autoWriteOnSessionEnd')
      ? coerceSetting('autoWriteOnSessionEnd', src.autoWriteOnSessionEnd)
      : DEFAULT_SETTINGS.autoWriteOnSessionEnd,
  }
}

/**
 * **只改指定的 key**，文件其余部分一字不动。
 * 有该 key → 替换那一行；没有 → 在 frontmatter 末尾（第二个 --- 之前）插入。
 * 整个文件没有 frontmatter → 补一个。
 */
export function patchFrontmatter(text, patch) {
  const raw = String(text || '')
  const lines = raw.split(/\r?\n/)
  const keys = Object.keys(patch || {})
  if (keys.length === 0) return raw

  if (lines.length === 0 || lines[0].trim() !== '---') {
    const head = ['---']
    for (const k of keys) head.push(k + ': ' + String(patch[k]))
    head.push('---', '')
    return head.concat(lines).join('\n')
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end < 0) {
    const tail = []
    for (const k of keys) tail.push(k + ': ' + String(patch[k]))
    tail.push('---', '')
    return lines.concat(tail).join('\n')
  }

  const remaining = {}
  for (const k of keys) remaining[k] = String(patch[k])

  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(lines[i])
    if (!m) continue
    if (Object.prototype.hasOwnProperty.call(remaining, m[1])) {
      lines[i] = m[1] + ': ' + remaining[m[1]]
      delete remaining[m[1]]
    }
  }

  const missing = Object.keys(remaining)
  if (missing.length > 0) {
    lines.splice(end, 0, ...missing.map((k) => k + ': ' + remaining[k]))
  }

  return lines.join('\n')
}

/** 读请求体（POST 用）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 一次最多返回多少条提交。 */
const MAX_COMMITS = 80

/** 返回 JSON 并结束响应。 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 解析 `git log --date=short --name-only` 的默认 medium 格式输出。
 *
 * 故意不用 `--pretty=format:`：格式串里的 `%H`/`%an` 在 cmd.exe 下会被
 * 当成环境变量展开（`%x1f%` 这种更是直接坏掉），而默认格式不需要任何 %。
 *
 * 结构：
 *   commit <sha>
 *   Author: 名字 <邮箱>
 *   Date:   2026-09-13
 *
 *       <提交标题，缩进 4 空格>
 *
 *   <文件路径，顶格>
 */
export function parseLog(text) {
  const raw = String(text || '')
  const blocks = raw.split(/\n(?=commit [0-9a-f]{7,})/)
  const out = []

  for (const block of blocks) {
    const head = block.match(/^commit ([0-9a-f]+)/)
    if (!head) continue

    const authorLine = block.match(/^Author:\s*(.*)$/m)
    const emailMatch = block.match(/^Author:.*<([^>]*)>/m)
    const dateMatch = block.match(/^Date:\s*(.*)$/m)

    const lines = block.split('\n')
    let dateIndex = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^Date:/.test(lines[i])) { dateIndex = i; break }
    }

    // 缩进 >= 2 空格的非空行 = 提交标题/正文；顶格非空行 = 文件路径。
    const subjectLines = []
    const files = []
    for (let i = dateIndex + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^[ \t]{2,}\S/.test(line)) subjectLines.push(line.trim())
      else if (/^\S/.test(line)) files.push(line.trim())
    }

    const md = []
    for (const file of files) {
      if (/\.md$/i.test(file)) md.push(file)
    }

    out.push({
      hash: head[1].slice(0, 8),
      author: authorLine ? String(authorLine[1]).replace(/<[^>]*>\s*$/, '').trim() : '',
      email: emailMatch ? emailMatch[1] : '',
      date: dateMatch ? String(dateMatch[1]).trim() : '',
      subject: subjectLines.length > 0 ? subjectLines[0] : '(无标题)',
      files: md,
    })
  }

  return out
}

// ---------------------------------------------------------------- 当日记录

/** 当日记录目录（vault 内相对路径）。 */
const DAILY_DIR = '00-收件箱/日记'

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地日期 YYYY-MM-DD。 */
export function localDate(now) {
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
}

/** 本地时间 HH:MM。 */
export function localTime(now) {
  return pad2(now.getHours()) + ':' + pad2(now.getMinutes())
}

/** 新建当日记录时的骨架（沿用 99-模板/日记模板.md 的形状）。 */
export function dailySeed(date) {
  return [
    '---',
    'title: ' + date,
    'created: ' + date,
    'updated: ' + date,
    'tags:',
    '  - 日记',
    'status: 收件箱',
    '---',
    '',
    '# ' + date,
    '',
  ].join('\n')
}

/**
 * 把一段要点**追加**到当日记录末尾。
 * 只追加、不动已有内容 —— 这是这个功能唯一安全的形态。
 */
export function appendEntry(existing, entry) {
  const base = String(existing == null ? '' : existing)
  const body = base.length === 0 ? '' : (base.endsWith('\n') ? base : base + '\n')
  return body + entry
}

/** 把要点列表拼成一段 markdown 记录。 */
export function buildEntry(now, title, points) {
  const t = (title == null ? '' : String(title)).trim()
  const head = '## ' + localTime(now) + (t.length > 0 ? ' ' + t : '')
  const lines = points.map((p) => '- ' + String(p).trim())
  return '\n' + head + '\n\n' + lines.join('\n') + '\n'
}

// ------------------------------------------------- 事件兜底（AI 忘了写时的保险）

/**
 * 兜底存根该不该写（纯函数，便于离线单测）。
 * 三个条件同时成立才写：① 这一轮确实进过 running（做过事）；
 * ② 这一轮 AI 没写过要点；③ 这个会话今天还没写过存根（防止刷屏）。
 */
export function decideStub(input) {
  const turn = input == null ? null : input.turnStartedAt
  if (turn == null) return { write: false, reason: '这一轮没有 running 记录（没做过事）' }
  const wrote = input.lastRealWriteAt
  if (wrote != null && wrote >= turn) return { write: false, reason: '这一轮 AI 已经写过要点' }
  if (input.stubDay != null && input.stubDay === input.todayDay) {
    return { write: false, reason: '这个会话今天已经写过兜底存根' }
  }
  return { write: true, reason: '这一轮做过事但没写要点' }
}

/** 会话 id 取前 8 位，够人认。 */
export function shortSession(id) {
  // DSH 的会话 id 一律形如 `session-<uuid>`：直接取前 8 位会得到毫无信息量的 "session-"
  // （v1.4.1 实测：兜底存根那行认不出是哪个会话）。先剥掉固定前缀再截。
  const s = String(id == null ? '' : id).replace(/^session[-_]/, '')
  return s.length > 8 ? s.slice(0, 8) : s
}

/** 兜底存根：明确标注「自动记录 · 待补充」，并且只追加。 */
export function buildStubEntry(now, sessionId) {
  return '\n## ' + localTime(now) + '（自动记录 · 待补充）\n\n'
    + '- 这个会话这一轮有工作，但没写入要点（DSH 兜底）。会话 ' + shortSession(sessionId) + '\n'
}

/**
 * 注册日志路由。webServer 不存在就只记一条错误，不抛异常
 * （抛了会让整个 profile 的 compose 失败，代价太大）。
 */
export async function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-note-changes] webServer 服务不存在，路由无法注册')
    return
  }

  // ---- 事件兜底用的状态 ----
  // idle 之后等这么久还没动静，才认为"这一段工作结束了"（否则每轮都写）
  const STUB_DELAY_MS = 3 * 60 * 1000
  const stubState = { turnStart: {}, lastRealWrite: {}, stubDay: {} }
  const stubTimers = {}

  /** 读 vault 里的设置文件；读不到返回 null。 */
  async function readSettingsFor(vault, fsService) {
    try {
      const target = await fsService.resolve(vault + '/' + SETTINGS_REL)
      const info = await fsService.stat(target)
      if (!info) return null
      const text = String(await fsService.readText(target) || '')
      return resolveSettings(parseFrontmatter(text))
    } catch (error) {
      return null
    }
  }

  /**
   * 指针文件属于宿主自己的目录（不在 vault 里），所以直读 node:fs ——
   * 走 fsService 反而要为一个几十字节的小文件放一条跨边界白名单。
   * 读失败 / 不存在 / 内容非法一律返回空串：它只是引导，不该让任何一条路挂掉。
   */
  function readPointerValue() {
    try {
      const home = guessDshHome(process.env)
      if (home.length === 0) return ''
      const file = home + '/' + POINTER_REL
      if (!existsSync(file)) return ''
      return parsePointerFile(readFileSync(file, 'utf8'))
    } catch (error) {
      return ''
    }
  }

  /**
   * 这一次请求 / 这一条写入该用哪个 vault，并说明依据（source 回给前端显示）。
   * 只有落到 DEFAULT_VAULT 时才去采纳 vault 里的 `vault:` —— 机器本地三档已经
   * 表过态，不能再被 git 同步过来的上一台机器的路径盖回去。
   */
  async function resolveVault(explicit, fsService) {
    let picked = pickVaultSeed({
      explicit,
      env: process.env[ENV_VAULT_KEY],
      pointer: readPointerValue(),
      fallback: DEFAULT_VAULT,
    })
    if (picked.source === 'default' && fsService) {
      const settings = await readSettingsFor(picked.vault, fsService)
      const fromFile = settings ? normalizeVaultPath(settings.vault) : ''
      if (fromFile.length > 0) picked = { vault: fromFile, source: 'vaultFile' }
    }
    return picked
  }

  /** 兜底：这一轮做过事但 AI 没写要点时，补一条「待补充」存根。 */
  async function writeStubIfNeeded(sessionId) {
    try {
      const fsService = ctx.get('fs')
      if (fsService === undefined) return

      const seed = await resolveVault('', fsService)
      const vault = seed.vault
      const settings = await readSettingsFor(vault, fsService)
      if (settings && settings.autoWriteOnSessionEnd === false) return

      const now = new Date()
      const today = localDate(now)
      const decision = decideStub({
        turnStartedAt: stubState.turnStart[sessionId] != null ? stubState.turnStart[sessionId] : null,
        lastRealWriteAt: stubState.lastRealWrite[sessionId] != null ? stubState.lastRealWrite[sessionId] : null,
        stubDay: stubState.stubDay[sessionId] != null ? stubState.stubDay[sessionId] : null,
        todayDay: today,
      })
      if (!decision.write) {
        console.log('[dsh-note-changes] 兜底跳过（' + decision.reason + '）')
        return
      }

      const rel = DAILY_DIR + '/' + today + '.md'
      const target = await fsService.resolve(vault + '/' + rel)
      const info = await fsService.stat(target)
      const before = info ? String(await fsService.readText(target) || '') : ''
      const base = before.length > 0 ? before : dailySeed(today)
      await fsService.writeText(
        target,
        appendEntry(base, buildStubEntry(now, sessionId)),
        undefined,
        undefined,
        { mode: 'workspace-write', workspaceRoot: vault },
      )
      stubState.stubDay[sessionId] = today
      console.log('[dsh-note-changes] 已写兜底存根（' + decision.reason + '）')
    } catch (error) {
      console.error('[dsh-note-changes] 兜底写入失败：'
        + ((error && error.message) ? error.message : String(error)))
    }
  }

  // ---- 监听会话状态：转为 idle 后防抖，到点再看要不要补存根 ----
  // 只监听 agent/status（payload 只有 { agent:{id}, status }，拿不到会话标题）。
  ctx.effect(() => {
    const off = ctx.on('agent/status', (payload) => {
      try {
        const agent = payload && payload.agent
        const sid = agent && agent.id ? String(agent.id) : ''
        const status = payload && payload.status
        if (sid.length === 0) return

        if (status === 'running') {
          stubState.turnStart[sid] = Date.now()
          if (stubTimers[sid]) { clearTimeout(stubTimers[sid]); delete stubTimers[sid] }
          return
        }
        if (status !== 'idle') return

        if (stubTimers[sid]) clearTimeout(stubTimers[sid])
        stubTimers[sid] = setTimeout(() => {
          delete stubTimers[sid]
          void writeStubIfNeeded(sid)
        }, STUB_DELAY_MS)
      } catch (error) {
        console.error('[dsh-note-changes] status 处理失败：'
          + ((error && error.message) ? error.message : String(error)))
      }
    })
    return () => {
      if (typeof off === 'function') off()
      for (const k of Object.keys(stubTimers)) { clearTimeout(stubTimers[k]); delete stubTimers[k] }
    }
  }, 'dsh-note-changes: idle stub listener')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: LOG_PATH,
    handler: async (req, res) => {
      try {
        const url = String(req.url || '')
        const raw = (url.match(/[?&]vault=([^&]*)/) || [])[1] || ''
        let asked = raw
        try { asked = decodeURIComponent(raw) } catch (err) { asked = raw }
        const seed = await resolveVault(asked, ctx.get('fs'))
        const vault = seed.vault

        const shell = ctx.get('shell')
        if (shell === undefined) {
          sendJson(res, 200, {
            ok: false,
            vault,
            error: 'Host 未提供 shell 服务，无法执行 git。',
          })
          return
        }

        const command = 'git -c core.quotepath=false -C "' + vault + '" log -n '
          + String(MAX_COMMITS) + ' --date=short --name-only'

        let result
        try {
          const spec = shell.resolve({
            command,
            workdir: vault,
            timeoutMs: 20000,
            stdoutMaxBytes: 600000,
          })
          result = await shell.run(spec)
        } catch (error) {
          const message = (error && error.message) ? error.message : String(error)
          sendJson(res, 200, { ok: false, vault, vaultSource: seed.source, error: '执行 git 失败：' + message })
          return
        }

        const stdout = result && result.stdout ? String(result.stdout.text || '') : ''
        const stderr = result && result.stderr ? String(result.stderr.text || '') : ''
        const code = result ? result.exitCode : null

        if (code !== 0) {
          const detail = (stderr || stdout || ('git 退出码 ' + String(code))).trim()
          sendJson(res, 200, { ok: false, vault, vaultSource: seed.source, error: detail.slice(0, 800) })
          return
        }

        sendJson(res, 200, { ok: true, vault, vaultSource: seed.source, commits: parseLog(stdout) })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-note-changes: log route')

  // 读一篇笔记的正文，给抽屉下方「相关笔记」用。
  // 只读、且严格限制在 vault 内的 .md：拒绝 .. 越界、拒绝非 md、截断超长文件。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: NOTE_PATH,
    handler: async (req, res) => {
      try {
        const url = String(req.url || '')
        const rawVault = (url.match(/[?&]vault=([^&]*)/) || [])[1] || ''
        const rawPath = (url.match(/[?&]path=([^&]*)/) || [])[1] || ''
        let askedVault = rawVault
        let askedPath = rawPath
        try { askedVault = decodeURIComponent(rawVault) } catch (err) { askedVault = rawVault }
        try { askedPath = decodeURIComponent(rawPath) } catch (err) { askedPath = rawPath }

        const seed = await resolveVault(askedVault, ctx.get('fs'))
        const vault = seed.vault
        const relative = askedPath.replace(/\\/g, '/').replace(/^\/+/, '').trim()

        if (relative.length === 0) {
          sendJson(res, 200, { ok: false, error: '缺少 path 参数' })
          return
        }
        if (relative.split('/').indexOf('..') >= 0) {
          sendJson(res, 200, { ok: false, error: '路径不允许包含 ..' })
          return
        }
        if (!/\.md$/i.test(relative)) {
          sendJson(res, 200, { ok: false, error: '只读取 .md 文件' })
          return
        }

        const fsService = ctx.get('fs')
        if (fsService === undefined) {
          sendJson(res, 200, { ok: false, error: 'Host 未提供 fs 服务，无法读取笔记正文。' })
          return
        }

        const base = vault.replace(/\/+$/, '')
        const target = await fsService.resolve(base + '/' + relative)
        const info = await fsService.stat(target)
        if (!info) {
          sendJson(res, 200, { ok: false, error: '文件不存在：' + relative })
          return
        }

        const raw = String(await fsService.readText(target) || '')
        const text = raw.slice(0, MAX_NOTE_CHARS)
        sendJson(res, 200, {
          ok: true,
          path: relative,
          text,
          truncated: text.length < raw.length,
        })
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-note-changes: note route')

  // 插件设置：GET 读、POST 写。设置存在 vault 的 00-索引/插件设置.md 里 ⇒ 随 git 迁移，
  // 换机器不用重填。写入只改指定 key，文件其余部分一字不动。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (req, res) => {
      try {
        const url = String(req.url || '')
        const rawVault = (url.match(/[?&]vault=([^&]*)/) || [])[1] || ''
        let asked = rawVault
        try { asked = decodeURIComponent(rawVault) } catch (err) { asked = rawVault }
        const fsService = ctx.get('fs')
        if (fsService === undefined) {
          sendJson(res, 200, { ok: false, error: 'Host 未提供 fs 服务', settings: DEFAULT_SETTINGS })
          return
        }
        const seed = await resolveVault(asked, fsService)
        const base = seed.vault

        const target = await fsService.resolve(base.replace(/\/+$/, '') + '/' + SETTINGS_REL)

        // ---- 读 ----
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          const info = await fsService.stat(target)
          if (!info) {
            sendJson(res, 200, { ok: true, exists: false, source: SETTINGS_REL, vaultSource: seed.source, vaultPath: base, settings: DEFAULT_SETTINGS })
            return
          }
          const text = String(await fsService.readText(target) || '')
          sendJson(res, 200, {
            ok: true,
            exists: true,
            source: SETTINGS_REL,
            vaultSource: seed.source,
            vaultPath: base,
            settings: resolveSettings(parseFrontmatter(text)),
          })
          return
        }

        // ---- 写 ----
        let payload = {}
        try { payload = JSON.parse((await readBody(req)) || '{}') } catch (err) { payload = {} }
        const patch = {}
        if (payload && payload.patch && typeof payload.patch === 'object') {
          if (typeof payload.patch.vault === 'string' && payload.patch.vault.trim().length > 0) {
            patch.vault = payload.patch.vault.trim()
          }
          if (typeof payload.patch.scanVault === 'boolean') patch.scanVault = payload.patch.scanVault
          if (typeof payload.patch.autoWriteOnSessionEnd === 'boolean') {
            patch.autoWriteOnSessionEnd = payload.patch.autoWriteOnSessionEnd
          }
        }
        if (Object.keys(patch).length === 0) {
          sendJson(res, 200, { ok: false, error: '没有可写入的字段', settings: DEFAULT_SETTINGS })
          return
        }

        const info = await fsService.stat(target)
        const before = info ? String(await fsService.readText(target) || '') : ''
        const after = patchFrontmatter(before, patch)

        // vault 在工作区之外，默认策略会拒绝（实测报
        // 'file access denied under workspace-write mode'）。这里把沙箱范围显式收到
        // vault 目录本身 —— 最窄的可用策略：只放行这个 vault，别处照旧受限。
        await fsService.writeText(target, after, undefined, undefined, {
          mode: 'workspace-write',
          workspaceRoot: base.replace(/\/+$/, ''),
        })

        sendJson(res, 200, {
          ok: true,
          source: SETTINGS_REL,
          vaultSource: seed.source,
          vaultPath: base,
          wrote: Object.keys(patch),
          settings: resolveSettings(parseFrontmatter(after)),
        })
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-note-changes: settings route')

  // ---- 模型工具：把本次会话的关键点追加进当日记录 ----
  // 为什么是「工具 + 规则」而不是「事件监听器自动写」：
  // 判定"什么是这次的要点"，正是**干活的 AI 最擅长、而盲监听器最不擅长**的部分。
  // 监听 agent/status→idle 只能写流水账，而且每轮都触发。详见 vault 里的讨论。
  ctx.effect(() => ctx.tools.register({
    name: 'vault_note_append',
    description: '把本次会话的关键点追加进 vault 的当日记录（00-收件箱/日记/<日期>.md）。'
      + '只追加、绝不改动已有内容。收工前调用一次。'
      + '要点要具体——做了什么、结论是什么、踩了什么坑、怎么解决的；'
      + '不要写"完成了任务"这类空话，那种写进去没人会看。',
    // ⚠️ parameters 必须是**标准 JSON Schema**：{type:'object', properties, required:[...]}。
    // DSH 原生工具与 browser-live 工厂的输出都是这个形状（对照 Tool.listTools）。
    // 之前用扁平 map + 属性内 required:true —— Qwen 端点宽容照收，
    // DeepSeek 严格校验直接 400 "Invalid schema for function"；而 tools 数组挂在
    // **每个**请求上 ⇒ 严格 provider 下所有会话全灭（2026-09-13 事故根因）。
    parameters: {
      type: 'object',
      properties: {
        points: { type: 'array', items: { type: 'string' }, description: '要点列表，每条一行' },
        title: { type: 'string', description: '可选，这次工作的短标题（会作为二级标题）' },
        vault: { type: 'string', description: '可选，vault 绝对路径；不填则用设置文件里的值' },
      },
      required: ['points'],
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
    },
    async execute(args) {
      const points = Array.isArray(args && args.points)
        ? args.points.map((p) => String(p).trim()).filter((p) => p.length > 0)
        : []
      if (points.length === 0) return '没写：points 为空，至少给一条要点。'

      const fsService = ctx.get('fs')
      if (fsService === undefined) return '没写：Host 未提供 fs 服务。'

      // v1.5.0：和路由走同一把梯子（显式 > 环境变量 > 指针文件 > vault 里的值 > 默认）。
      // 改这里的原因：旧写法只认 DEFAULT_VAULT 下面那份设置，新机器上它不存在 ⇒
      // 这条写入选路是死的，只能靠调用方每次显式传 vault。
      const seed = await resolveVault(typeof args.vault === 'string' ? args.vault : '', fsService)
      const vault = seed.vault
      if (vault.length === 0) {
        return '没写：解析不出 vault 路径 —— 显式参数、' + ENV_VAULT_KEY + '、指针文件、默认值都是空的。'
      }

      // 设置文件仍然权威：它说开关关着就不写（机器本地三档压过它指定的路径，但管开关仍归它）
      const settings = await readSettingsFor(vault, fsService)
      if (settings && settings.autoWriteOnSessionEnd === false) {
        return '没写：设置里 autoWriteOnSessionEnd 是关的（' + SETTINGS_REL
          + '，vault 取自 ' + seed.source + '）。要写就把它打开。'
      }

      try {
        const now = new Date()
        const date = localDate(now)
        const rel = DAILY_DIR + '/' + date + '.md'
        const target = await fsService.resolve(vault + '/' + rel)

        const info = await fsService.stat(target)
        const before = info ? String(await fsService.readText(target) || '') : ''
        const base = before.length > 0 ? before : dailySeed(date)
        const after = appendEntry(base, buildEntry(now, args && args.title, points))

        // vault 在工作区之外，必须显式给最窄的沙箱策略（同设置路由）
        await fsService.writeText(target, after, undefined, undefined, {
          mode: 'workspace-write',
          workspaceRoot: vault,
        })

        // 记下"这个会话这一轮已经写过要点"，兜底就不会再补存根。
        // 用 agents.currentInitiator()（Host 服务自带：把发起本次调用的 Agent 带过异步链）。
        try {
          const agents = ctx.get('agents')
          const me = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
          const sid = me && me.id ? String(me.id) : ''
          if (sid.length > 0) stubState.lastRealWrite[sid] = Date.now()
        } catch (error) {
          // 拿不到会话 id 就算了：兜底最多多写一条存根，不会丢东西
        }

        return '已写入 ' + String(points.length) + ' 条要点到 ' + rel
          + '（' + (info ? '追加到已有文件' : '新建了当日记录') + '）'
      } catch (error) {
        const message = (error && error.message) ? error.message : String(error)
        return '没写：' + message
      }
    },
  }), 'dsh-note-changes: vault_note_append tool')

  console.log('[dsh-note-changes] host up (v1.5.0)')
}
