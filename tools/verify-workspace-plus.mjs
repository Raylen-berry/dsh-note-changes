import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fixture } from './fixture-host.mjs'
import { createVaultBrowser, describeNote, assetPath } from '../lib/vault-browser.mjs'
const f = await fixture(),
  browser = createVaultBrowser(f.disk)
let internals,
  count = 0
vm.runInNewContext(await fs.readFile(new URL('../client.js', import.meta.url), 'utf8'), {
  window: {
    __ModuleLoader__: {
      load: (def) => {
        internals = def.factory(() => ({ createElement() {} })).internals
      },
    },
  },
})
async function check(name, fn) {
  await fn()
  count++
  console.log('PASS ' + name)
}
try {
  await check('增量刷新复用未修改文件，只重读修改项并识别删除', async () => {
    let index = await browser.list(f.vault)
    assert.equal(index.stats.read, 3)
    browser.invalidate()
    index = await browser.list(f.vault)
    assert.deepEqual(index.stats, { read: 0, reused: 3 })
    await fs.appendFile(path.join(f.vault, '日记/今天.md'), '\n#成长\n')
    browser.invalidate()
    index = await browser.list(f.vault)
    assert.deepEqual(index.stats, { read: 1, reused: 2 })
    assert.ok(index.notes.find((n) => n.path === '日记/今天.md').tags.includes('成长'))
    await fs.unlink(path.join(f.vault, '日记/今天.md'))
    browser.invalidate()
    assert.equal((await browser.list(f.vault)).notes.length, 2)
  })
  await check('属性支持单值、内联列表、缩进列表；正文标签排除代码', () => {
    const n = describeNote(
      'a.md',
      '---\ntags: [一, "二,三"]\nstatus: 生长中\naliases:\n  - 夏天\n  - 下雨\n__proto__: 安全\n---\n# 标题\n\n#创作 #灵感/雨天\n`#不计`\n```\n#忽略\n```\n![[photo.png]] [[a]]',
    )
    assert.deepEqual(n.properties.tags, ['一', '二,三'])
    assert.deepEqual(n.properties.aliases, ['夏天', '下雨'])
    assert.deepEqual(n.tags, ['一', '二,三', '创作', '灵感/雨天'])
    assert.deepEqual(n.links, ['a'])
    assert.equal(Object.getPrototypeOf(n.properties), null)
  })
  await check('新建嵌套目录，重复创建和竞争创建都不覆盖已有文件', async () => {
    const rel = '新目录/新笔记.md'
    await browser.create(f.vault, rel, '# 新笔记\n')
    await assert.rejects(browser.create(f.vault, rel, '覆盖'), /已存在/)
    const race = createVaultBrowser({
      ...f.disk,
      writeText: async (t, text, expected, ...rest) => {
        await fs.writeFile(t.targetKey, '别处先创建')
        return f.disk.writeText(t, text, expected, ...rest)
      },
    })
    await assert.rejects(race.create(f.vault, '竞争.md', '覆盖'), (e) => e.code === 'EEXIST')
    assert.equal(await fs.readFile(path.join(f.vault, '竞争.md'), 'utf8'), '别处先创建')
    assert.equal((await browser.read(f.vault, rel)).text, '# 新笔记\n')
  })
  await check('附件索引包含附件目录，读取限于库内白名单并保留字节', async () => {
    await fs.mkdir(path.join(f.vault, '90-附件'))
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
    await fs.writeFile(path.join(f.vault, '90-附件/图.png'), bytes)
    browser.invalidate()
    assert.equal((await browser.list(f.vault)).assets[0].path, '90-附件/图.png')
    assert.deepEqual((await browser.asset(f.vault, '90-附件/图.png')).bytes, bytes)
    for (const p of ['../x.png', 'C:/x.png', '.private/x.png', 'a.html', 'a.svg', 'a.png:secret'])
      assert.throws(() => assetPath(p))
    const hostile = createVaultBrowser({
      ...f.disk,
      resolve: async (p) => ({
        displayPath: p,
        targetKey: p.endsWith('.png') ? path.resolve(f.vault, '../outside.png') : p,
      }),
    })
    await assert.rejects(hostile.asset(f.vault, 'escape.png'), /库外/)
  })
  await check('逐段合并保持未改文字、空行、中文和末尾换行', () => {
    for (const [a, b] of [
      ['', ''],
      ['', '新\n'],
      ['删掉', ''],
      ['# 标题\r\n\r\n磁盘\r\n结尾', '# 标题\r\n\r\n草稿\r\n结尾'],
      ['---\ntags: [a]\n---\n\n🌧\n', '---\ntags: [b]\n---\n\n🌧\n'],
    ]) {
      const sections = internals.mergeSections(a, b),
        disk = {},
        draft = {}
      sections.forEach((s, i) => {
        disk[i] = 'disk'
        draft[i] = 'draft'
      })
      assert.equal(internals.composeMerge(sections, disk), a)
      assert.equal(internals.composeMerge(sections, draft), b)
    }
    const sections = internals.mergeSections('公共\n磁盘\n尾\n', '公共\n草稿\n尾\n')
    assert.throws(() => internals.composeMerge(sections, {}), /未选择/)
    const choices = {}
    sections.forEach((s, i) => (choices[i] = 'both'))
    assert.equal(internals.composeMerge(sections, choices), '公共\n磁盘\n草稿\n尾\n')
    assert.equal(internals.mergeSections('a\n'.repeat(1000), 'b\n'.repeat(1000))[0].large, true)
  })
  await check('关系图不把同名歧义当作明确链接，识别孤立笔记', () => {
    const graph = internals.buildGraph([
      { path: 'a.md', links: ['b', '重复'] },
      { path: 'b.md', links: [] },
      { path: 'x/重复.md', links: [] },
      { path: 'y/重复.md', links: [] },
    ])
    assert.equal(graph.edges.length, 1)
    assert.equal(graph.orphans.length, 2)
    assert.equal(graph.edges[0].to, 'b.md')
  })
  await check('附件解析相对路径、重名和远程地址，不猜测同名文件', () => {
    const assets = [{ path: '90-附件/a.png' }, { path: 'x/a.png' }]
    assert.equal(
      internals.resolveAsset('../90-附件/a.png', '笔记/a.md', assets)[0].path,
      '90-附件/a.png',
    )
    assert.equal(internals.resolveAsset('a.png', '笔记/a.md', assets).length, 2)
    assert.equal(internals.resolveAsset('https://elsewhere/a.png', 'a.md', assets).length, 0)
  })
  console.log(`${count} 组增强功能测试通过`)
} finally {
  await f.close()
}
