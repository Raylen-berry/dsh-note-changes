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
    shellResult: () => ({
      exitCode: failing ? 128 : 0,
      stdout: { text: '' },
      stderr: {
        text: failing ? 'fatal: could not resolve host: github.com' : 'Everything up-to-date',
      },
    }),
  }),
  other = await fs.mkdtemp(path.join(os.tmpdir(), 'dnc-settings-')),
  browser = await chromium.launch({ headless: true, channel: process.env.DNC_BROWSER || 'msedge' }),
  page = await browser.newPage({ viewport: { width: 1200, height: 850 } }),
  errors = [],
  libraryRequests = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('request', (r) => {
  if (r.url().includes('/note-changes/library')) libraryRequests.push(r.url())
})
let count = 0
const check = (name, value) => {
  assert.ok(value, name)
  console.log('PASS ' + name)
  count++
}
const connect = () => page.getByRole('button', { name: '连接笔记库', exact: true }).click()
const connectionMessage = page.locator('[data-dnc-connection-status]')
try {
  await fs.writeFile(path.join(other, '另一页.md'), '# 另一个笔记库\n')
  await page.goto(fixture.origin)
  await page.getByRole('heading', { name: '给想法留一盏灯' }).waitFor()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' })
  await editor.fill((await editor.inputValue()) + '\n连接前的草稿\n')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { name: '笔记设置' }).waitFor()
  await connect()
  await connectionMessage.filter({ hasText: '已跟随本机配置' }).waitFor()
  check(
    '路径留空时连接也有明确成功反馈',
    (await connectionMessage.innerText()).includes('3 篇笔记'),
  )
  let previous = libraryRequests.length
  await connect()
  await connectionMessage.filter({ hasText: '已跟随本机配置' }).waitFor()
  check('重复连接同一路径仍重新检查并刷新', libraryRequests.length > previous)
  previous = libraryRequests.length
  await page.getByRole('button', { name: '跟随本机配置', exact: true }).click()
  await connectionMessage.filter({ hasText: '已跟随本机配置' }).waitFor()
  check('已在跟随模式时再次点击仍检查本机配置', libraryRequests.length > previous)
  await page.getByRole('textbox', { name: '本机路径' }).fill('relative/path')
  await connect()
  await page.getByRole('alert').filter({ hasText: '完整路径' }).waitFor()
  check(
    '相对路径显示错误且保持原连接',
    !(await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))),
  )
  await page.getByRole('textbox', { name: '本机路径' }).fill(other + '/missing')
  await connect()
  await page.getByRole('alert').filter({ hasText: '连接未更改' }).waitFor()
  check(
    '不存在的笔记库不会被保存成当前连接',
    !(await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))),
  )
  await page.getByRole('textbox', { name: '本机路径' }).fill(other)
  await connect()
  await connectionMessage.filter({ hasText: '已连接：' }).waitFor()
  check(
    '连接有效目录后显示路径与笔记数量',
    (await connectionMessage.innerText()).includes('1 篇笔记'),
  )
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await page.getByRole('heading', { name: '另一个笔记库' }).waitFor()
  check('切换后正文和目录来自新库', (await page.locator('.dnc-tree button').count()) === 1)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '跟随本机配置', exact: true }).click()
  await connectionMessage.filter({ hasText: '已跟随本机配置' }).waitFor()
  check(
    '跟随本机配置清除覆盖路径',
    !(await page.evaluate(() => localStorage.getItem('dsh-note-changes:vault'))),
  )
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await editor.waitFor()
  check('跨库返回后原笔记草稿仍完整', (await editor.inputValue()).includes('连接前的草稿'))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '重试推送', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'could not resolve host' }).waitFor()
  check(
    '推送失败保留具体原因，不退化为请求失败',
    !(await page.getByRole('alert').innerText()).includes('请求失败'),
  )
  const out = process.env.DNC_SCREENSHOTS || 'D:/ChatGPT/_runs/notes-settings-fix-20260929'
  await fs.mkdir(out, { recursive: true })
  await page.screenshot({ path: path.join(out, 'settings-failure-detail.png') })
  failing = false
  await page.getByRole('button', { name: '重试推送', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已推送到远端' }).waitFor()
  check('再次推送成功时清除旧错误并更新回执', (await page.getByRole('alert').count()) === 0)
  check(
    '新接口收到两次独立推送，没有额外提交',
    fixture.commands.filter((c) => c.endsWith(' push')).length === 2 &&
      !fixture.commands.some((c) => / commit /.test(c)),
  )
  await page.screenshot({ path: path.join(out, 'settings-connected.png') })
  check('设置页面没有浏览器运行错误', errors.length === 0)
  console.log(count + ' 组设置与重试推送浏览器检查通过')
} finally {
  await browser.close()
  await fixture.close()
  await fs.rm(other, { recursive: true, force: true })
}
