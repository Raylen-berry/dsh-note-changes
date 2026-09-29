import http from 'node:http'
import fs from 'node:fs/promises'
import { fixture } from './fixture-host.mjs'
export async function preview(options = {}) {
  const f = await fixture(options),
    reactRoot =
      process.env.DNC_REACT_ROOT || 'D:/DeepSeek/dsh-plugins/dsh-cache-control/node_modules'
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>笔记库 · 工作区预览</title><style>html,body,#app{height:100%;margin:0}body{font-family:system-ui}*{box-sizing:border-box}.frame{height:100%;display:grid;grid-template-columns:72px minmax(0,1fr)}.rail{background:#eeedea;border-right:1px solid #dfdedb;padding:18px 8px;color:#64606d;text-align:center;font-size:11px}.rail button{margin:26px 0;border:0;background:#e0dce9;color:#635183;border-radius:10px;padding:12px;cursor:pointer}#main{height:100%;min-width:0;min-height:0}</style><div id="app"><div class="frame"><aside class="rail">Desktop<button id="entry" title="笔记库"></button>笔记库</aside><div id="main"></div></div></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>var entries={};window.__ModuleLoader__={load:function(def){var plugin=def.factory(function(n){if(n==='react')return React;throw Error(n)});plugin.apply({get:function(n){if(n==='slots')return {inject:function(n,f){return f()},register:function(o,c){entries[o.name+':'+(o.key||o.id)]=c;return function(){}}}},effect:function(f){return f()}});ReactDOM.createRoot(document.getElementById('entry')).render(React.createElement(entries['sidebar.panellist:notes']));window.root=ReactDOM.createRoot(document.getElementById('main'));window.mount=function(){root.render(React.createElement(entries['main:notes']))};mount();document.getElementById('entry').onclick=mount;}};</script><script src="/client.js"></script></html>`
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
