// 反向验证用：生成「故意改坏」的 index.js 变体，用来证明 verify-git-sync.mjs 里的断言
// 真的在测东西，而不是恒真。
//
//   node tools/make-unwired-variant.mjs index.js out.js [wiring|policy]
//     wiring（默认）= 摘掉同步接线   → 第 3 节应当 6 条 FAIL
//     policy        = 摘掉沙箱策略   → 第 5 节应当 2 条 FAIL
//
// 踩过的坑（三处，每一处都会让反向验证变成假阳性）：
//   1. 第一版把 `return await syncAfterWrite({` 换成 `return '' || await syncAfterWrite({`
//      —— `''` 是假值，`||` 继续求值，接线**根本没摘掉**，变体照样 44/44 全绿。
//      摘接线必须整段替换成常量。
//   2. 用 '\n' 拼锚点在某些 checkout 上匹配不到（工作副本是 CRLF）⇒ 这里按实际行尾拼。
//   3. 匹配失败时**报错退出**，绝不静默产出一个等于原文件的"变体"。
import fs from 'node:fs'

const [srcPath, outPath, mode = 'wiring'] = process.argv.slice(2)
const src = fs.readFileSync(srcPath, 'utf8')
const EOL = src.includes('\r\n') ? '\r\n' : '\n'

const VARIANTS = {
  wiring: {
    from: [
      '  /** 写完一个文件后立刻提交推送；附注（成功或失败原因）交给调用方回报，永不抛。 */',
      '  async function syncWrittenFile(vault, rel, message) {',
      '    return await syncAfterWrite({',
      '      runGit: (args, timeoutMs) => runGitIn(vault, args, timeoutMs),',
      '      rel,',
      '      message,',
      '    })',
      '  }',
    ].join(EOL),
    to: [
      '  async function syncWrittenFile(vault, rel, message) {',
      "    return ''   // 反向验证：接线已摘掉",
      '  }',
    ].join(EOL),
  },
  policy: {
    from: '      sandboxPolicy: vaultSandboxPolicy(vault),' + EOL,
    to: '',
  },
}

const variant = VARIANTS[mode]
if (!variant) {
  console.error('未知模式：' + mode + '（可选 ' + Object.keys(VARIANTS).join(' / ') + '）')
  process.exit(2)
}
if (!src.includes(variant.from)) {
  console.error('替换失败：锚点没找到（模式=' + mode + '，工作副本行尾 = ' + (EOL === '\r\n' ? 'CRLF' : 'LF') + '）')
  process.exit(2)
}
const out = src.replace(variant.from, variant.to)
if (out === src) { console.error('替换失败：结果与原文件相同（假变体，反向验证会假阳性）'); process.exit(2) }
fs.writeFileSync(outPath, out, 'utf8')
console.log('变体已生成：' + outPath + '（模式 ' + mode + '）')
