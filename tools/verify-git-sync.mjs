// 验"写完即 commit + push"（v1.6.0，2026-09-20 用户明令）。
//
// 为什么要有这一套：两条写入选路（vault_note_append 工具 / idle 兜底存根）以前只写盘不提交，
// 于是「写了但没提交」的内容既进不了右侧抽屉（那抽屉读 git log），也上不了 GitHub ——
// 换机器就丢。规则从"靠 agent 记性"改成"落到代码里"。
//
// 本套件**完全离线**：git 全部走桩。分三层：
//   1. 纯函数（提交信息 / 失败分类）
//   2. syncAfterWrite 的命令序列与失败分支（happy path / 无改动 / 被拒→rebase 重推 / 拒绝后停手 / 抛异常）
//   3. 穿过真实 apply() 的接线测试：工具路径与兜底路径**确实**发起了 add→commit→push
//
// 安全不变量（第 5 节）单独断言：任何一条命令都不许出现 --force / --no-verify / reset --hard / rm。
const fs = await import('node:fs')
const pathMod = await import('node:path')
const os = await import('node:os')
const url = await import('node:url')
const __dir = pathMod.dirname(url.fileURLToPath(import.meta.url))
const INDEX = process.env.DNC_INDEX || pathMod.resolve(__dir, '../index.js')
const ROOT = pathMod.join(os.tmpdir(), 'dsh-nc-git-sync')
const { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } = fs

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(pathMod.join(ROOT, 'vault', '00-收件箱', '日记'), { recursive: true })
const VAULT = ROOT.replace(/\\/g, '/') + '/vault'

const HOME = ROOT + '/home'
mkdirSync(pathMod.join(HOME, 'dsh-note-changes'), { recursive: true })
writeFileSync(pathMod.join(HOME, 'dsh-note-changes', 'vault.txt'), VAULT + '\n', 'utf8')
process.env.DSH_HOME = HOME.replace(/\\/g, '/')

const mod = await import(url.pathToFileURL(INDEX).href + '?sync' + Date.now())
const TODAY = mod.localDate(new Date())
const REL = '00-收件箱/日记/' + TODAY + '.md'

// ───────────────────────────────────────────── 1. 纯函数
console.log('— 1. 提交信息与失败分类 —')
ok('要点：带日期与标题',
  mod.buildSyncMessage('points', '2026-09-20', '蒸馏 R7') === '日记 2026-09-20 要点：蒸馏 R7',
  mod.buildSyncMessage('points', '2026-09-20', '蒸馏 R7'))
ok('兜底：标注自动，且不带标题',
  mod.buildSyncMessage('stub', '2026-09-20', '') === '日记 2026-09-20 兜底存根（DSH 自动）',
  mod.buildSyncMessage('stub', '2026-09-20', ''))
