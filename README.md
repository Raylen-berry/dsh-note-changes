# dsh-note-changes

在 DSH 里查看一个 Obsidian vault 的**笔记改动历史**。

读取 vault 的 git 提交，在**右侧边缘可拉开的抽屉**和**设置页一个分区**里，列出每次提交改动过哪些 Markdown 笔记。

> **上半只读、下半会写。** 列改动历史那一半是纯只读的；但本插件还登记了一个 `vault_note_append` 工具，
> 并有一条「会话结束」后的兜底写入 —— 两者都只**追加**到 `00-收件箱/日记/<日期>.md`，并且统一由
> `00-索引/插件设置.md` 里的 `autoWriteOnSessionEnd` 开关控制（关掉 ⇒ 一条都不写）。
> 插件自己**不会** `git add` / commit / push；提交仍由你和 vault 的 `AGENTS.md` 约定负责。

## 界面

| 位置 | 插槽 | 说明 |
| --- | --- | --- |
| 右侧边缘竖排标签「笔记改动」 | `shell.overlay`（order 45） | 点开是抽屉，列出提交与改动的 `.md`；底部拉杆能读某篇笔记的正文 |
| 设置 → 笔记改动 | `settings.section`（order 65） | 可改 vault 路径、重新读取 |
| 输入框右侧 chip「笔记」 | `conversation.input.right`（order 205） | 点开是浮层，里面是两个开关（`scanVault` / `autoWriteOnSessionEnd`） |

三处共用同一份数据源（Host 的 `/note-changes/*` 路由）。

## 发布前检查（CI 与本地同一条命令）

push / PR 都会跑 `.github/workflows/ci.yml`，它只做一件事：`npm test`。本地跑的就是同一条命令，
**不装任何依赖、不联网、不读你的真实 vault**：

```bash
npm test                       # = node tools/run-all.mjs
node tools/run-all.mjs --list  # 只看清单：跑哪些、以及哪些被排除、为什么
```

`tools/run-all.mjs` 把每套都跑完再汇总，任一套非 0 退出 ⇒ `npm test` 退出码 1 ⇒ CI 变红。
CI 用 Node 20/22/24 三档矩阵、windows-latest。

本机实测（Node 24.9.0）：

| 套件 | 本机结果 |
| --- | --- |
| `tools/verify-append-lock.mjs` | 10 项通过（并发追加按路径串行 + 回读校验） |

工具目录里只有这一套，无需排除任何套件。

## 安装

```powershell
# 从仓库装（推荐）
dsh plugin --profile web add https://github.com/Raylen-berry/dsh-note-changes#main

# 或本地开发用 link:
dsh plugin --profile web add link:E:\deepseekagent\dsh-note-changes-main
```

然后 **重启 DSH Desktop**。

> **必须重启**，刷新网页不够：本插件的 Client 半在 DSH 启动时与其它插件一起 compose。
> （只改 client 半时也能靠 `/plugins` 路由的内容哈希热更，但有约 7 秒防抖重扫；Host 半一律要重启。）

### 再告诉插件你的 vault 在哪（三选一，v1.5.0）

```powershell
# ① 指针文件（推荐：不进 git，一台机器一份，重启后所有选路都自愈）
"> E:/my-vault" | Out-File "$env:APPDATA\dsh-desktop\harness\dsh-note-changes\vault.txt" -Encoding utf8NoBOM

# ② 环境变量（桌面版 App 未必继承终端里的设置，优先用 ①）
[Environment]::SetEnvironmentVariable('DNC_VAULT','E:/my-vault','User')

# ③ 图形界面：设置 → 笔记改动 → 填路径点「应用」
#    这是「本浏览器的显式覆盖」，优先级最高；点「跟随本机引导」可清掉。
```

上表 ①② 的机器本地引导**压过** vault 里那个随 git 同步过来的 `vault:` 值，
所以从别的机器 clone 过来的库不会把本机路径盖回上一个机器的地址。

## 它做了什么

Host 半跑一条只读命令并把结果整理成 JSON：

```
git -c core.quotepath=false -C "<vault>" log -n 80 --date=short --name-only
```

