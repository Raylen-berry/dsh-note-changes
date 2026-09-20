// 反向验证用：生成一个「摘掉同步接线」的 index.js 变体，用来证明 verify-git-sync.mjs
// 第 3 节的接线断言真的在测接线，而不是恒真。
//
// 踩过的坑（两处，都让反向验证差点变成假阳性）：
//   1. 第一版把 `return await syncAfterWrite({` 换成 `return '' || await syncAfterWrite({`
//      —— `''` 是假值，`||` 继续求值，接线**根本没摘掉**，变体照样 44/44 全绿。
//      摘接线就必须整段替换成常量。
//   2. 用 '\n' 拼锚点在某些 checkout 上匹配不到（工作副本是 CRLF）⇒ 这里按实际行尾拼，
//      并在匹配失败时**报错退出**，绝不静默产出一个等于原文件的"变体"。
import fs from 'node:fs'

const src = fs.readFileSync(process.argv[2], 'utf8')
const EOL = src.includes('\r\n') ? '\r\n' : '\n'

const TRUTH = [
  '  /** 写完一个文件后立刻提交推送；附注（成功或失败原因）交给调用方回报，永不抛。 */',
  '  async function syncWrittenFile(vault, rel, message) {',
  '    return await syncAfterWrite({',
  '      runGit: (args, timeoutMs) => runGitIn(vault, args, timeoutMs),',
  '      rel,',
  '      message,',
  '    })',
  '  }',
].join(EOL)

const UNWIRED = [
  '  async function syncWrittenFile(vault, rel, message) {',
  "    return ''   // 反向验证：接线已摘掉",
  '  }',
].join(EOL)

if (!src.includes(TRUTH)) {
  console.error('替换失败：锚点没找到（工作副本行尾 = ' + (EOL === '\r\n' ? 'CRLF' : 'LF') + '）')
  process.exit(2)
}
const out = src.replace(TRUTH, UNWIRED)
if (out === src) { console.error('替换失败：结果与原文件相同'); process.exit(2) }
fs.writeFileSync(process.argv[3], out, 'utf8')
console.log('变体已生成：' + process.argv[3])