const nasty = mod.buildSyncMessage('points', '2026-09-20', 'a"b`c$d\\e\nf\tg')
ok('标题里的引号/反引号/$/反斜杠/换行都被剔掉（否则会切断 shell 引号）',
  !/["`$\\\n\t]/.test(nasty.split('：')[1]), nasty)
ok('标题被截到 60 字', mod.buildSyncMessage('points', '2026-09-20', 'x'.repeat(200)).length <= 60 + 20,
  'len=' + mod.buildSyncMessage('points', '2026-09-20', 'x'.repeat(200)).length)
ok('空标题也成立', mod.buildSyncMessage('points', '2026-09-20', null) === '日记 2026-09-20 要点',
  mod.buildSyncMessage('points', '2026-09-20', null))

ok('gitDetail 优先 stderr', mod.gitDetail({ code: 1, stderr: 'boom', stdout: 'out' }) === 'boom')
ok('gitDetail 退回 stdout', mod.gitDetail({ code: 1, stderr: '', stdout: 'out' }) === 'out')
ok('gitDetail 两者皆空则给退出码', mod.gitDetail({ code: 128, stderr: '', stdout: '' }) === 'git 退出码 128')
ok('gitDetail 空结果不炸', mod.gitDetail(null) === '未拿到结果')
ok('识别 non-fast-forward', mod.isPushRejected('! [rejected] main -> main (non-fast-forward)'))
ok('识别 fetch first', mod.isPushRejected('! [rejected] main -> main (fetch first)'))
ok('识别 behind', mod.isPushRejected('Updates were rejected because the tip of your current branch is behind'))
ok('普通网络失败不算被拒（不该触发 rebase）', mod.isPushRejected('fatal: unable to access remote') === false)

// ───────────────────────────────────────────── 2. syncAfterWrite 的序列
console.log('\n— 2. syncAfterWrite 命令序列 —')
const NONE = { code: 0, stdout: '', stderr: '' }
function recorder(script) {
  const seen = []
  const lanes = []
  const runGit = async (args, _timeoutMs, lane) => {
    const cmd = args.join(' ')
    seen.push(cmd)
    lanes.push(lane == null ? '' : lane)
    const reply = script[cmd]
    // 数组 = 这条命令按次序返回不同结果（"第一次 push 被拒、rebase 后第二次成功"就得这样写）
    if (Array.isArray(reply)) return reply.length > 1 ? reply.shift() : reply[0]
    return reply === undefined ? NONE : reply
  }
  return { seen, lanes, runGit }
}
const body = (rel, message) => ({ runGit: null, rel, message })

{
  const r = recorder({})
  const note = await mod.syncAfterWrite({ ...body(REL, 'm1'), runGit: r.runGit })
  ok('happy path 回「，已提交并推送」', note === '，已提交并推送', note)
  ok('序列是 rev-parse → add → commit → push',
    r.seen.length === 4 && /rev-parse/.test(r.seen[0]) && /^add /.test(r.seen[1])
    && /^commit /.test(r.seen[2]) && r.seen[3] === 'push', r.seen.join(' | '))
  ok('add 的是**那一个**文件（带路径），不是 -A',
    r.seen[1].includes(REL) && !/\s-A\b|--all/.test(r.seen[1]), r.seen[1])
  // v1.6.2：lane 必须由 syncAfterWrite 明说，不能让实现方去猜命令内容 ——
  // 真机实测受限模式里 git 建不出管道，只有走网络那两手需要放宽。
  ok('只有 push 走 network 腿，rev-parse/add/commit 走默认 write 腿',
    r.lanes.join(',') === ',,,' + mod.LANE_NETWORK, 'lanes=' + JSON.stringify(r.lanes))
}
{
  const r = recorder({ push: [{ code: 1, stderr: '! [rejected] main -> main (non-fast-forward)' }, NONE] })
  await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  // 序列：rev-parse, add, commit, push(被拒), pull --rebase, push —— 走网络的三手都必须是 network 腿
  ok('被拒后的 pull --rebase 与重推也走 network 腿',
    r.seen.length === 6 && r.lanes[3] === mod.LANE_NETWORK
    && r.lanes[4] === mod.LANE_NETWORK && r.lanes[5] === mod.LANE_NETWORK
    && r.lanes.slice(0, 3).every((l) => l !== mod.LANE_NETWORK), JSON.stringify(r.lanes))
}
{
  const r = recorder({})
  await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('commit 收到了我们构造的信息', r.seen[2].includes('"m"'), r.seen[2])
}
{
  const r = recorder({ ['add -- "' + REL + '"']: { code: 1, stderr: 'fatal: pathspec did not match' } })
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('add 失败 → 报未同步且不再往下走', /未同步：git add 失败/.test(note) && r.seen.length === 2, note)
}
{
  const r = recorder({ ['commit -m "m"']: { code: 1, stdout: 'nothing to commit, working tree clean' } })
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('无改动 → 「无改动，无需提交」，不当错误', note === '（无改动，无需提交）' && r.seen.length === 3, note)
}
{
  const r = recorder({ ['commit -m "m"']: { code: 1, stderr: 'fatal: unable to auto-detect email address' } })
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('提交真失败（如没配 identity）→ 明说已写入但提交失败', /已写入，但提交失败/.test(note), note)
}
{
  const r = recorder({ push: [{ code: 1, stderr: '! [rejected] main -> main (non-fast-forward)' }, NONE] })
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('推送被拒 → 回「，已提交并推送（先 rebase）」', note === '，已提交并推送（先 rebase）', note)
  ok('被拒后确实先 pull --rebase 再 push',
    r.seen.join(' | ').includes('pull --rebase') && r.seen[r.seen.length - 1] === 'push', r.seen.join(' | '))
}
{
  const r = recorder({
    push: { code: 1, stderr: '! [rejected] main -> main (non-fast-forward)' },
    'pull --rebase': { code: 1, stderr: 'CONFLICT (content): Merge conflict' },
  })
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('rebase 出冲突 → 停手报「需人工处理」，不再硬推', /需人工处理/.test(note), note)
}
{
  const r = recorder({ push: { code: 128, stderr: 'fatal: unable to access remote' } })
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('普通推送失败 → 明说已本地提交但推送失败', /已本地提交，但推送失败/.test(note), note)
  ok('普通失败不触发 rebase（不瞎折腾工作区）', !r.seen.join(' ').includes('pull'), r.seen.join(' | '))
}
{
  const r = recorder({ ['rev-parse --is-inside-work-tree']: { code: 128, stderr: 'not a git repository' } })
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: r.runGit })
  ok('不是 git 仓库 → 明确说未同步，且一个字都没改', /未同步：vault 不是 git 仓库/.test(note) && r.seen.length === 1, note)
}
{
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: async () => { throw new Error('shell 炸了') } })
  ok('runGit 抛异常 → 被吞成附注，绝不把"已写入"变成失败', /同步出错：shell 炸了/.test(note), note)
}
{
  const note = await mod.syncAfterWrite({ ...body(REL, 'm'), runGit: null })
  ok('没有执行器 → 附注说明，不抛', /未同步：没有可用的 git 执行器/.test(note), note)
}

