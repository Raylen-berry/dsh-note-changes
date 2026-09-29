import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { apply } from '../index.js'
export const hash = (text) => createHash('sha256').update(text).digest('hex')
async function canonical(p) {
  try {
    return await fs.realpath(p)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(p)
    if (parent === p) throw error
    return path.join(await canonical(parent), path.basename(p))
  }
}
export async function fixture(options = {}) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'dnc-workspace-')),
    routes = {},
    commands = []
  const previousVault = process.env.DNC_VAULT
  process.env.DNC_VAULT = vault
  const disk = {
    resolve: async (p) => ({ displayPath: p, targetKey: await canonical(p) }),
    stat: async (t) => {
      try {
        const s = await fs.stat(t.targetKey)
        return {
          type: s.isDirectory() ? 'directory' : 'file',
          size: s.size,
          version: s.isDirectory() ? 'dir' : hash(await fs.readFile(t.targetKey)),
        }
      } catch (e) {
        if (e.code === 'ENOENT') return null
        throw e
      }
    },
    readText: (t) => fs.readFile(t.targetKey, 'utf8'),
    readBytes: (t) => fs.readFile(t.targetKey),
    listDir: async (t) =>
      Promise.all(
        (await fs.readdir(t.targetKey, { withFileTypes: true })).map(async (e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          target: await disk.resolve(path.join(t.targetKey, e.name)),
          size: e.isDirectory() ? 0 : (await fs.stat(path.join(t.targetKey, e.name))).size,
          version: e.isDirectory()
            ? 'dir'
            : hash(await fs.readFile(path.join(t.targetKey, e.name))),
        })),
      ),
    writeText: async (t, text, expected) => {
      if (expected?.version !== undefined && (await disk.stat(t))?.version !== expected.version) {
        const e = new Error('文件已更新')
        e.code = 'FS_STALE_VERSION'
        throw e
      }
      await fs.mkdir(path.dirname(t.targetKey), { recursive: true })
      await fs.writeFile(t.targetKey, text, {
        flag: expected?.kind === 'createIfAbsent' ? 'wx' : 'w',
      })
    },
  }
  await fs.mkdir(path.join(vault, '日记'))
  await fs.mkdir(path.join(vault, '想法'))
  await fs.mkdir(path.join(vault, '00-索引'))
  const samples = {
    '00-索引/欢迎.md':
      '---\ntags: [笔记, 创作]\n---\n# 给想法留一盏灯\n\n这里是你的笔记库。零散的念头，也值得有自己的位置。\n\n## 今天，从一页开始\n\n- 阅读 [[想法/灵感花园|灵感花园]]\n- 在 [[日记/今天]] 留下今天的片段\n\n> 先把想法记下来，让联系慢慢长出来。\n\n## 写作约定\n\n**用自己的话**，把一件小事说清楚。\n\n| 入口 | 可以做什么 |\n| --- | --- |\n| 搜索 | 找到正文中的关键词 |\n| 双链 | 沿着一个念头走下去 |\n',
    '想法/灵感花园.md':
      '# 灵感花园\n\n把意外的联系保存下来。\n\n## 雨天的颜色\n\n地铁窗上的雨像一张正在写的地图。\n\n[[00-索引/欢迎|回到索引]]\n',
    '日记/今天.md':
      '# 今天\n\n- [x] 整理一页笔记\n- [ ] 去散步\n\n今天想到一个词：留白。\n\n[[想法/灵感花园]]\n',
  }
  for (const [p, text] of Object.entries(samples)) await fs.writeFile(path.join(vault, p), text)
  const context = {
    get(name) {
      if (name === 'fs') return disk
      if (name === 'webServer')
        return {
          register(r) {
            routes[r.path] = r.handler
            return () => {}
          },
        }
      if (name === 'shell')
        return (
          options.shell || {
            resolve: (s) => s,
            execute: async (s) => {
              commands.push(s.command)
              return {
                result: async () =>
                  options.shellResult
                    ? options.shellResult(s)
                    : {
                        exitCode: 0,
                        stdout: {
                          text: s.command.includes(' log ')
                            ? 'commit 0123456789012345678901234567890123456789\nAuthor: Local\nDate:   2026-09-29\n\n    整理了今天的灵感\n\n想法/灵感花园.md\n日记/今天.md\n'
                            : 'true',
                        },
                        stderr: { text: '' },
                      },
              }
            },
          }
        )
    },
    effect(fn) {
      return fn()
    },
    tools: {
      register() {
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  await apply(context)
  return {
    vault,
    routes,
    disk,
    commands,
    close: async () => {
      if (previousVault === undefined) delete process.env.DNC_VAULT
      else process.env.DNC_VAULT = previousVault
      await fs.rm(vault, { recursive: true, force: true })
    },
  }
}
