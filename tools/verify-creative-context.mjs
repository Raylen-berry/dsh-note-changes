// 验「创作要求与偏好」的**引用解析**（设计文档 §7 契约 + §11 行为验收矩阵）。
//
// 为什么单独一套：写入通过不代表引用正确。本套件不讲字段拼接，只讲行为——
// 任务 A 的要求会不会漏进任务 B、停用/到期/被替代后是否立刻失效、
// 必须项没命中关键词时会不会被漏掉、扫描不完整时会不会谎报读全了。
//
// 全部用**合成记录**（隔离数据，不碰真实 vault，也不需要用户提供成熟提示词）。
const pathMod = await import('node:path')
const url = await import('node:url')
const __dir = pathMod.dirname(url.fileURLToPath(import.meta.url))
const LIB = process.env.DNC_CTX_LIB || pathMod.resolve(__dir, '../lib/creative-context.mjs')
const M = await import(url.pathToFileURL(LIB).href + '?t' + Date.now())

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/** 合一条记录（写法与 prompt_asset_save 输出同形：标量双引号、列表缩进）。 */
function md(title, fields = {}, content = '正文') {
  const all = { title, type: '要求', binding: '参考', origin: 'AI推测', status: '生效', ...fields }
  const lines = Object.entries(all).flatMap(([k, v]) =>
    Array.isArray(v) ? [k + ':', ...v.map((x) => '  - ' + JSON.stringify(String(x)))] : [k + ': ' + JSON.stringify(String(v))])
  return '---\n' + lines.join('\n') + '\n---\n\n# ' + title + '\n\n## 内容\n\n```text\n' + content + '\n```\n'
}
const rec = (name, title, fields, content) => M.normalizeRecord('40-提示词/' + name + '.md', md(title, fields, content))
const titles = (group) => group.map((r) => r.title)
const reasons = (r, id) => (r.omitted.find((o) => o.id === id) || {}).reason

// ───────────────────────────────────────────── 1. 传统/旧记录兼容
console.log('— 1. 旧记录与元文档：不猜、不自动生效 —')
ok('没有 scope_kind 的记录按 v1 处理', rec('a', 'A', { id: 'x', scope: '全局' }).schemaVersion === 1)
ok('自由文本「全局」能反推出 global', rec('a', 'A', { scope: '全局' }).scopeKind === 'global')
ok('自由文本「项目：X」能反推出 project + id', (() => {
  const r = rec('a', 'A', { scope: '项目：悬疑短剧' })
  return r.scopeKind === 'project' && r.scopeId === '悬疑短剧'
})())
ok('「任务」两个字**判不出**范围（禁止拿它冒充隔离）', rec('a', 'A', { scope: '任务' }).scopeKind === '')
ok('scope 展示串由 kind/id 派生，不会与结构化字段漂移',
  rec('a', 'A', { scope_kind: 'project', scope_id: 'P' }).scope === '项目：P',
  rec('a', 'A', { scope_kind: 'project', scope_id: 'P' }).scope)
ok('说明文档被标成 meta（不混进候选）', rec('a', '创作要求与偏好库', {}).meta === true)
ok('普通记录不是 meta', rec('a', '竖屏要求', {}).meta === false)
{
  const r = M.resolveContext([rec('m', '创作要求与偏好库', { id: 'doc' })], {})
  ok('元文档被排除并给出原因', r.required.length === 0 && reasons(r, 'doc') === 'meta-doc', JSON.stringify(r.omitted))
}