// ───────────────────────────────────────────── 3. 穿过真实 apply() 的接线
console.log('\n— 3. 接线：工具路径与兜底路径都真的发起同步 —')
const registered = {}
const handlers = {}
const commands = []
const specs = []
const realSetTimeout = globalThis.setTimeout
// 兜底的防抖是 3 分钟（避免每轮都写存根），测试里把它压到 5ms —— 否则本套件要跑 3 分钟。
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 5 : ms, ...rest)

const ctx = {
  get(name) {
    if (name === 'webServer') return { register: () => () => {} }
    if (name === 'fs') {
      return {
        resolve: async (p) => p,
        stat: async (p) => (existsSync(p) ? { size: readFileSync(p).length } : null),
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
          specs.push(spec)   // 整条 spec 留档：沙箱策略挂在 spec 上，只看 command 断言不到它
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        },
      }
    }
    if (name === 'agents') {
      return { on: () => () => {}, list: async () => [], currentInitiator: () => ({ id: 'session-tool0001' }) }
    }
    return undefined
  },
  effect: (fn) => { try { fn() } catch { /* 路由注册失败不影响本套件 */ } return () => {} },
  tools: { register: (def) => { if (def && def.name) registered[def.name] = def } },
  on: (name, fn) => { handlers[name] = fn; return () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

await (mod.apply || mod.default.apply)(ctx)
const tool = registered['vault_note_append']
ok('vault_note_append 已注册', !!tool && typeof tool.execute === 'function')
if (!tool) {
  globalThis.setTimeout = realSetTimeout
  console.log('\n结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败')
  process.exit(1)
}

const at = commands.length
const reply = await tool.execute({ vault: VAULT, title: '同步接线', points: ['一条要点'] })
ok('工具回执仍以「已写入」开头（不破坏既有回执契约）', String(reply).startsWith('已写入'), String(reply).slice(0, 20))
ok('工具回执尾部带同步结果', /，已提交并推送/.test(String(reply)), String(reply).slice(-24))
const toolCmds = commands.slice(at)
ok('工具路径发起了 rev-parse/add/commit/push 四条',
  toolCmds.length === 4 && /rev-parse/.test(toolCmds[0]) && /^git .* add -- /.test(toolCmds[1] || '')
  && /commit -m/.test(toolCmds[2] || '') && / push$/.test(toolCmds[3] || ''), toolCmds.length + ' 条')
// 下标一律先兜底成空串：否则接线被摘掉时这里会抛 TypeError，
// 把后面所有断言连同汇总行一起吞掉 —— 那种"中途崩"比断言失败更难查。
ok('add 的正是当日日记那一个文件', String(toolCmds[1] || '').includes(REL), toolCmds[1] || '(没有这条命令)')
ok('commit 信息里带日期与标题',
  String(toolCmds[2] || '').includes(TODAY) && String(toolCmds[2] || '').includes('同步接线'),
  toolCmds[2] || '(没有这条命令)')
ok('日记落盘且含要点',
  existsSync(pathMod.join(ROOT, 'vault', REL.replace(/\//g, pathMod.sep)))
  && readFileSync(pathMod.join(ROOT, 'vault', REL.replace(/\//g, pathMod.sep)), 'utf8').includes('一条要点'))

// 兜底路径：跑过 running 再 idle，防抖到点后应补存根并同步
const atStub = commands.length
const STUB_SID = 'session-stub0002'
handlers['agent/status']({ agent: { id: STUB_SID }, status: 'running' })
handlers['agent/status']({ agent: { id: STUB_SID }, status: 'idle' })
await sleep(300)
const stubCmds = commands.slice(atStub)
ok('兜底路径也发起了同步（这条不经过 agent，不提交就永远进不了抽屉）',
  stubCmds.length === 4 && /^git .* add -- /.test(stubCmds[1]), stubCmds.length + ' 条：' + stubCmds.join(' | ').slice(0, 120))
ok('兜底提交信息标注了「兜底存根（DSH 自动）」',
  stubCmds.length >= 3 && stubCmds[2].includes('兜底存根'), stubCmds[2] || '(无)')
ok('兜底也把存根写进了当日日记',
  existsSync(pathMod.join(ROOT, 'vault', REL.replace(/\//g, pathMod.sep)))
  && readFileSync(pathMod.join(ROOT, 'vault', REL.replace(/\//g, pathMod.sep)), 'utf8').includes('自动记录 · 待补充'))

// ───────────────────────────────────────────── 4. 安全不变量
console.log('\n— 4. 安全不变量：自动化不许用破坏性手段 —')
const joined = commands.join('\n')
ok('全部命令里没有 --force（含 -f）', !/--force|(^|\s)-f(\s|$)/.test(joined), '共 ' + commands.length + ' 条命令')
ok('没有 --no-verify', !joined.includes('--no-verify'))
ok('没有 reset --hard', !/reset\s+--hard/.test(joined))
ok('没有 add -A / add --all（否则会把用户正在写的东西一起推上去）',
  !/\sadd\s+(-A|--all)\b/.test(joined))
ok('没有 rm / clean -fd 这类删除', !/\brm\s+-|\bclean\s+-[a-z]*d/.test(joined))
ok('所有 git 命令都在 vault 目录里跑（-C 或 workdir 约束）', !/\bgit\b/.test(joined.replace(/git -c core\.quotepath=false -C "[^"]*"/g, '')))

// ───────────────────────────────────────────── 5. 沙箱策略必须挂上（v1.6.1）
// 现场：v1.6.0 端到端第一次真实写入，写盘成功但 `git add` 报
//   fatal: Unable to create 'D:/DeepSeek/vault/.git/index.lock': Permission denied
// 根因：`ctx.sandboxPolicy.resolve()` 的 workspaceRoot 只从 session 取，vault 在会话工作区外
// ⇒ shell 里的 git 被按只读执行。修法 = 每次调用显式带上 { mode:'workspace-write', workspaceRoot: vault }。
// 因此这里断言"策略挂在 spec 上"，而不是只看 command —— 只看 command 的话这个 bug 全套件都测不出来。
console.log('\n— 5. 沙箱策略：只把 vault 划成可写 —')
ok('确实抓到了 shell 调用（否则下面的 every 是空真）', specs.length > 0 && specs.length === commands.length,
  specs.length + ' 条 spec / ' + commands.length + ' 条命令')
const VAULT_REAL = fs.realpathSync.native(VAULT)
// 取策略一律走这个：策略缺失（正是变体要制造的情形）时返回 '(无)'，
// 绝不在断言里直接 .sandboxPolicy.xxx —— 那会抛 TypeError 把后面的断言全吞掉。
const polOf = (s) => (s && s.sandboxPolicy ? s.sandboxPolicy : {})
const modeOf = (s) => String(polOf(s).mode || '(无)')
// write 腿 = 不带 lane 的那几手（rev-parse / add / commit）；网络腿单独断言，见下面 v1.6.2 那组。
const writeSpecs = specs.filter((s, i) => !/ push$|pull --rebase/.test(String(commands[i])))
ok('确实抓到了 shell 调用（否则下面的 every 是空真）', specs.length > 0 && specs.length === commands.length,
  specs.length + ' 条 spec / ' + commands.length + ' 条命令')
ok('每条 git 调用都显式带沙箱策略，且 write 腿模式是 workspace-write',
  writeSpecs.length > 0 && writeSpecs.every((s) => modeOf(s) === 'workspace-write'),
  writeSpecs.map(modeOf).join(','))
ok('策略的 workspaceRoot 指向 vault 的 realpath（ACL 授权的依据，必须取 realpath）',
  writeSpecs.length > 0 && writeSpecs.every((s) => polOf(s).workspaceRoot === VAULT_REAL),
  String((writeSpecs[0] ? polOf(writeSpecs[0]).workspaceRoot : '(无)')) + ' vs ' + VAULT_REAL)

// ── v1.6.2：走网络的那两手必须是另一套模式（真机实测：受限模式里 git 建不出管道）
const netSpecs = specs.filter((s, i) => / push$|pull --rebase/.test(String(commands[i])))
ok('确实抓到了走网络的调用（否则下面的 every 是空真）',
  netSpecs.length > 0 && netSpecs.length + writeSpecs.length === specs.length,
  netSpecs.length + ' 条网络 / ' + specs.length + ' 条总')
ok('push 与 pull --rebase 都走非受限模式（受限模式不允许建管道 ⇒ HTTPS 传输必失败）',
  netSpecs.length > 0 && netSpecs.every((s) => modeOf(s) === 'danger-full-access'),
  netSpecs.map(modeOf).join(','))
ok('权限放宽只发生在网络那两手上：add / commit / rev-parse 仍是 workspace-write',
  writeSpecs.length > 0 && writeSpecs.every((s) => modeOf(s) === 'workspace-write'),
  writeSpecs.map(modeOf).join(','))
ok('网络腿不再带 workspaceRoot（它跳过 confine()，带着反而像是还受限于某个根）',
  netSpecs.length > 0 && netSpecs.every((s) => polOf(s).workspaceRoot === undefined))
ok('syncAfterWrite 把 lane 传给了 runGit（不靠实现方猜命令内容）',
  mod.LANE_NETWORK === 'network' && typeof mod.syncAfterWrite === 'function', String(mod.LANE_NETWORK))

globalThis.setTimeout = realSetTimeout
rmSync(ROOT, { recursive: true, force: true })

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
