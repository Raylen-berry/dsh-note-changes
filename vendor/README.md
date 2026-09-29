# 本地公式资源

`katex/` 是 npm 官方仓库 `katex@0.18.9` 的浏览器发行文件、字体与 MIT 许可证，未改动资源内容。下载使用 `npm pack katex@0.18.9 --ignore-scripts --registry https://registry.npmjs.org`，只提取 dist/katex.min.js、dist/katex.min.css、dist/fonts 与 LICENSE。

包 SHA-1：`60d720d8cc87a2267096785070e4210b39957bda`。

宿主只允许白名单资源路径，发送 CSS 时把字体地址改为同源资源路由。前端按需加载，没有 CDN 请求。公式设置 `trust: false`、`maxSize: 10`、`maxExpand: 500`，每次渲染使用独立宏表。

- 文档：https://katex.org/docs/api.html
- 选项：https://katex.org/docs/options.html
- 许可证：[MIT](katex/LICENSE)