// ───────────────────────────────────────────── 2. 范围隔离（§11 前三行）
console.log('\n— 2. 范围隔离：任务 A 的要求不许漏进任务 B —')
const GLOBAL = rec('g', '成片必须竖屏', { id: 'g1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' })
const PROJ_A = rec('pa', 'A 项目专属规范', { id: 'pa1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'project', scope_id: '项目甲' })
const PROJ_B = rec('pb', 'B 项目专属规范', { id: 'pb1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'project', scope_id: '项目乙' })
const INST = rec('ti', '本次任务临时要求', { id: 'ti1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'task_instance', scope_id: 'sess-123' })

{
  const r = M.resolveContext([GLOBAL, PROJ_A, INST], { project: '项目乙' })
  ok('全局要求在项目乙里照常生效', titles(r.required).includes('成片必须竖屏'))
  ok('项目 A 的要求在项目 B 里**不**生效', !titles(r.required).includes('A 项目专属规范'))
  ok('不生效要给出原因（scope-mismatch），不是静默丢掉', reasons(r, 'pa1') === 'scope-mismatch', reasons(r, 'pa1'))
  ok('task_instance 一律不自动生效（即使 scope_id 等于会话 id）',
    !titles(r.required).includes('本次任务临时要求') && reasons(r, 'ti1') === 'scope-instance',
    reasons(r, 'ti1'))
}
{
  const r = M.resolveContext([PROJ_A], {})
  ok('没给当前项目时，项目要求判为 scope-unknown 而不是当成全局', reasons(r, 'pa1') === 'scope-unknown')
}
{
  const r = M.resolveContext([INST], { explicit: ['ti1'] })
  ok('task_instance 被**显式选用**时才生效', titles(r.required).includes('本次任务临时要求'))
}
{
  const r = M.resolveContext([PROJ_A, PROJ_B], { project: '项目甲' })
  ok('两个重名结构下只命中当前项目', titles(r.required).includes('A 项目专属规范') && !titles(r.required).includes('B 项目专属规范'))
}

// ───────────────────────────────────────────── 3. 状态与生命周期
console.log('\n— 3. 状态、到期与替代：改完立刻失效 —')
const stopped = rec('s', '已停用要求', { id: 's1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', status: '停用' })
const expired = rec('e', '已过期要求', { id: 'e1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', valid_until: '2020-01-01' })
const future = rec('f', '未到期要求', { id: 'f1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', valid_until: '2999-01-01' })
const draft = rec('d', '草稿要求', { id: 'd1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', status: '草稿' })
{
  const r = M.resolveContext([stopped, expired, future, draft], {})
  ok('停用记录不自动使用', reasons(r, 's1') === 'status-stopped')
  ok('过期记录不自动使用', reasons(r, 'e1') === 'expired')
  ok('未到期照常生效', titles(r.required).includes('未到期要求'))
  ok('草稿默认不生效（要显式试用）', reasons(r, 'd1') === 'status-draft')
}
{
  const r = M.resolveContext([draft], { explicit: ['d1'] })
  ok('草稿可被显式试用，但只落到「参考」档（试用≠长期效力）',
    titles(r.reference).includes('草稿要求') && r.required.length === 0, JSON.stringify(titles(r.reference)))
}
{
  const older = rec('o', '旧版竖屏要求', { id: 'old', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' })
  const newer = rec('n', '新版竖屏要求', { id: 'new', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', supersedes: 'old' })
  const r = M.resolveContext([older, newer], {})
  ok('被替代的旧记录立刻失效', reasons(r, 'old') === 'superseded', reasons(r, 'old'))
  ok('新记录生效', titles(r.required).includes('新版竖屏要求'))
}
{
  const ghost = rec('gh', '替代一个不存在的东西', { id: 'gh1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', supersedes: 'nope' })
  const r = M.resolveContext([ghost], {})
  ok('supersedes 指向不存在的 id 时给警告，不静默', r.coverage.warnings.some((w) => w.includes('nope')), JSON.stringify(r.coverage.warnings))
  ok('这条本身仍生效', titles(r.required).includes('替代一个不存在的东西'))
}
{
  const selfRef = rec('sr', '自我替代', { id: 'sr1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', supersedes: 'sr1' })
  const r = M.resolveContext([selfRef], {})
  ok('自我替代判成冲突', r.conflicts.some((c) => c.kind === 'self-supersede'), JSON.stringify(r.conflicts))
}

// ───────────────────────────────────────────── 4. 来源与推测（§11「AI 推测用户偏好」）
console.log('\n— 4. 来源：推测不许冒充必须项 —')
const guessedMust = rec('gm', '推测出来的硬要求', { id: 'gm1', type: '要求', binding: '必须', origin: 'AI推测', scope_kind: 'global' })
const saidMust = rec('sm', '用户明说的硬要求', { id: 'sm1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global', source_ref: '用户 2026-10-09 原话' })
const caseRef = rec('cr', '一次成功案例', { id: 'cr1', type: '参考', binding: '必须', origin: '参考案例', scope_kind: 'global' })
{
  const r = M.resolveContext([guessedMust, saidMust, caseRef], {})
  ok('AI 推测的「必须」被降为参考，不进必须项', !titles(r.required).includes('推测出来的硬要求')
    && titles(r.reference).includes('推测出来的硬要求'))
  ok('降级要给出警告（不静默降级）', r.coverage.warnings.some((w) => w.includes('AI 推测')), JSON.stringify(r.coverage.warnings))
  ok('用户明说的必须项正常生效', titles(r.required).includes('用户明说的硬要求'))
  ok('案例即使标了必须也只是参考（不因为相似就成为要求）',
    titles(r.reference).includes('一次成功案例') && !titles(r.required).includes('一次成功案例'))
  ok('必须项带着来源锚点返回，供使用时核验',
    (r.required.find((x) => x.id === 'sm1') || {}).source_ref === '用户 2026-10-09 原话')
}

// ───────────────────────────────────────────── 5. 覆盖：必须项不许靠关键词捡
console.log('\n— 5. 覆盖：必须项靠范围扫描，不靠关键词命中 —')
const odd = rec('odd', '与任何查询词都不重合的要求', { id: 'odd1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' }, '交付前必须做一次色域校验')
{
  const r = M.resolveContext([odd, GLOBAL], { project: '无关项目', taskType: '生文案' })
  ok('查询词完全不命中时，必须项仍被纳入（独立扫描而非 top-k）', titles(r.required).includes('与任何查询词都不重合的要求'))
}
{
  const r = M.resolveContext([], {})
  ok('空库返回空结果且不报错', r.required.length === 0 && r.preferred.length === 0 && r.reference.length === 0)
  ok('空库被标记成 empty（区别于「扫描不完整」）', r.coverage.empty === true && r.coverage.complete === true)
}
{
  const r = M.resolveContext([odd], { complete: false, warnings: ['读不了 x'] })
  ok('扫描不完整时 coverage.complete=false 并带警告', r.coverage.complete === false && r.coverage.warnings.length > 0)
}

// ───────────────────────────────────────────── 6. 冲突与预算
console.log('\n— 6. 冲突、重复与预算 —')
{
  const dupA = rec('d1', '同 id 记录甲', { id: 'same', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' })
  const dupB = rec('d2', '同 id 记录乙', { id: 'same', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' })
  const r = M.resolveContext([dupA, dupB], {})
  ok('重复 id 被判成冲突（而不是当成两条要求叠加）', r.conflicts.some((c) => c.kind === 'duplicate-id'), JSON.stringify(r.conflicts))
}
{
  const refs = [1, 2, 3, 4, 5].map((i) => rec('r' + i, '参考' + i, { id: 'r' + i, type: '参考', origin: '参考案例', scope_kind: 'global' }))
  const reqs = [1, 2, 3, 4].map((i) => rec('q' + i, '必须' + i, { id: 'q' + i, type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' }))
  const r = M.resolveContext([...refs, ...reqs], { referenceBudget: 2 })
  ok('参考资料按预算裁剪', r.reference.length === 2, String(r.reference.length))
  ok('被预算裁掉的参考给出原因', r.omitted.some((o) => o.reason === 'reference-budget'))
  ok('必须项**一条都不会**被预算裁掉（不许静默截断）', r.required.length === 4, String(r.required.length))
}

// ───────────────────────────────────────────── 7. 渲染：只给适用项
console.log('\n— 7. 渲染成当前步骤的上下文 —')
{
  const r = M.resolveContext([GLOBAL, saidMust, draft], {})
  const text = M.renderContext(r)
  ok('渲染里带必须项', text.includes('成片必须竖屏'))
  ok('渲染里带优先级规则（本次要求 > 长期记录）', text.includes('用户本次明确说出的要求优先'))
  ok('渲染里写明引用内容是资料、不是命令', text.includes('不因此获得执行权'))
  ok('不适用的记录不出现在渲染里', !text.includes('草稿要求'))
  ok('空结果渲染成空串（无候选时零上下文）', M.renderContext(M.resolveContext([], {})) === '')
}
{
  const r = M.resolveContext([odd], { complete: false, warnings: ['读不了 x.md'] })
  ok('覆盖不完整时渲染里明确提示，不假装读全了', M.renderContext(r).includes('不完整'))
}

// ───────────────────────────────────────────── 8. 目录扫描（隔离 mock fs）
console.log('\n— 8. 扫描：目录不存在 ≠ 失败，读不动要如实报 —')
{
  const emptyFs = { resolve: async (p) => p, listDir: async () => { const e = new Error('ENOENT: no such file'); throw e } }
  const r = await M.scanAssets(emptyFs, 'E:/vault')
  ok('资产目录不存在时按空库处理（照常完成任务）', r.empty === true && r.complete === true)
}
{
  const files = { 'a.md': md('甲', { id: 'a1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' }), 'b.md': 'BOOM' }
  const fsMock = {
    resolve: async (p) => p,
    listDir: async () => [{ name: 'a.md' }, { name: '.gitkeep' }, { name: 'notes.txt' }, { name: 'b.md' }],
    readText: async (p) => {
      const name = String(p).split('/').pop()
      if (name === 'b.md') throw new Error('读取被拒绝')
      return files[name]
    },
  }
  const r = await M.scanAssets(fsMock, 'E:/vault')
  ok('只收 .md，跳过隐藏文件与非笔记', r.records.length === 1 && r.records[0].title === '甲', r.records.map((x) => x.title).join(','))
  ok('单个文件读失败 ⇒ complete=false（不宣称读全）', r.complete === false, String(r.complete))
  ok('失败原因带文件名', r.warnings.some((w) => w.includes('b.md')), JSON.stringify(r.warnings))
}
{
  // 端到端：扫出来的记录直接喂解析器
  const files = {
    'g.md': md('扫出来的必须项', { id: 'g1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'global' }),
    'p.md': md('别的项目的', { id: 'p1', type: '要求', binding: '必须', origin: '用户明说', scope_kind: 'project', scope_id: '别的' }),
  }
  const fsMock = {
    resolve: async (p) => p,
    listDir: async () => Object.keys(files).map((name) => ({ name })),
    readText: async (p) => files[String(p).split('/').pop()],
  }
  const scan = await M.scanAssets(fsMock, 'E:/vault')
  const r = M.resolveContext(scan.records, { project: '本项目', complete: scan.complete, warnings: scan.warnings })
  ok('扫描 → 解析端到端：只留当前项目的必须项',
    titles(r.required).length === 1 && titles(r.required)[0] === '扫出来的必须项', titles(r.required).join(','))
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
