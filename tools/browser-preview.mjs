import http from 'node:http'
import fs from 'node:fs/promises'
import { fixture } from './fixture-host.mjs'
export async function preview(options = {}) {
  const f = await fixture(options),
    reactRoot =
      process.env.DNC_REACT_ROOT || 'D:/DeepSeek/dsh-plugins/dsh-cache-control/node_modules'
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>笔记 · 会话插页预览</title><style>html,body,#app{height:100%;margin:0}body{font-family:system-ui;background:var(--dsw-alias-bg-base,#f6f5f2);color:var(--dsw-alias-label-primary,#282a2e)}*{box-sizing:border-box}.frame{height:100%;display:flex;flex-direction:column}.session-header{padding:12px 28px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e4e3df);flex:none}.session-title{font-size:13px;color:var(--dsw-alias-label-secondary,#687079)}.native-tabs{display:flex;gap:30px;margin-top:12px}.native-tabs button{background:transparent;border:0;color:inherit;padding:0 0 10px;font-size:13px;cursor:pointer}.native-tabs button[aria-selected=true]{border-bottom:2px solid #7865ad;color:#7865ad}#main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}</style><div id="app"><div class="frame"><header class="session-header"><div class="session-title">Desktop / 我的会话</div><nav class="native-tabs" role="tablist" aria-label="会话插页"><button role="tab">对话</button><button role="tab">轨迹</button><button role="tab">费用</button><button role="tab" aria-selected="true" id="entry">笔记</button><button role="tab">小游戏</button><button role="tab">Q</button></nav></header><div id="main"></div></div></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>var entries={};window.__ModuleLoader__={load:function(def){var plugin=def.factory(function(n){if(n==='react')return React;throw Error(n)});plugin.apply({get:function(n){if(n==='slots')return {inject:function(n,f){return f()},register:function(o,c){entries[o.name+':'+(o.key||o.id)]=c;return function(){}}}},effect:function(f){return f()}});window.root=ReactDOM.createRoot(document.getElementById('main'));window.mount=function(){root.render(React.createElement(entries['conversation.view:note-workspace']))};mount();document.querySelectorAll('[role=tab]').forEach(function(button){button.onclick=function(){document.querySelectorAll('[role=tab]').forEach(function(b){b.setAttribute('aria-selected',String(b===button))});if(button.id==='entry')mount();else root.render(React.createElement('div',null,button.textContent+'内容'))}});}};</script><script src="/client.js"></script></html>`

  const server = http.createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname
      if (f.routes[route]) return await f.routes[route](req, res)
      const file =
        route === '/client.js'
          ? new URL('../client.js', import.meta.url)
          : route === '/react.js'
            ? reactRoot + '/react/umd/react.development.js'
            : route === '/react-dom.js'
              ? reactRoot + '/react-dom/umd/react-dom.development.js'
              : null
      res.writeHead(200, {
        'content-type': file ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      })
      res.end(file ? await fs.readFile(file) : html)
    } catch (e) {
      res.writeHead(500)
      res.end(e.message)
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    ...f,
    origin: 'http://127.0.0.1:' + server.address().port,
    close: async () => {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
      await f.close()
    },
  }
}
if (process.argv.includes('--serve')) {
  const p = await preview()
  console.log(p.origin)
  process.on('SIGINT', async () => {
    await p.close()
    process.exit()
  })
}
