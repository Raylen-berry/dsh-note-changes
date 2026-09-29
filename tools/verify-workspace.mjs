import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fixture } from './fixture-host.mjs'
import { createVaultBrowser, notePath } from '../lib/vault-browser.mjs'
const f = await fixture(),
  browser = createVaultBrowser(f.disk)
let count = 0
async function check(name, fn) {
  await fn()
  count++
  console.log('PASS ' + name)
}
async function request(route, payload, headers = {}) {
  const req = Readable.from([JSON.stringify(payload)])
  req.url = route + '?vault=' + encodeURIComponent(f.vault)
  req.method = 'POST'
  req.headers = headers
  let status, body
  const res = {
    writeHead(s) {
      status = s
    },
    end(s) {
      body = JSON.parse(s)
    },
  }
  await f.routes[route](req, res)
  return { status, body }
}
try {
  await check('目录包含未提交笔记，全文可以搜索', async () => {
    const index = await browser.list(f.vault)
    assert.equal(index.notes.length, 3)
    assert.equal((await browser.list(f.vault, '地铁')).notes[0].path, '想法/灵感花园.md')
    assert.equal(index.notes[0].links.length, 2)
  })
  await check('拒绝目录穿越、绝对路径、隐藏配置、非 Markdown', () => {
    for (const rel of [
      '../private.md',
      '/outside.md',
      'C:/outside.md',
      '.obsidian/workspace.md',
      'x.txt',
    ])
      assert.throws(() => notePath(rel))
  })
  await check('真实目标身份越界时停止读取', async () => {
    const hostile = {
      ...f.disk,
      resolve: async (p) => ({
        displayPath: p,
        targetKey: p.endsWith('outside.md') ? path.resolve(f.vault, '../outside.md') : p,
      }),
    }
    await assert.rejects(createVaultBrowser(hostile).read(f.vault, 'outside.md'), /库外/)
  })
  const rel = '日记/今天.md',
    before = await browser.read(f.vault, rel)
  await check('正常编辑保留 Markdown 与双链并返回新版本', async () => {
    const text = before.text + '\n保留 [[想法/灵感花园]]\n'
    const saved = await browser.save(f.vault, rel, text, before.revision)
    assert.notEqual(saved.revision, before.revision)
    assert.equal((await browser.read(f.vault, rel)).text, text)
  })
  await check('过期编辑不能覆盖磁盘更新', async () => {
    await assert.rejects(
      browser.save(f.vault, rel, '被覆盖', before.revision),
      (e) => e.code === 'CONFLICT',
    )
    assert.match(await fs.readFile(path.join(f.vault, rel), 'utf8'), /保留/)
  })
  await check('保存期间发生外部修改，由文件服务版本再次拦截', async () => {
    let raced = false
    const racing = {
      ...f.disk,
      writeText: async (t, text, expected) => {
        raced = true
        await fs.writeFile(t.targetKey, '外部修改')
        return f.disk.writeText(t, text, expected)
      },
    }
    const current = await browser.read(f.vault, rel)
    await assert.rejects(
      createVaultBrowser(racing).save(f.vault, rel, '覆盖', current.revision),
      (e) => e.code === 'FS_STALE_VERSION',
    )
    assert.ok(raced)
    assert.equal(await fs.readFile(path.join(f.vault, rel), 'utf8'), '外部修改')
  })
  await check('超长笔记只读，不允许把预览截断写回', async () => {
    await fs.writeFile(path.join(f.vault, 'long.md'), '长'.repeat(60001))
    const note = await browser.read(f.vault, 'long.md')
    assert.equal(note.truncated, true)
    await assert.rejects(browser.save(f.vault, 'long.md', note.text, note.revision), /截断/)
    assert.equal((await fs.readFile(path.join(f.vault, 'long.md'), 'utf8')).length, 60001)
  })
  await check('编辑保存必须来自带 JSON 和编辑标记的 POST', async () => {
    const r = await request('/note-changes/save', { path: rel, text: 'bad' })
    assert.equal(r.status, 403)
  })
  await check('跨站保存请求被拒绝', async () => {
    const r = await request(
      '/note-changes/save',
      {},
      {
        'x-dnc-editor': '1',
        'content-type': 'application/json',
        origin: 'http://evil.test',
        host: 'localhost:5000',
      },
    )
    assert.equal(r.status, 403)
  })
  await check('真实路由保存后只提交当前文件', async () => {
    const current = await browser.read(f.vault, rel)
    const r = await request(
      '/note-changes/save',
      { path: rel, text: '# 已保存\n', revision: current.revision },
      { 'x-dnc-editor': '1', 'content-type': 'application/json' },
    )
    assert.equal(r.body.ok, true)
    assert.ok(f.commands.some((c) => c.includes('commit -m "编辑笔记" --only -- "' + rel + '"')))
    assert.match(r.body.sync, /已提交并推送/)
  })
  await check('路由冲突返回 409，不提交旧版本', async () => {
    const n = f.commands.length
    const r = await request(
      '/note-changes/save',
      { path: rel, text: '过期', revision: before.revision },
      { 'x-dnc-editor': '1', 'content-type': 'application/json' },
    )
    assert.equal(r.status, 409)
    assert.equal(f.commands.length, n)
  })
  console.log(`${count} 组工作区测试通过`)
} finally {
  await f.close()
}
