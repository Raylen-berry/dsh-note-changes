# DSH 笔记库 · v1.8.0

在 DSH Desktop 侧栏打开 **笔记库**，进入独立的 Obsidian 笔记工作区。正文占据主页面，不再挂在聊天输入框上，也不遮住聊天内容。

## 可以做什么

- 浏览本地 Markdown 目录，包括尚未提交的草稿；按标题与正文搜索。
- 阅读常用 Markdown，沿 `[[双链|别名]]` 跳转，查看大纲、出链与反向链接。同名笔记提供候选，不自动猜。
- 切换到 Markdown 编辑器，保留原始 frontmatter 和双链；按保存或 Ctrl/Cmd+S 写回当前文件。
- 切换笔记会在当前浏览器会话暂存草稿；刷新后重新打开可恢复。草稿仍需手动保存，关闭浏览器会话后不保证保留。
- 查看 Git 改动历史；在设置页管理本机路径、AI 记录与同步。

这不是 Obsidian 本体：没有加载它的第三方插件、Canvas 或 Dataview。编辑器使用 Markdown 源文；复杂嵌入、图片附件、公式等仍应在 Obsidian 中查看。

## 保存与冲突

读取时记下正文版本；保存时再次核对版本，并交给宿主文件服务做原子替换。如果 Obsidian、另一窗口或自动日记已改过文件，返回冲突并保留草稿。可以“复制草稿并读取新版”，对照后合并。

保存后沿用原有同步：只暂存 **并只提交** 当前文件，推送失败显示回执，本地修改仍保留。Git 操作按笔记库排队。自动日记仍受原有开关控制；用户主动点击保存独立于该开关。

超过 60,000 字符只预览，不允许把截断内容写回；超过 1 MB 的单篇请用 Obsidian。检索最多收集 2,000 篇、500 个目录、16 层深度，正文预算 8 MB；超过范围明确显示部分索引。目录与正文访问都校验实际目标在库内，隐藏目录与附件目录不参与扫描。

## 安装与本机路径

安装 `github:Raylen-berry/dsh-note-changes#main` 后重启 DSH Desktop，使宿主和客户端一起更新。需要带 `main` 与 `sidebar.panellist` 扩展接口的 Desktop（本次按 0.1.7-rc.2 的本机组件核对）。入口在左侧“笔记库”，聊天输入条不再添加快捷开关。

路径优先级保持不变：显式参数 / 设置页覆盖 → `DNC_VAULT` → `$DSH_HOME/dsh-note-changes/vault.txt` → 笔记库设置 → 默认值。换机器可在指针文件写一行本地绝对路径。插件不修改 `.obsidian/`。

## 开发与检查

```sh
npm run build
npm run check
npm test
node tools/browser-check.mjs
```

- `client/workspace.part.js`：页面与状态；`client/markdown.part.js`：安全的 Markdown 阅读与链接解析；`client/styles.css`：主题和窄屏样式。
- `client.js` 自动生成，不直接修改。
- `lib/vault-browser.mjs`：有界扫描、检索缓存、路径和版本保护。
- 浏览器检查使用临时笔记库和模拟 Git 同步，不读写真实笔记、不调用模型。可配置 `DNC_PLAYWRIGHT_MODULE`、`DNC_REACT_ROOT`、`DNC_BROWSER`、`DNC_SCREENSHOTS`；Windows 默认使用现有 Edge。
- 原有追加、同步、路由回归继续执行。早期实现记录见 [历史文档](docs/v1.7-history.md)。

## 回退

回退本次提交并重新安装 / 重启即可。笔记仍是普通本地 Markdown 文件，UI 回退不会删除它们；本版没有修改笔记库内容或 `.obsidian` 配置。