然后在 Node 侧解析出：提交哈希、作者、日期、标题、以及这次提交里改动的 `.md` 文件。

## 写入本库的两条路

| 路 | 触发 | 写什么 |
| --- | --- | --- |
| **主线：`vault_note_append` 工具** | AI 按 vault 的 `AGENTS.md` §7 在收工前主动调用 | 这次会话的**要点**（由真正干活的 AI 判定） |
| **兜底：`agent/status` 监听** | 会话转为 `idle` 后**防抖 3 分钟**仍无动静 | 一条标着「自动记录 · 待补充」的**存根**，只记时间与会话 id |

兜底只在**三个条件同时成立**时才写（防止刷屏）：这一轮确实进过 `running`、这一轮 AI **没**写过要点、这个会话**今天**还没写过存根。
所以正常情况下你只会看到要点，只有 AI 忘了写、且隔了 3 分钟没动静，才会出现一条「待补充」提醒你回头补。

两条路都受 `autoWriteOnSessionEnd` 管辖：关掉后 `vault_note_append` 直接拒绝写入、兜底也不再补存根。

**记录口径**（写在 `vault_note_append` 的工具描述里，AI 每次调用都会看到）：踩过的坑如果库里已有
**同类型**条目，就**并入那一条**、不重复新开；并且要写明**出现场景**（什么操作、什么环境下会撞上）——
没有场景的坑记下次认不出来，等于没记。这条与 vault 自己 `AGENTS.md` §0.4「新坑按品类写进对应笔记」同向。

## 两个实现上的取舍（都是踩坑换来的）

### 1. 不用 `--pretty=format:`

格式串里的 `%H`、`%an` 在 `cmd.exe` 下会被当成环境变量展开，`%x1f%` 这种更是直接坏掉。默认的 medium 格式不需要任何 `%`，解析同样可靠。

### 2. Host 半必须声明 `inject`，否则路由静默注册不上

v1.0.0 的 bug：`apply` 里用 `ctx.get('webServer')` 做 undefined 检查就以为安全了。但 Cordis 的服务是**异步出现**的，`apply` 会在 webServer 就绪之前跑完，拿到 `undefined` 后直接 return——路由永远注册不上。

症状极具迷惑性：插件在设置页正常出现、Client 半正常渲染，**只有数据是空的**，前端报：

```
Failed to execute 'json' on 'Response': Unexpected end of JSON input
```

因为请求落到兜底路由、返回空响应体。

正确写法：

```js
export const inject = ['webServer', 'shell']
```

`inject` 不是"提前检查"，而是"排队等它"。定位手段是 `%APPDATA%\dsh-desktop\logs\harness.log`。

### 3. 复用 DSH 原生 UI 组件，而不是自造直角矩块

v1.0.0 全用内联样式，结果是"扎人的直角矩块"。v1.1.0 改成：

```js
var P = require('@deepseek-ai/dsh-client-ui-primitives')   // 可选增强，拿不到就退回普通元素
h(P.Button, { variant: 'ghost', size: 'sm', icon: h(P.IconRefreshOutline16, null), onClick }, '重新读取')
h(P.Input,  { value, placeholder, onChange })
```

实测可用的导出：`Button`（variant: `primary`/`ghost`/`outline`/`toolbar`，size: `md` 36px / `sm` 28px，`icon` 接一个 16px 节点）、`Input`、`Pill`、`Menu`、`Modal`、`Tooltip`、`DisclosureRow`，以及整套 `IconXxxOutline16` 图标。

