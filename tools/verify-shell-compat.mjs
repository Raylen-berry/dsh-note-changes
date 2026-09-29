import assert from 'node:assert/strict'
import { runShell } from '../lib/shell-compat.mjs'
import { fixture } from './fixture-host.mjs'
import { Readable } from 'node:stream'
let count = 0
async function check(name, fn) {
  await fn()
  console.log('PASS ' + name)
  count++
}
const request = {
  command: 'git push',
  timeoutMs: 60000,
  sandboxPolicy: { mode: 'danger-full-access' },
}
await check('新 Desktop 等待 execute 返回的 result()，不调用旧 run', async () => {
  let done = false
  const expected = { exitCode: 1, stdout: { text: '' }, stderr: { text: 'network detail' } }
  const shell = {
    resolve: (s) => ({ ...s, marker: 1 }),
    run: () => {
      throw new Error('旧接口不应调用')
    },
    execute: async (s) => {
      assert.equal(s.marker, 1)
      assert.equal(s.timeoutMs, 60000)
      assert.deepEqual(s.sandboxPolicy, request.sandboxPolicy)
      return {
        result: async () => {
          await new Promise((r) => setTimeout(r, 5))
          done = true
          return expected
        },
      }
    },
  }
  assert.equal(await runShell(shell, request), expected)
  assert.ok(done)
})
await check('旧 Desktop 继续通过 run 接口工作', async () => {
  const result = { exitCode: 0 }
  assert.equal(
    await runShell(
      {
        resolve: (s) => s,
        run: async (s) => {
          assert.equal(s, request)
          return result
        },
      },
      request,
    ),
    result,
  )
})
await check('新接口执行失败不重复发起命令；缺失接口给出可读错误', async () => {
  let legacy = false
  await assert.rejects(
    runShell(
      {
        resolve: (s) => s,
        execute: async () => {
          throw new Error('启动失败')
        },
        run: () => {
          legacy = true
        },
      },
      request,
    ),
    /启动失败/,
  )
  assert.equal(legacy, false)
  await assert.rejects(runShell({ resolve: (s) => s }, request), /接口不兼容/)
  await assert.rejects(runShell({ resolve: (s) => s, execute: async () => ({}) }, request), /有效/)
})
const f = await fixture({
  shellResult: () => ({
    exitCode: 128,
    stdout: { text: '' },
    stderr: { text: 'fatal: could not resolve host: github.com' },
  }),
})
async function call(route, method = 'GET', params = {}) {
  const req = Readable.from([])
  req.method = method
  req.url = route + '?' + new URLSearchParams({ vault: f.vault, ...params })
  req.headers = {}
  let body
  await f.routes[route](req, {
    writeHead() {},
    end: (s) => {
      body = JSON.parse(s)
    },
  })
  return body
}
try {
  await check('推送失败同时提供 error 和 message，不谎报已提交', async () => {
    const result = await call('/note-changes/sync', 'POST')
    assert.equal(result.ok, false)
    assert.match(result.error, /could not resolve host/)
    assert.equal(result.error, result.message)
    assert.doesNotMatch(result.message, /已本地提交/)
    assert.equal(f.commands.filter((c) => c.endsWith(' push')).length, 1)
  })
  await check('同步回执属于当前笔记库，不串到另一库', async () => {
    assert.equal((await call('/note-changes/settings')).lastSync.ok, false)
    assert.equal(
      (await call('/note-changes/settings', 'GET', { vault: f.vault + '/other' })).lastSync,
      null,
    )
  })
  await check('错误的相对路径不悄悄回退到默认库', async () => {
    const result = await call('/note-changes/library', 'GET', { vault: 'some/relative/path' })
    assert.equal(result.ok, false)
    assert.match(result.error, /绝对路径/)
  })
} finally {
  await f.close()
}
console.log(count + ' 组新旧 Desktop 与同步回执检查通过')
