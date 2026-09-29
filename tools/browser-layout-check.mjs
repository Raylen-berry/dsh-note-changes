import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { preview } from './browser-preview.mjs'
const { chromium } = await import(pathToFileURL(process.env.DNC_PLAYWRIGHT_MODULE ||
  'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'))
const fixture = await preview()
const browser = await chromium.launch({ headless: true, channel: process.env.DNC_BROWSER || 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 850 } })
const out = process.env.DNC_SCREENSHOTS || 'D:/ChatGPT/_runs/notes-layout-20260929'
let checks = 0
const check = (label, value) => { assert.ok(value, label); console.log('PASS ' + label); checks++ }
try {
  await fs.mkdir(out, { recursive: true })
  await fs.mkdir(path.join(fixture.vault, '长列表'))
  for (let i = 0; i < 70; i++) {
    await fs.writeFile(path.join(fixture.vault, `长列表/笔记${String(i).padStart(2, '0')}.md`), '# 一页笔记\n\n[[00-索引/欢迎]]')
  }
  await fs.appendFile(path.join(fixture.vault, '00-索引/欢迎.md'), Array.from({ length: 60 }, (_, i) =>
    `\n## 长文段落 ${i + 1}\n\n这一段用来检查正文独立滚动。\n\n[[长列表/笔记${String(i).padStart(2, '0')}]]\n`).join(''))
  await page.goto(fixture.origin)
  await page.getByRole('heading', { name: '给想法留一盏灯' }).waitFor()
  // Reproduce Desktop's resident scrollport and active-view flex sizing.
  // The composer remains mounted after the view; changing tabs must restore normal scrolling.
  await page.evaluate(() => {
    const main = document.getElementById('main')
    const scroll = document.createElement('div')
    scroll.dataset.conversationScroll = ''
    scroll.className = 'native-scroll'
    const session = document.createElement('div')
    session.dataset.slot = 'conversation.session'
    const view = document.createElement('div')
    view.className = 'native-view'
    main.dataset.slot = 'conversation.view'
    main.parentNode.appendChild(scroll)
    scroll.appendChild(session)
    session.appendChild(view)
    view.appendChild(main)
    const composer = document.createElement('div')
    composer.style.cssText = 'height:100px;flex:none'
    composer.dataset.composerSeat = ''
    scroll.appendChild(composer)
    const style = document.createElement('style')
    style.textContent = '.native-scroll{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto}.native-view{display:flex;flex-direction:column;flex:1 0 auto;min-height:auto}'
    document.head.appendChild(style)
  })
  const searchTop = (await page.getByRole('searchbox', { name: '搜索笔记' }).boundingBox()).y
  await page.getByRole('region', { name: '笔记列表', exact: true }).hover()
  await page.mouse.wheel(0, 1400)
  await page.waitForFunction(() => document.querySelector('.dnc-filelist').scrollTop > 0)
  check('长目录只滚动文件列表，搜索框固定', Math.abs((await page.getByRole('searchbox', { name: '搜索笔记' }).boundingBox()).y - searchTop) < 1)
  for (const name of ['本篇大纲列表', '出站链接列表', '反向链接列表']) {
    const list = page.getByRole('region', { name, exact: true })
    await list.hover()
    await page.mouse.wheel(0, 1200)
    await page.waitForFunction((label) => document.querySelector(`[aria-label="${label}"]`).scrollTop > 0, name)
  }
  check('左右栏框架和外层页面都不滚动', await page.evaluate(() =>
    ['.dnc-left', '.dnc-right', '[data-conversation-scroll]'].every((selector) => {
      const e = document.querySelector(selector)
      return e.scrollTop === 0 && e.scrollHeight <= e.clientHeight + 1
    })))
  await page.locator('.dnc-scroll').hover()
  await page.mouse.wheel(0, 1500)
  await page.waitForFunction(() => document.querySelector('.dnc-scroll').scrollTop > 0)
  check('正文独立滚动，侧栏位置保持不变', Math.abs((await page.getByRole('searchbox', { name: '搜索笔记' }).boundingBox()).y - searchTop) < 1)
  await page.screenshot({ path: path.join(out, 'notes-fixed-sidebars.png') })
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  check('编辑器限制在正文区，页脚仍可见', await page.locator('.dnc-footer').evaluate(e => e.getBoundingClientRect().bottom <= innerHeight))
  await page.setViewportSize({ width: 600, height: 820 })
  await page.getByRole('button', { name: '目录与搜索' }).click()
  check('窄屏目录列表仍有可用空间', await page.locator('.dnc-filelist').evaluate(e => e.clientHeight >= 40))
  check('窄屏不产生外层横向或纵向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight))
  await page.screenshot({ path: path.join(out, 'notes-fixed-sidebars-narrow.png') })
  await page.getByRole('tab', { name: '对话', exact: true }).click()
  check('离开笔记后恢复 Desktop 原有滚动规则', await page.locator('[data-conversation-scroll]').evaluate(e => getComputedStyle(e).overflowY === 'auto'))
  console.log(checks + ' 组侧栏与原生容器布局检查通过')
} finally {
  await browser.close()
  await fixture.close()
}
