import fs from 'node:fs/promises'
import os from 'node:os'
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
let failing = true
const fixture = await preview({
    shellResult: (s) =>
      failing && / fetch /.test(s.command)
        ? {
            exitCode: 128,
            stdout: { text: '' },
            stderr: { text: 'fatal: could not resolve host: github.com' },
          }
        : undefined,
  }),
  other = await fs.mkdtemp(path.join(os.tmpdir(), 'dnc-settings-')),
  browser = await chromium.launch({ headless: true, channel: process.env.DNC_BROWSER || 'msedge' }),
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } }),
  errors = [],
  requests = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('request', (r) => requests.push(r))
let count = 0
const check = (label, value) => {
  assert.ok(value, label)
  console.log('PASS ' + label)
  count++
}
const apply = () => page.getByRole('button', { name: '应用连接', exact: true }).click()
const receipt = page.locator('[data-dnc-connection-status]')
const connection = page.locator('[data-dnc-active-connection]')
const out = process.env.DNC_SCREENSHOTS || 'D:/ChatGPT/_runs/notes-sync-tabs-20260929'
try {
  await fs.mkdir(out, { recursive: true })
  await fs.writeFile(path.join(other, '另一页.md'), '# 另一个笔记库\n')
  await page.goto(fixture.origin)
  await page.getByRole('heading', { name: '给想法留一盏灯' }).waitFor()
  check(
    '只注册会话插页，移除旧侧栏与主页面入口',
    await page.evaluate(
      () =>
        !!entries['conversation.view:note-workspace'] &&
        !entries['main:notes'] &&
        !entries['sidebar.panellist:notes'],
    ),
  )
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' })
  await editor.fill((await editor.inputValue()) + '\n连接前的草稿\n')
  await page.getByRole('tab', { name: '对话', exact: true }).click()
  await page.locator('[data-dnc-workspace]').waitFor({ state: 'hidden' })
  await page.getByRole('tab', { name: '笔记', exact: true }).click()
  await editor.waitFor()
  check('离开会话插页再返回，未保存草稿恢复', (await editor.inputValue()).includes('连接前的草稿'))
  await page.getByRole('button', { name: '↓ 下载更新', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '请先保存' }).waitFor()
  check(
    '未保存草稿阻止下载，无网络同步请求',
    !requests.some((r) => r.url().includes('/transfer') && r.method() === 'POST'),
  )
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { name: '笔记设置' }).waitFor()
  const custom = page.getByRole('radio', { name: /指定笔记库文件夹/ }),
    local = page.getByRole('radio', { name: /跟随本机配置/ })
  await custom.check()
  check(
    '连接方式互斥，点击选项尚未改变生效路径',
    (await custom.isChecked()) &&
      !(await local.isChecked()) &&
      (await connection.innerText()).includes('当前生效：跟随本机配置'),
  )
  await apply()
  await page.getByRole('alert').filter({ hasText: '不能为空' }).waitFor()
  check(
    '指定目录留空明确报错，不冒充跟随本机配置',
    !(await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))),
  )
  await page.getByRole('textbox', { name: '本机路径' }).fill('relative/path')
  await apply()
  await page.getByRole('alert').filter({ hasText: '完整路径' }).waitFor()
  check(
    '相对路径不改变现有连接',
    !(await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))),
  )
  await page.getByRole('textbox', { name: '本机路径' }).fill(other + '/missing')
  await apply()
  await page.getByRole('alert').filter({ hasText: '连接未更改' }).waitFor()
  check(
    '不存在目录不改变现有连接',
    !(await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))),
  )
  await page.getByRole('textbox', { name: '本机路径' }).fill(other)
  await apply()
  await receipt.filter({ hasText: '已连接指定文件夹' }).waitFor()
  check(
    '有效目录应用后显示生效模式、路径和笔记数',
    (await connection.innerText()).includes('指定文件夹') &&
      (await receipt.innerText()).includes('1 篇笔记'),
  )
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await page.getByRole('heading', { name: '另一个笔记库' }).waitFor()
  check('目录与正文一起切换到指定库', (await page.locator('.dnc-tree button').count()) === 1)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await local.check()
  check(
    '选择本机配置仍需应用，路径不会提前变化',
    (await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))).includes(
      'dnc-settings-',
    ),
  )
  await apply()
  await receipt.filter({ hasText: '已跟随本机配置' }).waitFor()
  check(
    '应用跟随模式才清除指定路径',
    !(await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))),
  )
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await editor.waitFor()
  check('跨库返回后原草稿仍完整', (await editor.inputValue()).includes('连接前的草稿'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '本地已保存' }).waitFor()
  await page.getByRole('button', { name: '↑ 上传笔记', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'could not resolve host' }).waitFor()
  check('同步失败显示具体原因', !(await page.locator('.dnc-sync').innerText()).includes('请求失败'))
  await page.screenshot({ path: path.join(out, 'sync-failure.png') })
  failing = false
  await page.getByRole('button', { name: '↑ 上传笔记', exact: true }).click()
  await page.locator('.dnc-sync').getByRole('status').filter({ hasText: '已上传笔记' }).waitFor()
  check('再次上传清除错误并显示成功', (await page.locator('.dnc-sync [role=alert]').count()) === 0)
  await page.getByRole('button', { name: '↓ 下载更新', exact: true }).click()
  await page
    .locator('.dnc-sync')
    .getByRole('status')
    .filter({ hasText: '已下载远端更新' })
    .waitFor()
  const directions = requests
    .filter((r) => r.method() === 'POST' && r.url().includes('/transfer'))
    .map((r) => r.postDataJSON().direction)
  check(
    '上传下载发出独立方向，不会触发另一个动作',
    JSON.stringify(directions) === '["upload","upload","download"]',
  )
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await custom.check()
  await page.getByRole('textbox', { name: '本机路径' }).fill(fixture.vault)
  await page.screenshot({ path: path.join(out, 'connection-modes.png') })
  check('无浏览器运行错误', errors.length === 0)
  console.log(count + ' 组连接方式、会话插页与双向同步浏览器检查通过')
} finally {
  await browser.close()
  await fixture.close()
  await fs.rm(other, { recursive: true, force: true })
}
