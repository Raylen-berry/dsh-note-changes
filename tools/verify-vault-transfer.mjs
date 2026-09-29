import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { vaultSyncState, transferVault } from '../lib/vault-sync.mjs'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnc-transfer-'))
const remote = path.join(dir, 'remote.git'),
  work = path.join(dir, 'work'),
  home = path.join(dir, 'home')
const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const run = (cwd) => async (args) => {
  try {
    return {
      code: 0,
      stdout: git(
        cwd,
        args.map((a) => a.replaceAll('"', '')),
      ),
    }
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout), stderr: String(e.stderr) }
  }
}
const write = (cwd, p, text) => {
  fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true })
  fs.writeFileSync(path.join(cwd, p), text)
}
let count = 0
const check = (label, fn) => {
  fn()
  count++
  console.log('PASS ' + label)
}
const reject = async (label, fn, re) => {
  await assert.rejects(fn, re)
  count++
  console.log('PASS ' + label)
}
try {
  git(dir, ['init', '--bare', remote])
  git(dir, ['clone', remote, work])
  git(work, ['checkout', '-b', 'main'])
  for (const cwd of [work]) {
    git(cwd, ['config', 'user.name', 'Sync Test'])
    git(cwd, ['config', 'user.email', 'test@example.invalid'])
  }
  write(work, '日记.md', '# 日记\nfirst\n')
  write(work, 'private.txt', 'original')
  write(work, '.gitignore', 'ignored.md\n')
  git(work, ['add', '.'])
  git(work, ['commit', '-m', 'seed'])
  git(work, ['push', '-u', 'origin', 'main'])
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['clone', remote, home])
  git(home, ['config', 'user.name', 'Sync Test'])
  git(home, ['config', 'user.email', 'test@example.invalid'])
  write(work, '想法/新笔记 [一].md', 'work note')
  write(work, '附件/image.png', 'fixture image')
  write(work, '.obsidian/private.md', 'local only')
  write(work, 'ignored.md', 'ignored')
  write(work, 'private-new.txt', 'local only')
  await transferVault(run(work), work, 'upload')
  await transferVault(run(home), home, 'download')
  check('工作电脑新笔记和附件上传后，家里下载可见', () => {
    assert.equal(fs.readFileSync(path.join(home, '想法/新笔记 [一].md'), 'utf8'), 'work note')
    assert.ok(fs.existsSync(path.join(home, '附件/image.png')))
  })
  check('隐藏目录、忽略文件、非笔记文件未上传', () => {
    for (const f of ['.obsidian/private.md', 'ignored.md', 'private-new.txt'])
      assert.equal(fs.existsSync(path.join(home, f)), false)
  })
  write(home, '回家写的.md', 'from home')
  await reject('下载不覆盖未提交笔记', () => transferVault(run(home), home, 'download'), /先上传/)
  await transferVault(run(home), home, 'upload')
  await transferVault(run(work), work, 'download')
  check('家里上传后，工作电脑收到更新', () =>
    assert.equal(fs.readFileSync(path.join(work, '回家写的.md'), 'utf8'), 'from home'),
  )
  check('下载不会被本机未追踪配置阻塞，也不会删除配置', () =>
    assert.equal(fs.readFileSync(path.join(work, '.obsidian/private.md'), 'utf8'), 'local only'),
  )
  write(work, '日记.md', '# 日记\nwork edit\n')
  write(home, '不同内容.md', 'independent')
  await transferVault(run(home), home, 'upload')
  await transferVault(run(work), work, 'upload')
  check('不同文件的远端更新可与本机笔记合并', () =>
    assert.equal(fs.readFileSync(path.join(work, '不同内容.md'), 'utf8'), 'independent'),
  )
  await transferVault(run(home), home, 'download')
  write(home, '日记.md', '# 日记\nhome collision\n')
  await transferVault(run(home), home, 'upload')
  write(work, '日记.md', '# 日记\nwork collision\n')
  await reject(
    '同一行冲突中止同步并恢复本机提交',
    () => transferVault(run(work), work, 'upload'),
    /已恢复本机提交/,
  )
  check('冲突后工作电脑和远端各自内容完整', () => {
    assert.match(fs.readFileSync(path.join(work, '日记.md'), 'utf8'), /work collision/)
    assert.match(git(remote, ['show', 'main:日记.md']), /home collision/)
    assert.equal(fs.existsSync(path.join(work, '.git/rebase-merge')), false)
  })
  // Work on the clean home clone for file-scope checks.
  write(home, 'private.txt', 'staged unrelated')
  git(home, ['add', 'private.txt'])
  write(home, 'another.md', 'new')
  await reject(
    '其他类型的已暂存改动不会混进笔记上传',
    () => transferVault(run(home), home, 'upload'),
    /范围外/,
  )
  check('暂存内容保持原样', () =>
    assert.equal(git(home, ['diff', '--cached', '--name-only']).trim(), 'private.txt'),
  )
  git(home, ['restore', '--staged', 'private.txt'])
  git(home, ['restore', 'private.txt'])
  fs.rmSync(path.join(home, '附件/image.png'))
  await transferVault(run(home), home, 'upload')
  check('已有笔记附件的删除随笔记同步', () =>
    assert.doesNotMatch(git(remote, ['ls-tree', '-r', '--name-only', 'main']), /image.png/),
  )
  fs.mkdirSync(path.join(home, 'sub'))
  await reject(
    '拒绝把上层项目当作笔记库上传',
    () => vaultSyncState(run(path.join(home, 'sub')), path.join(home, 'sub')),
    /根目录/,
  )
  write(home, 'broken.md', 'keep locally')
  git(home, ['remote', 'set-url', 'origin', path.join(dir, 'missing.git')])
  await reject(
    '网络或远端失败时保留新笔记',
    () => transferVault(run(home), home, 'upload'),
    /repository|仓库/,
  )
  check('失败时未创建额外提交，内容保留', () => {
    assert.equal(fs.readFileSync(path.join(home, 'broken.md'), 'utf8'), 'keep locally')
    assert.match(git(home, ['status', '--porcelain']), /broken.md/)
  })
  console.log(count + ' 组真实双电脑 Git 同步检查通过')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