配合一小段自命名空间 CSS（`.dnc-*`，注入到 `<head>` 并在 `ctx.effect` 里清理）拿回 hover / 过渡 / 圆角 / 自定义滚动条。主题变量用产品自带 CSS 里出现过的那些，例如 `--dsw-alias-border-l3`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-label-tertiary`、`--dsw-alias-label-dimmed`。

> 注意：`Theme.listTokens` 只列出"当前可查询/可覆写"的 13 个 token，**不是全部**。产品自带 CSS 里用的变量更多，可以直接用。

### 4. 界面状态必须订阅 store，否则"怎么点都不动"

开关这类组件读 store 却不订阅时，`bump()` 不触发重渲染 ⇒ 开关永远显示旧值，**失败了也看不见**。
本插件所有读 store 的组件都过一遍 `useVersion()`。判据是"界面上真的看得见吗"，不是"代码里写了错误处理"。

## 前置条件

- **vault 必须是 git 仓库**：`git -C <vault> rev-parse --git-dir` 能成功
- **git 可用**：Host 通过 `ctx.get('shell')` 执行 git

### 目录属主问题（常见）

如果 vault 目录属主不是当前用户，git 会拒绝操作：

```
fatal: detected dubious ownership in repository at '<vault>'
```

修法（git 自己建议的做法，仅针对该路径）：

```powershell
git config --global --add safe.directory <vault 路径>
```

**用提权（管理员）创建的目录一定会中这一条**——属主会变成 `BUILTIN\Administrators`。建目录尽量别提权。

## 配置：开关在 vault 里随 git 走，**路径是本机的**

两个开关（`scanVault` / `autoWriteOnSessionEnd`）存在 **vault 自己的 `00-索引/插件设置.md` 的 frontmatter** 里，
随 git 同步到每台设备。但 **`vault` 这个键不能跟着走**——它是机器专属绝对路径：
在 E 盘上写成 `E:/vault`，clone 到只有 D 盘的机器上就指错了。而"读这个键"本身又要先知道 vault 在哪，
于是形成死循环（v1.4.1 的实际症状：换机器后抽屉空白，且 `vault_note_append` / idle 兜底
只按内置默认值去找设置文件 ⇒ AI 侧写入选路同样是死的）。

v1.5.0 给了一条**不依赖 vault** 的引导，按优先级取第一个非空且合法的：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `?vault=` / `vault_note_append` 的 `vault` 参数 | 显式覆盖，最大 |
| 2 | 环境变量 `DNC_VAULT` | 注意桌面版 App 不一定继承你在终端里设的变量，优先用下一行 |
| 3 | **指针文件 `$DSH_HOME/dsh-note-changes/vault.txt`** | 一行的绝对路径，允许 `#` 注释；**不进 git**，换机器只写这一个文件 |
| 4 | vault 里的 `vault:` 键 | 仅当上面三档都没表态时才采纳 |
| 5 | 内置默认 `E:/vault` | 兜底 |

设置页里那个输入框是 **本浏览器的显式覆盖**（存 `localStorage`），填了就是第 1 档；
点「跟随本机引导」清掉它，就又回到由指针文件/环境变量决定的状态。

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `vault` | vault 的绝对路径（**用正斜杠** `E:/vault`） | `E:/vault` |
| `scanVault` | 出错时优先查本库的关键词索引（抽屉的「相关笔记」把 [[关键词索引]] 钉在第一位） | `true` |
| `autoWriteOnSessionEnd` | 控制**所有**往本库写入的行为，关掉则一条都不写 | `true` |

路径用正斜杠（`E:/vault`）——Windows 下 git 与 Node 都接受，还能避免反斜杠在 JS 字符串里的转义问题
（反斜杠也收，插件自己会归一化；相对路径一律判为无效，因为它跟着 cwd 走会指到别的库）。

改法：直接改 frontmatter（Obsidian 的「属性」面板也能改），或者在插件设置页 / 输入框 chip 里点开关 —— 写的是同一处。
设置页下方会显示**当前生效路径与它的依据**（是第几档选的），不用再靠猜。

## 已知限制

- 一次最多 80 条提交（Host 的 `MAX_COMMITS`），没有分页
- 只列 `.md`；`.canvas`、附件等不显示
- 不区分「谁写的」——作者一律是 git 记录的 author。**目前人类与 AI 的提交都以同一个 git 身份落盘**，所以无法从历史里区分；要区分得先约定 AI 用独立身份提交
- 抽屉与设置页的数据在每次打开/刷新时重取，没有实时监听

## 失败排查

