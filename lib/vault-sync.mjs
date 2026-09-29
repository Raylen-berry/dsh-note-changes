import fs from 'node:fs/promises'
import path from 'node:path'

const quote = (value) => {
  if (/["`$%\r\n\0]/.test(value)) throw new Error('文件名或 Git 配置含特殊字符，请在 Git 中同步')
  return '"' + value + '"'
}
const detail = (r) =>
  String(r.stderr || r.stdout || 'Git 未返回结果')
    .replace(/https?:\/\/[^\s/@]+@/g, 'https://[已隐藏]@')
    .trim()
    .slice(0, 500)
async function checked(run, args, network = false) {
  const r = await run(args, network ? 60000 : 20000, network ? 'network' : undefined)
  if (r.code !== 0) throw new Error(detail(r))
  return r.stdout || ''
}
const eligible = (p) =>
  !p.split('/').some((s) => s.startsWith('.') || s === 'node_modules') &&
  !/^(?:AGENTS|SKILL)\.md$/i.test(p) &&
  /\.(?:md|png|jpe?g|gif|webp|svg|avif|mp3|m4a|wav|ogg|mp4|webm|pdf)$/i.test(p)

export async function vaultSyncState(run, vault) {
  const root = (await checked(run, ['rev-parse', '--show-toplevel'])).trim()
  if ((await fs.realpath(root)) !== (await fs.realpath(vault)))
    throw new Error('请选择 Git 仓库根目录作为笔记库，避免同步到上层项目')
  const branch = (await checked(run, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
  const remoteName = (
    await checked(run, ['config', '--get', quote('branch.' + branch + '.remote')])
  ).trim()
  if (!remoteName || remoteName === '.')
    throw new Error('尚未关联远端笔记库，请先克隆你的 GitHub 笔记仓库')
  const remote = (await checked(run, ['remote', 'get-url', quote(remoteName)])).trim()
  const upstream = (
    await checked(run, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '"@{upstream}"'])
  ).trim()
  const counts = (
    await checked(run, ['rev-list', '--left-right', '--count', 'HEAD..."@{upstream}"'])
  )
    .trim()
    .split(/\s+/)
    .map(Number)
  const raw = await checked(run, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ])
  if (raw.length > 150000 || (raw && !raw.endsWith('\0')))
    throw new Error('改动列表过大或读取不完整，请先在 Git 中整理后再同步')
  const changes = []
  for (const entry of raw.split('\0').filter(Boolean)) {
    const status = entry.slice(0, 2),
      file = entry.slice(3)
    let reason = eligible(file) ? '' : '不在笔记同步范围'
    if (!reason && /["`$%\r\n\0]/.test(file)) reason = '文件名含特殊字符'
    const target = path.resolve(vault, file)
    if (!target.startsWith(path.resolve(vault) + path.sep)) reason = '路径越界'
    if (!reason && !status.includes('D')) {
      const stat = await fs.lstat(target)
      const real = await fs.realpath(target)
      if (!stat.isFile() || !real.startsWith((await fs.realpath(vault)) + path.sep))
        reason = '链接或非普通文件'
      else if (stat.size > 20 * 1024 * 1024) reason = '超过 20 MB'
    }
    changes.push({ path: file, status, reason, included: !reason })
  }
  return {
    branch,
    remoteName,
    remote: remote.replace(/(https?:\/\/)[^/@]+@/g, '$1[已隐藏]@'),
    upstream,
    ahead: counts[0],
    behind: counts[1],
    changes,
    pending: changes.filter((c) => c.included).length,
    conflicted: changes.some((c) => /U|AA|DD/.test(c.status)),
  }
}

/** Only explicit upload stages notes. Download never commits, stashes or discards local changes. */
export async function transferVault(run, vault, direction) {
  if (!['upload', 'download'].includes(direction)) throw new Error('未知同步方向')
  let state = await vaultSyncState(run, vault)
  for (const marker of [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
  ]) {
    const markerPath = (await checked(run, ['rev-parse', '--git-path', marker])).trim()
    try {
      await fs.access(path.resolve(vault, markerPath))
    } catch {
      continue
    }
    throw new Error('Git 有尚未完成的合并或变基，请先处理后再同步')
  }
  if (state.conflicted) throw new Error('本机还有 Git 冲突，请先处理后再同步')
  const tracked = state.changes.filter((c) => c.status !== '??')
  if (direction === 'download' && (tracked.length || state.pending))
    throw new Error(
      '本机有尚未提交的文件，请先上传笔记；同步范围外的改动请先在 Git 中处理。未覆盖任何本机内容。',
    )
  if (direction === 'upload' && tracked.some((c) => !c.included))
    throw new Error('有同步范围外的已跟踪文件被修改，请先在 Git 中处理，再上传笔记')
  const files = state.changes.filter((c) => c.included).map((c) => quote(c.path))
  if (files.join(' ').length > 14000 || files.length > 500)
    throw new Error('本次改动过多，请分批在 Git 中提交后再上传')
  // Confirm network access before creating a commit; no automatic stash is ever used.
  await checked(run, ['fetch', '--prune', quote(state.remoteName)], true)
  if (direction === 'upload' && files.length) {
    await checked(run, ['--literal-pathspecs', 'add', '-A', '--', ...files])
    await checked(run, [
      '--literal-pathspecs',
      'commit',
      '-m',
      '"同步本机笔记"',
      '--only',
      '--',
      ...files,
    ])
  }
  state = await vaultSyncState(run, vault)
  if (state.behind) {
    const args = state.ahead
      ? ['-c', 'rebase.autoStash=false', 'rebase', '--no-autostash', '"@{upstream}"']
      : ['merge', '--ff-only', '"@{upstream}"']
    const result = await run(args, 20000)
    if (result.code !== 0) {
      if (state.ahead) {
        const conflicts = await run(['diff', '--name-only', '--diff-filter=U'], 20000)
        const abort = await run(['rebase', '--abort'], 20000)
        if (abort.code !== 0)
          throw new Error('合并未完成，自动恢复也失败，请在 Git 中处理：' + detail(abort))
        throw new Error(
          '两台电脑的改动无法自动合并；已恢复本机提交，未上传覆盖远端。' +
            (conflicts.stdout?.trim()
              ? '冲突文件：' + conflicts.stdout.trim().slice(0, 300)
              : detail(result)),
        )
      }
      throw new Error('下载未完成，本机内容保留：' + detail(result))
    }
  }
  if (direction === 'upload') {
    // Explicit destination, no reliance on push.default or pushRemote redirecting to another repo.
    const mergeRef = (
      await checked(run, ['config', '--get', quote('branch.' + state.branch + '.merge')])
    ).trim()
    if (!mergeRef.startsWith('refs/heads/')) throw new Error('远端分支配置无效')
    await checked(run, ['push', quote(state.remoteName), quote('HEAD:' + mergeRef)], true)
  }
  return {
    ok: true,
    message:
      direction === 'upload'
        ? '已上传笔记到远端，两台电脑可接着同步'
        : '已下载远端更新，本机笔记已刷新',
    state: await vaultSyncState(run, vault),
  }
}
