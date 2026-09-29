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
const out = process.env.DNC_SCREENSHOTS || 'D:/ChatGPT/_runs/notes-workspace-20260929'
await fs.mkdir(out, { recursive: true })
const fixture = await preview(),
  browser = await chromium.launch({ headless: true, channel: process.env.DNC_BROWSER || 'msedge' }),
  page = await browser.newPage({ viewport: { width: 1440, height: 940 } }),
  errors = []
page.on('pageerror', (e) => errors.push(e.message))
let count = 0
function check(name, value) {
  assert.ok(value, name)
  count++
  console.log('PASS ' + name)
}
try {
  await page.goto(fixture.origin)
  await page.getByRole('heading', { name: '给想法留一盏灯' }).waitFor()
  check(
    '独立主页面，无聊天输入框或浮窗',
    (await page.locator('[data-dnc-workspace]').count()) === 1 &&
      (await page.locator('.dnc-chip,.dnc-panel').count()) === 0,
  )
  await page.screenshot({ path: path.join(out, 'notes-light.png') })
  await page.getByRole('searchbox', { name: '搜索笔记' }).fill('地铁')
  await page.locator('.dnc-result').waitFor()
  check(
    '正文搜索命中正确笔记',
    (await page.locator('.dnc-result').innerText()).includes('灵感花园'),
  )
  await page.locator('.dnc-result').click()
  await page.getByRole('heading', { name: '灵感花园' }).waitFor()
  check(
    '反向链接可以看到其他笔记',
    await page
      .locator('.dnc-right')
      .innerText()
      .then((t) => t.includes('今天') && t.includes('欢迎')),
  )
  await page.locator('.dnc-doc').getByRole('button', { name: '回到索引' }).click()
  await page.getByRole('heading', { name: '给想法留一盏灯' }).waitFor()
  check('双链别名能打开实际文件', true)
  await page.getByRole('searchbox', { name: '搜索笔记' }).fill('')
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' })
  await editor.waitFor()
  check('原始 frontmatter 在编辑器中保留', (await editor.inputValue()).startsWith('---\ntags:'))
  const original = await editor.inputValue()
  await editor.fill(original + '\n本地草稿不会丢失。\n')
  await page.locator('.dnc-tree').getByRole('button', { name: '今天', exact: true }).click()
  await page.getByRole('heading', { name: '今天', exact: true }).waitFor()
  await page.locator('.dnc-tree').getByRole('button', { name: '欢迎', exact: true }).click()
  await editor.waitFor()
  check('切换笔记后自动恢复草稿', (await editor.inputValue()).includes('本地草稿不会丢失'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '本地已保存' }).waitFor()
  check(
    '通过真实保存路由落盘并限定提交文件',
    (await fs.readFile(path.join(fixture.vault, '00-索引/欢迎.md'), 'utf8')).includes(
      '本地草稿不会丢失',
    ) && fixture.commands.some((c) => c.includes('--only -- "00-索引/欢迎.md"')),
  )
  await editor.fill(original + '\n与外部改动冲突的草稿\n')
  await fs.writeFile(
    path.join(fixture.vault, '00-索引/欢迎.md'),
    original + '\nObsidian 刚刚更新\n',
  )
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '别处修改' }).waitFor()
  check(
    '冲突保留草稿且不覆盖外部修改',
    (await editor.inputValue()).includes('冲突的草稿') &&
      (await fs.readFile(path.join(fixture.vault, '00-索引/欢迎.md'), 'utf8')).includes(
        'Obsidian 刚刚更新',
      ),
  )
  await page.screenshot({ path: path.join(out, 'notes-conflict.png') })
  await page.getByRole('button', { name: '复制草稿并读取新版' }).click()
  await page.waitForFunction(() => document.querySelector('.dnc-editor')?.value.includes('Obsidian 刚刚更新'))
  check('冲突后可复制草稿并读取磁盘新版', !(await editor.inputValue()).includes('冲突的草稿'))
  await editor.fill(original + '\n保存后的阅读视图也要更新。\n')
  await editor.press('Control+s')
  await page.getByRole('status').filter({ hasText: '本地已保存' }).waitFor()
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  check('快捷保存后阅读视图显示最新正文', (await page.locator('.dnc-doc').innerText()).includes('保存后的阅读视图也要更新'))
  await page.getByRole('button', { name: '改动', exact: true }).click()
  await page.getByRole('heading', { name: '整理了今天的灵感' }).waitFor()
  check(
    '改动历史独立栏目可打开笔记',
    (await page.getByRole('button', { name: '灵感花园', exact: true }).count()) === 1,
  )
  await page.getByRole('button', { name: '灵感花园', exact: true }).click()
  await page.getByRole('heading', { name: '灵感花园', exact: true }).waitFor()
  await page.evaluate(() => {
    document.documentElement.style.cssText =
      '--dsw-alias-bg-base:#1d2025;--dsw-alias-bg-layer-1:#23272e;--dsw-alias-label-primary:#dddfe4;--dsw-alias-label-secondary:#a4acb8;--dsw-alias-border-l1:#363b43;--dsw-alias-brand-primary:#b0a0e2'
  })
  await page.screenshot({ path: path.join(out, 'notes-dark.png') })
  await page.setViewportSize({ width: 600, height: 820 })
  await page.getByRole('button', { name: '目录与搜索' }).click()
  check('窄屏目录可展开', await page.locator('.dnc-left').isVisible())
  await page.locator('.dnc-tree').getByRole('button', { name: '今天', exact: true }).click()
  await page.getByRole('heading', { name: '今天', exact: true }).waitFor()
  check(
    '窄屏不横向溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  )
  await page.screenshot({ path: path.join(out, 'notes-narrow.png') })
  check('无浏览器运行错误', errors.length === 0)
  console.log(count + ' 组浏览器检查通过；截图 ' + out)
} finally {
  await browser.close()
  await fixture.close()
}