| 现象 | 检查 |
| --- | --- |
| 右侧没有「笔记改动」标签 | 是否**重启过** DSH Desktop；`设置 → 插件` 里插件是否启用 |
| 面板里显示 `dubious ownership` | 见上面「目录属主问题」 |
| 面板里显示「这个仓库还没有提交」 | vault 可能没 `git init`，或路径填错了 |
| 显示 `Host 未提供 shell 服务` | 该 profile 没有 `shell` 服务 |
| 开关点了没反应 | 组件是否漏了 `useVersion()` 订阅（见上面「取舍 4」） |
| 换机器后抽屉空白 / 工具报「解析不出 vault 路径」 | 第 1 档没给路径：写指针文件或设 `DNC_VAULT`（见「安装 · 再告诉插件你的 vault 在哪」）；vault 里那个 `vault:` 是从别的机器同步来的，多半还指着上一台的路径 |
| 所有会话都报 400 / 工具全挂 | `vault_note_append` 的 schema 是否被改成了非标准形状（见下面 v1.4.1） |

## 版本

完整历史见 `git log`；下面只记**行为会变**的节点。

- **v1.5.2**：修**并发追加丢记录**。本插件的写入全是"读全文 → 改一处 → 写回全文"的形状，
  两个并发调用（同时写日记、或设置页连点两下）各读各的旧内容时，后写的那次会把先写的**整段覆盖**掉，
  而且两次都返回成功 —— 用户只看到记录莫名少一条，没有任何报错。现在按路径串行（`withWriteLock`，
  写日记与写设置各一把锁），写完再**回读校验**这段内容确实在盘上，把静默丢失变成可见错误。
  回归套件 `tools/verify-append-lock.mjs` 用人工延迟撑开交错窗口，**改动前 5 条失败 / 改动后 10 条通过**
  （同一个脚本改 `DNC_INDEX` 就能 A/B 复现）。
- **v1.5.1**：把「记录口径」写进 `vault_note_append` 的工具描述——**同类型的坑并入既有条目**、不重复新开，
  且必须写明**出现场景**。工具描述是每次调用都送到模型跟前的唯一入口，规则放别处 AI 看不见。
- **v1.5.0**：解掉「vault 路径」的鸡生蛋死循环。新增机器本地引导 —— 环境变量 `DNC_VAULT` 与
  指针文件 `$DSH_HOME/dsh-note-changes/vault.txt`，五档优先级（显式 > env > 指针 > vault 里的 `vault:` > 内置默认），
  且机器本地三档**压过** git 同步来的路径（否则换机又被上一台盖回去）。三条路由 + 工具 + idle 兜底
  统一走同一个 `resolveVault()`，响应带 `vaultSource`/`vaultPath`，设置页直接显示"当前生效路径与依据"。
  client 半改为**没显式覆盖就不发 `?vault=`**（v1.4.1 在 localStorage 为空时硬发 `E:/vault`，
  正好把 host 的引导盖死 —— 这就是"新机器抽屉空白"的真因）；新增「跟随本机引导」按钮。
  另修 `shortSession()`：DSH 会话 id 形如 `session-<uuid>`，取前 8 位得到的是无信息量的 `session-`，
  兜底存根因此认不出是哪个会话；现在先剥前缀再截。
- **v1.4.1**：修 `vault_note_append` 的工具 schema。原先是扁平 `parameters`（属性里带 `required: true`），
  而 DeepSeek 对工具 schema 是**严格校验**、`tools` 数组又挂在**每一个**请求上 ⇒ 一个畸形 schema 不是"这个工具不能用"，
  而是所有会话每条消息都 400。改成标准 JSON Schema（`type: 'object'` + 顶层 `required`）后恢复。
  **教训**：在宽容的 provider 上验证通过 ≠ schema 合法。
- **v1.4.0**：设置搬进 vault 的 `00-索引/插件设置.md`（**开关**随 git 迁移；**路径**不能，见 v1.5.0）；输入框右侧新增 chip。
- **v1.3.0**：会话转 `idle` 后的兜底存根（3 分钟防抖 + 三个条件同时成立才写）。
- **v1.2.0**：接入 `vault_note_append` 工具（AI 按 `AGENTS.md` §7 收工前主动写要点）。
- **v1.1.0**：改用 DSH 原生 UI 组件 + 自命名空间 CSS；Host 半补 `inject` 声明。
- **v1.0.0**：首个可用版本（`git log` 解析 + 右侧抽屉 + 设置页分区）。

## 许可

MIT
