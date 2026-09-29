import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { preview } from './browser-preview.mjs'
const { chromium } = await import(
  pathToFileURL(
    process.env.DNC_PLAYWRIGHT_MODULE ||
      'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs',
  )
)
const out = process.env.DNC_SCREENSHOTS || 'D:/ChatGPT/_runs/notes-workspace-plus-20260929'
await fs.mkdir(out, { recursive: true })
const fixture = await preview(),
  browser = await chromium.launch({ headless: true, channel: process.env.DNC_BROWSER || 'msedge' }),
  page = await browser.newPage({ viewport: { width: 1440, height: 940 } }),
  errors = [],
  requests = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (
    m.type() === 'error' &&
    !(m.text().includes('409 (Conflict)') && m.location().url.includes('/note-changes/save'))
  )
    errors.push(m.text())
})
page.on('request', (r) => requests.push(r.url()))
let count = 0
function check(name, value) {
  assert.ok(value, name)
  count++
  console.log('PASS ' + name)
}
const mediaPath = '研究/公式与附件.md'
async function openNote(label) {
  await page.locator('.dnc-tree').getByRole('button', { name: label, exact: true }).click()
}
try {
  await fs.mkdir(path.join(fixture.vault, '研究'))
  await fs.mkdir(path.join(fixture.vault, '90-附件'))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXXkAAAAASUVORK5CYII=',
    'base64',
  )
  await fs.writeFile(path.join(fixture.vault, '90-附件/示意.png'), png)
  await fs.writeFile(path.join(fixture.vault, '90-附件/说明.pdf'), '%PDF-1.4\n%%EOF')
  await fs.writeFile(
    path.join(fixture.vault, mediaPath),
    '---\ntags: [研究, 数学]\nstatus: 生长中\n---\n# 公式与附件\n\n行内 $E=mc^2$。\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n![[90-附件/示意.png]]\n\n![相对图片](../90-附件/示意.png)\n\n![[说明.pdf]]\n\n![远程](https://remote.invalid/a.png)\n\n<script>window.bad=true</script>\n\n$\\includegraphics{https://remote.invalid/secret.png}$\n',
  )
  await page.goto(fixture.origin)
  await page.getByRole('heading', { name: '给想法留一盏灯' }).waitFor()
  await page.locator('.dnc-documentbar').getByRole('button', { name: '收藏', exact: true }).click()
  await page.getByRole('button', { name: '收藏', exact: true }).click()
  check('收藏集合只显示已收藏笔记', (await page.locator('.dnc-tree button').count()) === 1)
  await page.reload()
  await page.getByRole('button', { name: '已收藏', exact: true }).waitFor()
  check('收藏持久保存到当前笔记库', true)
  await page.getByRole('button', { name: '最近', exact: true }).click()
  await page.locator('.dnc-result').waitFor()
  check(
    '最近打开显示已读笔记',
    (await page.locator('.dnc-result').first().innerText()).includes('给想法'),
  )
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.locator('.dnc-filters summary').click()
  await page.getByLabel('标签筛选').selectOption('研究')
  check('标签筛选命中目标文件', (await page.locator('.dnc-tree button').count()) === 1)
  await page.getByLabel('属性筛选').selectOption('status')
  await page.getByLabel('属性值筛选').selectOption('生长中')
  await openNote('公式与附件')
  await page.locator('.katex').first().waitFor()
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.dnc-image')].length === 2 &&
      [...document.querySelectorAll('.dnc-image')].every((n) => n.complete && n.naturalWidth > 0),
  )
  check('本地图片和相对附件路径能预览', true)
  check(
    '公式离线排版，PDF 使用本地附件入口',
    (await page.locator('.katex').count()) === 3 &&
      (await page.locator('.dnc-doc a[href*="asset"]').count()) === 1,
  )
  check(
    '远程图片和不可信公式不会自动请求外部地址',
    !requests.some((u) => u.includes('remote.invalid')) && !(await page.evaluate(() => window.bad)),
  )
  const asset = await page.request.get(
    fixture.origin +
      '/note-changes/asset?vault=' +
      encodeURIComponent(fixture.vault) +
      '&path=' +
      encodeURIComponent('90-附件/示意.png'),
  )
  check(
    '附件接口保持原始二进制并禁止 MIME 嗅探',
    (await asset.body()).equals(png) && asset.headers()['x-content-type-options'] === 'nosniff',
  )
  const blocked = await page.request.get(fixture.origin + '/note-changes/vendor?file=../index.js')
  check('公式资源路由不允许读取任意文件', blocked.status() === 404)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await page.getByRole('button', { name: '关系图', exact: true }).click()
  await page.getByRole('heading', { name: '一个念头，通向哪里' }).waitFor()
  check(
    '局部关系图能标出孤立笔记',
    (await page.locator('.dnc-graph').innerText()).includes('尚未连起来的笔记 · 1'),
  )
  await page.getByRole('button', { name: '孤立笔记', exact: true }).click()
  check('孤立筛选与关系图一致', (await page.locator('.dnc-tree button').count()) === 1)
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await openNote('欢迎')
  await page.getByRole('button', { name: '关系图', exact: true }).click()
  await page.screenshot({ path: path.join(out, 'notes-graph.png') })
  await page.getByRole('button', { name: '打开 想法/灵感花园.md', exact: true }).click()
  await page.getByRole('heading', { name: '灵感花园', exact: true }).waitFor()
  check('点击图节点能打开对应笔记', true)
  await page.getByRole('button', { name: '＋ 新建', exact: true }).click()
  await page.getByRole('textbox', { name: '笔记路径' }).fill('项目/第一次整理')
  await page.getByLabel('模板', { exact: true }).selectOption('meeting')
  await page.screenshot({ path: path.join(out, 'notes-create.png') })
  await page.getByRole('button', { name: '创建并编辑' }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' })
  await editor.waitFor()
  await page.waitForFunction(() =>
    document.querySelector('.dnc-editor')?.value.includes('第一次整理'),
  )
  check(
    '新建嵌套笔记并进入编辑，模板正确落盘',
    (await fs.readFile(path.join(fixture.vault, '项目/第一次整理.md'), 'utf8')).includes(
      'tags: [会议]',
    ),
  )
  check(
    '新建仍只提交当前文件',
    fixture.commands.some((c) => c.includes('commit -m "新建笔记" --only -- "项目/第一次整理.md"')),
  )
  const original = await editor.inputValue()
  await editor.fill(original + '\n草稿的补充\n')
  await fs.appendFile(path.join(fixture.vault, '项目/第一次整理.md'), '\n磁盘的补充\n')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '对照合并', exact: true }).click()
  await page.getByRole('region', { name: '对照合并' }).waitFor()
  check(
    '差异尚未选择前不能应用合并',
    await page.getByRole('button', { name: /处待选择/ }).isDisabled(),
  )
  for (const button of await page.getByRole('button', { name: '两段都保留', exact: true }).all())
    await button.click()
  await page.screenshot({ path: path.join(out, 'notes-merge.png') })
  await page.getByRole('button', { name: '应用合并到草稿' }).click()
  check(
    '合并保留双方内容',
    (await editor.inputValue()).includes('磁盘的补充') &&
      (await editor.inputValue()).includes('草稿的补充'),
  )
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '本地已保存' }).waitFor()
  check(
    '合并后使用最新文件版本安全保存',
    (await fs.readFile(path.join(fixture.vault, '项目/第一次整理.md'), 'utf8')).includes(
      '草稿的补充',
    ),
  )
  await page.getByRole('button', { name: '今日笔记', exact: true }).click()
  await page.getByRole('button', { name: '创建并编辑' }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '今日笔记', exact: true }).click()
  await page.getByRole('button', { name: '打开已有笔记' }).waitFor()
  check(
    '重复打开今日笔记不会覆盖旧内容',
    await page.getByRole('button', { name: '创建并编辑' }).isDisabled(),
  )
  await page.getByRole('button', { name: '打开已有笔记' }).click()
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.waitForFunction(() =>
    /读取 0 \/ 复用 [1-9]/.test(document.querySelector('.dnc-footer')?.textContent || ''),
  )
  check('页面刷新可复用完整索引', true)
  await openNote('欢迎')
  await page.getByRole('heading', { name: '给想法留一盏灯' }).waitFor()
  await page.screenshot({ path: path.join(out, 'notes-plus-light.png') })
  await page.evaluate(() => {
    document.documentElement.style.cssText =
      '--dsw-alias-bg-base:#1d2025;--dsw-alias-bg-layer-1:#23272e;--dsw-alias-label-primary:#dddfe4;--dsw-alias-label-secondary:#a4acb8;--dsw-alias-border-l1:#363b43;--dsw-alias-brand-primary:#b0a0e2'
  })
  await page.screenshot({ path: path.join(out, 'notes-plus-dark.png') })
  await page.setViewportSize({ width: 600, height: 820 })
  await page.getByRole('button', { name: '目录与搜索' }).click()
  await page.getByRole('button', { name: '＋ 新建', exact: true }).click()
  check(
    '窄屏新建对话框可用且无横向溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  )
  await page.screenshot({ path: path.join(out, 'notes-plus-narrow.png') })
  check('增强工作流没有浏览器错误', errors.length === 0)
  console.log(count + ' 组增强浏览器检查通过')
} catch (e) {
  console.error(errors)
  await page.screenshot({ path: path.join(out, 'plus-failure.png') })
  throw e
} finally {
  await browser.close()
  await fixture.close()
}
