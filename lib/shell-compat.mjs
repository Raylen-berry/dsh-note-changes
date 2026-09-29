// Desktop 0.1.7 uses execute(spec) -> handle.result(); older hosts expose run(spec).
// Keep the same resolved command, timeout and sandbox policy on both paths.
export async function runShell(shell, request) {
  if (!shell || typeof shell.resolve !== 'function') throw new Error('Desktop 未提供命令执行服务')
  const spec = await shell.resolve(request)
  if (typeof shell.execute === 'function') {
    const process = await shell.execute(spec)
    if (typeof process?.result !== 'function')
      throw new Error('Desktop 命令接口未返回有效的执行结果')
    return await process.result()
  }
  if (typeof shell.run === 'function') return await shell.run(spec)
  throw new Error('当前 Desktop 命令接口不兼容，请更新笔记插件')
}
