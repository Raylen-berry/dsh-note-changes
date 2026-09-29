import path from 'node:path'
import { createHash } from 'node:crypto'

export const NOTE_LIMIT = 60000
const FILE_LIMIT = 2000,
  BYTE_LIMIT = 8 * 1024 * 1024
const revision = (text) => createHash('sha256').update(text).digest('hex')
const identity = (target) =>
  typeof target === 'string' ? target : String(target.targetKey || target.displayPath)
const paths = (root) => (/^[a-z]:[\\/]/i.test(root) ? path.win32 : path.posix)
function inside(root, target) {
  const relative = paths(root).relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith('..' + paths(root).sep) &&
      relative !== '..' &&
      !paths(root).isAbsolute(relative))
  )
}
export function notePath(value) {
  const rel = String(value || '').replace(/\\/g, '/')
  if (rel.split('/').includes('..')) throw new Error('路径不允许包含 ..')
  if (
    !rel ||
    !/\.md$/i.test(rel) ||
    rel.split('/').some((p) => !p || p === '..' || p.startsWith('.')) ||
    /[:\x00-\x1f]/.test(rel)
  )
    throw new Error('只能操作笔记库内的 Markdown 文件')
  return rel
}
const MEDIA = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
}
export function assetPath(value) {
  const rel = String(value || '').replace(/\\/g, '/')
  if (
    rel.split('/').some((p) => !p || p.startsWith('.')) ||
    /[:\x00-\x1f]/.test(rel) ||
    !MEDIA[rel.split('.').pop().toLowerCase()]
  )
    throw new Error('不支持的附件路径或格式')
  return rel
}
async function targetIn(fs, vault, rel, validate = notePath) {
  const root = await fs.resolve(vault),
    target = await fs.resolve(vault.replace(/[\\/]+$/, '') + '/' + validate(rel))
  if (!inside(identity(root), identity(target))) throw new Error('笔记路径指向库外，已停止访问')
  return target
}
export function describeNote(rel, text) {
  const properties = Object.create(null)
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] || ''
  const scalar = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2')
  let currentKey = ''
  for (const line of front.split(/\r?\n/)) {
    const pair = /^([^\s:#][^:]*):\s*(.*?)\s*$/.exec(line)
    if (pair) {
      currentKey = pair[1].trim()
      const value = pair[2]
      if (/^[>|&*!{]/.test(value)) {
        currentKey = ''
        continue
      }
      properties[currentKey] =
        value.startsWith('[') && value.endsWith(']')
          ? (value.slice(1, -1).match(/"[^"]*"|'[^']*'|[^,'"\s][^,]*/g) || []).map(scalar)
          : value
            ? [scalar(value)]
            : []
    } else {
      const item = /^\s+-\s+(.+)$/.exec(line)
      if (item && currentKey) properties[currentKey].push(scalar(item[1]))
      else if (line.trim() && !line.trim().startsWith('#')) currentKey = ''
    }
  }
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
  const prose = body.replace(/^(?:```|~~~)[\s\S]*?^(?:```|~~~).*$/gm, '')
  const headings = [...prose.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({
    level: m[1].length,
    text: m[2],
  }))
  const title =
    headings.find((h) => h.level === 1)?.text || rel.split('/').pop().replace(/\.md$/i, '')
  const links = [
    ...new Set([...prose.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]/g)].map((m) => m[1].split('|')[0])),
  ]
  return {
    path: rel,
    title,
    headings,
    links,
    properties,
    tags: [
      ...new Set(
        [
          ...(properties.tags || []),
          ...(properties.tag || []),
          ...[
            ...prose
              .replace(/`[^`\n]*`/g, '')
              .matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)(?=\s|$|[.,，。!?！？])/gu),
          ].map((m) => m[1]),
        ]
          .map((t) => t.replace(/^#/, ''))
          .filter(Boolean),
      ),
    ],
    excerpt: body
      .replace(/[#*`\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
  }
}

// Filesystem access stays on the host service, including versioned atomic writes.
export function createVaultBrowser(fs) {
  let cached = null,
    pending = null,
    generation = 0,
    files = new Map(),
    fileVault = ''
  function invalidate() {
    generation++
    cached = null
    pending = null
  }
  async function read(vault, rel) {
    rel = notePath(rel)
    const target = await targetIn(fs, vault, rel),
      info = await fs.stat(target)
    if (!info || (info.type && info.type !== 'file')) throw new Error('笔记不存在')
    if (info.size > 1024 * 1024) throw new Error('这篇笔记超过 1 MB，请在 Obsidian 中打开')
    const raw = String((await fs.readText(target)) || '')
    return {
      ...describeNote(rel, raw),
      text: raw.slice(0, NOTE_LIMIT),
      revision: revision(raw),
      truncated: raw.length > NOTE_LIMIT,
    }
  }
  async function scan(vault) {
    if (cached?.vault === vault && Date.now() - cached.at < 5000) return cached
    if (pending?.vault === vault) return pending.promise
    const currentGeneration = generation
    const promise = (async () => {
      if (typeof fs.listDir !== 'function')
        throw new Error('当前 Desktop 未提供目录读取接口，请更新 Desktop')
      const root = await fs.resolve(vault),
        rootKey = identity(root),
        visited = new Set(),
        notes = [],
        assets = [],
        nextFiles = new Map(),
        stats = { read: 0, reused: 0 },
        warnings = []
      const previousFiles = fileVault === vault ? files : new Map()
      let bytes = 0,
        directories = 0,
        partial = false
      async function walk(target, prefix, depth) {
        if (!inside(rootKey, identity(target)) || visited.has(identity(target))) return
        if (depth > 16 || ++directories > 500 || notes.length >= FILE_LIMIT) {
          partial = true
          return
        }
        visited.add(identity(target))
        for (const entry of await fs.listDir(target)) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          const rel = prefix + entry.name
          const child = entry.target || (await fs.resolve(vault + '/' + rel))
          if (!inside(rootKey, identity(child))) {
            warnings.push('跳过库外链接：' + rel)
            continue
          }
          if (entry.type === 'directory') {
            await walk(child, rel + '/', depth + 1)
            continue
          }
          if (entry.type !== 'file') continue
          if (!/\.md$/i.test(rel)) {
            if (MEDIA[rel.split('.').pop().toLowerCase()]) {
              if (assets.length < FILE_LIMIT)
                assets.push({
                  path: rel,
                  size: entry.size,
                  mime: MEDIA[rel.split('.').pop().toLowerCase()],
                })
              else partial = true
            }
            continue
          }
          if (notes.length >= FILE_LIMIT) {
            partial = true
            break
          }
          try {
            notePath(rel)
            const info = entry.version !== undefined ? entry : await fs.stat(child)
            const previous = previousFiles.get(rel)
            let text = '',
              indexed = info?.size <= 512 * 1024 && bytes + (info.size || 0) <= BYTE_LIMIT
            if (indexed && info.version !== undefined && previous?.version === info.version) {
              bytes += previous.bytes
              stats.reused++
              notes.push(previous.note)
              nextFiles.set(rel, previous)
              continue
            }
            if (indexed) {
              text = String((await fs.readText(child)) || '')
              bytes += Buffer.byteLength(text)
              stats.read++
            } else partial = true
            const item = {
              ...describeNote(rel, text),
              indexed,
              search: (rel + '\n' + text).toLowerCase(),
            }
            notes.push(item)
            if (indexed && info.version !== undefined)
              nextFiles.set(rel, {
                version: info.version,
                bytes: Buffer.byteLength(text),
                note: item,
              })
          } catch (error) {
            warnings.push(rel + '：' + error.message)
          }
        }
      }
      await walk(root, '', 0)
      notes.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
      const result = {
        vault,
        at: Date.now(),
        notes,
        assets,
        stats,
        partial,
        warnings: warnings.slice(0, 10),
      }
      if (currentGeneration === generation) {
        cached = result
        files = nextFiles
        fileVault = vault
      }
      return result
    })()
    pending = { vault, promise }
    try {
      return await promise
    } finally {
      if (pending?.promise === promise) pending = null
    }
  }
  async function list(vault, query = '') {
    const index = await scan(vault),
      terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return {
      ...index,
      total: index.notes.length,
      notes: index.notes
        .filter((n) => terms.every((t) => n.search.includes(t)))
        .map(({ search, ...note }) => note),
    }
  }
  async function save(vault, rel, text, expectedRevision) {
    rel = notePath(rel)
    if (typeof text !== 'string' || text.length > NOTE_LIMIT)
      throw new Error('正文超过编辑上限，请在 Obsidian 中编辑')
    const target = await targetIn(fs, vault, rel),
      info = await fs.stat(target)
    if (!info || (info.type && info.type !== 'file'))
      throw new Error('笔记已被移动或删除，请刷新目录')
    if (info.size > 1024 * 1024) throw new Error('文件已变大，请重新打开')
    const current = String((await fs.readText(target)) || '')
    if (current.length > NOTE_LIMIT)
      throw new Error('这篇笔记只有截断预览，请在 Obsidian 中编辑完整正文')
    if (!expectedRevision || revision(current) !== expectedRevision) {
      const error = new Error('这篇笔记已在别处修改。你的草稿仍保留，请对照合并后再保存。')
      error.code = 'CONFLICT'
      throw error
    }
    if (current === text) return { revision: expectedRevision, changed: false }
    if (info.version === undefined)
      throw new Error('当前文件服务不支持版本保护，请在 Obsidian 中编辑')
    await fs.writeText(
      target,
      text,
      { kind: 'replaceIfVersion', version: info.version },
      undefined,
      { mode: 'workspace-write', workspaceRoot: vault },
    )
    invalidate()
    return { revision: revision(text), changed: true }
  }
  async function create(vault, rel, text) {
    rel = notePath(rel)
    if (typeof text !== 'string' || text.length > NOTE_LIMIT) throw new Error('新笔记正文超过上限')
    const target = await targetIn(fs, vault, rel)
    if (await fs.stat(target)) {
      const error = new Error('同名笔记已存在，请打开已有笔记或换个名字')
      error.code = 'EXISTS'
      throw error
    }
    await fs.writeText(target, text, { kind: 'createIfAbsent' }, undefined, {
      mode: 'workspace-write',
      workspaceRoot: vault,
    })
    invalidate()
    return { path: rel, revision: revision(text), changed: true }
  }
  async function asset(vault, rel) {
    rel = assetPath(rel)
    const target = await targetIn(fs, vault, rel, assetPath),
      info = await fs.stat(target)
    if (!info || info.type !== 'file') throw new Error('附件不存在')
    if (info.size > 20 * 1024 * 1024) throw new Error('附件超过 20 MB，请在 Obsidian 中打开')
    if (typeof fs.readBytes !== 'function') throw new Error('当前 Desktop 不支持附件读取')
    const bytes = await fs.readBytes(target, undefined, 20 * 1024 * 1024)
    return { bytes: Buffer.from(bytes), mime: MEDIA[rel.split('.').pop().toLowerCase()] }
  }
  return { list, read, save, create, asset, invalidate }
}
