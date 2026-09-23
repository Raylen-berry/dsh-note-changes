// ============================================================================
// dsh-note-changes · Client half (v1.7.0)
// ============================================================================
// 右侧抽屉 = 上「改动时间线」+ 下「相关笔记」拉杆抽屉；设置页一个分区。
//
// 改动要点（v1.2.0）：
//   - 时间线改成**日期在前作标题**，隐藏 commit hash 与作者（hash 挪进 title 提示）
//   - 抽屉底部是一根**拉杆**：展开后列出这批改动碰过的笔记，点开直接读正文
//     （正文由 Host 的 /note-changes/note 提供；自带极简 Markdown 渲染）
//   - 设置页内容**居中**
//   - z-index 按**跨插件浮窗梯子**取值（2026-09-15 统一，见 dsh-plugins/FLOATING-WINDOWS.md）：
//     本插件标签 2147483410（面板/pop 3420）低于小游戏浮窗 2147483440、
//     低于浏览器观察窗 2147483450/3460，仍高于缓存插件面板 2147483400 ⇒ 不盖住它们，也不被面板盖住
//
// 开发提醒（实测）：**client 半改完只要刷新页面**——客户端模块由
// /plugins/??<pkg>/client.js&rev=<内容哈希> 现取，rev 随文件变化。
// 只有 Host 半（index.js）改动才需要重启 DSH Desktop。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-note-changes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    // 原生组件是可选增强：拿不到就退回普通元素，绝不让整个插件挂掉。
    var P = null
    try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch (err) { P = null }

    var LOG_PATH = '/note-changes/log'
    var NOTE_PATH = '/note-changes/note'
    var SETTINGS_PATH = '/note-changes/settings'
    var SYNC_PATH = '/note-changes/sync'
    var DEFAULT_VAULT = 'E:/vault'
    var STORE_KEY = 'dsh-note-changes:vault'

    // DSH Desktop 在 Windows 上是「无边框窗口 + 原生标题栏覆盖层」：窗口按钮由系统
    // 画在网页内容**之上**、占右上角 140x36px（out/main/index.js 的
    // WINDOWS_TITLEBAR_HEIGHT=36 / WINDOWS_CAPTION_CONTROLS_WIDTH=140）。
    // 浮层绝不能贴顶，否则把窗口按钮盖住、用户点不到。
    var TITLEBAR_INSET = 0
    try {
      var insetMatch = /[?&]dsh-desktop-titlebar-inset=(\d+)/.exec(window.location.search)
      if (insetMatch) TITLEBAR_INSET = Math.max(0, parseInt(insetMatch[1], 10) || 0)
    } catch (err) { TITLEBAR_INSET = 0 }

    var CSS = [
      // ---------- 折叠态：右侧竖排标签 ----------
      '.dnc-tab{position:fixed;right:0;top:max(88px,36vh);pointer-events:auto;z-index:2147483410;',
      'display:inline-flex;align-items:center;justify-content:center;padding:14px 8px;',
      'border:1px solid var(--dsw-alias-border-l2);border-right:none;border-radius:12px 0 0 12px;',
      'cursor:pointer;font-size:12px;letter-spacing:2px;writing-mode:vertical-rl;',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:-2px 2px 10px rgba(0,0,0,.10);transition:color .15s,border-color .15s,background .15s}',
      '.dnc-tab:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',

      // ---------- 面板骨架 ----------
      '.dnc-panel{position:fixed;right:12px;top:50%;transform:translateY(-50%);',
      // 宽度随视口收缩：全屏不打架，半屏/窄屏自动变窄 —— 否则固定 392px 在 700px 宽的
      // 窗口里要占掉一半以上，必然和会话区、置顶气泡打架。实测：1418px 视口 → 392px；
      // 709px 视口 → 272px（下限）而不是 392px。
      'width:clamp(272px, 34vw, 392px);',
      'height:min(60vh,500px);max-height:calc(100vh - ' + (TITLEBAR_INSET + 80) + 'px);',
      'pointer-events:auto;z-index:2147483420;display:flex;flex-direction:column;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden;',
      'background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.26)}',
      '.dnc-head{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:10px 10px 10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:grab}',
      '.dnc-head:active{cursor:grabbing}',
      '.dnc-title{flex:1;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dnc-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 14px}',
      '.dnc-body::-webkit-scrollbar{width:8px}',
      '.dnc-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:4px}',
      '.dnc-body::-webkit-scrollbar-track{background:transparent}',

      // ---------- 时间线：日期作一级标题、当天改动作二级 ----------
      // 时间线过滤框（v1.7.0）：用原生 input[type=search]，带浏览器的清除按钮
      '.dnc-filter{width:100%;box-sizing:border-box;margin:0 0 10px;padding:4px 8px;font:inherit;',
      'font-size:11.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:7px}',
      '.dnc-count{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:12px;word-break:break-all}',
      '.dnc-group{margin-bottom:16px}',
      '.dnc-groupDate{font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary);',
      'font-variant-numeric:tabular-nums;margin-bottom:8px}',
      '.dnc-groupBody{display:flex;flex-direction:column;gap:7px;',
      'border-left:2px solid var(--dsw-alias-border-l2);margin-left:3px;padding-left:11px}',
      '.dnc-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 11px;',
      'background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,background .15s}',
      '.dnc-item:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
      '.dnc-subject{margin-top:5px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dnc-files{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}',
      '.dnc-files li{display:flex;align-items:baseline;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.dnc-files li::before{content:"";flex:none;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-border-l3);transform:translateY(-2px)}',
      '.dnc-nofile{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-dimmed)}',
      '.dnc-muted{font-size:12px;color:var(--dsw-alias-label-tertiary)}',

      // ---------- 底部拉杆 + 相关知识抽屉 ----------
      '.dnc-kbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;',
      'padding:10px 14px;border:none;border-top:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);',
      'font-size:12px;cursor:pointer;text-align:left;transition:color .15s,background .15s}',
      '.dnc-kbar:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}',
      '.dnc-kbarLabel{flex:1}',
      '.dnc-caret{flex:none;font-size:10px;opacity:.7;transition:transform .18s}',
      '.dnc-kdrawer{flex:0 0 auto;max-height:46%;overflow:auto;padding:8px 12px 12px;',
      'border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}',
      '.dnc-kdrawer::-webkit-scrollbar{width:8px}',
      '.dnc-kdrawer::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:4px}',
      '.dnc-krow{width:100%;box-sizing:border-box;display:flex;align-items:center;gap:8px;',
      'padding:7px 9px;border:1px solid transparent;border-radius:9px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;text-align:left;',
      'transition:color .15s,background .15s,border-color .15s}',
      '.dnc-krow:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}',
      '.dnc-krow.open{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}',
      '.dnc-kname{flex:1;word-break:break-all}',

      // ---------- 极简 Markdown 渲染 ----------
      '.dnc-doc{margin:6px 0 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.72;',
      'color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dnc-doc>*:first-child{margin-top:0}',
      '.dnc-doc h1,.dnc-doc h2,.dnc-doc h3{margin:14px 0 6px;color:var(--dsw-alias-label-primary);line-height:1.4}',
      '.dnc-doc h1{font-size:14px}.dnc-doc h2{font-size:13px}.dnc-doc h3{font-size:12.5px}',
      '.dnc-doc p{margin:0 0 8px}',
      '.dnc-doc li{margin:0 0 4px;padding-left:2px}',
      '.dnc-doc ul,.dnc-doc ol{margin:0 0 8px;padding-left:18px}',
      '.dnc-doc pre{margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'line-height:1.6;overflow:auto;color:var(--dsw-alias-label-primary)}',
      '.dnc-doc code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'padding:1px 4px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dnc-doc pre code{padding:0;background:transparent}',
      '.dnc-doc strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dnc-wikilink{color:var(--dsw-alias-brand-primary);border-bottom:1px dashed currentColor}',
      '.dnc-doc hr{margin:12px 0;border:none;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dnc-doc table{border-collapse:collapse;margin:8px 0;font-size:11.5px;width:100%}',
      '.dnc-doc th,.dnc-doc td{border:1px solid var(--dsw-alias-border-l1);padding:4px 7px;text-align:left}',
      '.dnc-doc th{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dnc-doctrunc{margin:2px 0 10px;font-size:11px;color:var(--dsw-alias-label-dimmed)}',
      // 「在 Obsidian 里打开」（v1.7.0）：只读抽屉里唯一的外链
      '.dnc-docbar{display:flex;justify-content:flex-end;margin:0 0 6px}',
      '.dnc-open{font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:none;border:0;border-bottom:1px dotted currentColor;padding:0;cursor:pointer}',
      '.dnc-open:hover{color:var(--dsw-alias-label-primary)}',

      // ---------- 错误 ----------
      '.dnc-errorbox{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dnc-errtext{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}',
      '.dnc-hint{margin-top:8px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}',
      '.dnc-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'padding:1px 5px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',

      // ---------- 设置页（内容居中） ----------
      '.dnc-wrap{padding:2px 0 24px;max-width:500px;margin:0 auto}',
      '.dnc-h{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 0 8px}',
      '.dnc-p{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin:0 0 18px}',
      '.dnc-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}',
      '.dnc-field{width:100%;max-width:520px;margin-bottom:12px}',
      '.dnc-bar{display:flex;align-items:center;gap:8px;margin-bottom:20px}',
      '.dnc-inputWrap{width:100%}',
      // ---------- 输入框右侧 chip（对齐「会话策略」的位置与观感）----------
      '.dnc-chipWrap{position:relative;display:inline-flex}',
      '.dnc-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;cursor:pointer;',
      'transition:border-color .12s,color .12s,background .12s}',
      '.dnc-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dnc-chip.on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dnc-chipDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l3);flex:none}',
      '.dnc-chipDot.on{background:var(--dsw-alias-state-success-primary)}',
      '.dnc-pop{position:fixed;z-index:2147483420;width:300px;box-sizing:border-box;',
      'max-height:calc(100vh - 24px);overflow:auto;display:flex;flex-direction:column;gap:8px;',
      'padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;',
      'background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 34px rgba(0,0,0,.28);',
      'font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.dnc-popHead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dnc-popTitle{font-weight:600;font-size:12.5px}',
      '.dnc-popClose{border:none;background:transparent;color:var(--dsw-alias-label-secondary);',
      'cursor:pointer;font-size:12px;padding:0 2px;line-height:1}',
      '.dnc-popClose:hover{color:var(--dsw-alias-label-primary)}',
      '.dnc-toggles{display:flex;flex-direction:column;gap:4px;margin:0 0 16px}',
      '.dnc-toggle{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;padding:3px 0}',
      '.dnc-toggle input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none}',
    ].join('')

    function errText(error) {
      if (error && error.message) return String(error.message)
      return String(error)
    }

    // v1.5.0：这里**不再**退到 DEFAULT_VAULT。旧写法在 localStorage 为空时返回
    // 'E:/vault'，于是每个请求都硬发 ?vault=E:/vault，把 host 侧的机器本地引导
    // （DNC_VAULT / 指针文件）直接盖掉 —— 新机器上抽屉因此永远空白。
    // 现在留空 = 「本机没覆盖，交给 host 按优先级裁决」。
    function loadVault() {
      try {
        var saved = window.localStorage.getItem(STORE_KEY)
        if (saved && String(saved).trim().length > 0) return String(saved).trim()
      } catch (err) { /* localStorage 不可用 = 没有本机覆盖 */ }
      return ''
    }

    function saveVault(value) {
      var v = typeof value === 'string' ? value.trim() : ''
      try {
        if (v.length > 0) window.localStorage.setItem(STORE_KEY, v)
        else window.localStorage.removeItem(STORE_KEY)
      } catch (err) { /* 忽略 */ }
    }

    // 面板自定义位置（拖动后记住）。null = 默认：靠右 + 上下居中。
    var PANEL_POS_KEY = 'dsh-note-changes:panel-pos'

    function loadPanelPos() {
      try {
        var raw = window.localStorage.getItem(PANEL_POS_KEY)
        if (!raw) return null
        var parsed = JSON.parse(raw)
        if (parsed && typeof parsed.right === 'number' && typeof parsed.top === 'number') return parsed
      } catch (err) { /* 忽略 */ }
      return null
    }

    function savePanelPos(value) {
      try {
        if (value) window.localStorage.setItem(PANEL_POS_KEY, JSON.stringify(value))
        else window.localStorage.removeItem(PANEL_POS_KEY)
      } catch (err) { /* 忽略 */ }
    }

    function insertStyle(css) {
      var el = document.createElement('style')
      el.setAttribute('data-plugin', 'dsh-note-changes')
      el.textContent = css
      document.head.appendChild(el)
      return function () {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    function ActionButton(props) {
      if (P && typeof P.Button === 'function') {
        return h(P.Button, {
          variant: props.variant || 'ghost',
          size: props.size || 'sm',
          icon: props.icon,
          onClick: props.onClick,
          title: props.title,
        }, props.children)
      }
      return h('button', {
        type: 'button', title: props.title, onClick: props.onClick,
        style: {
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)',
          borderRadius: '14px', padding: '4px 12px', fontSize: '12px', cursor: 'pointer',
        },
      }, props.children)
    }

    function VaultInput(props) {
      if (P && typeof P.Input === 'function') {
        return h(P.Input, {
          className: 'dnc-inputWrap',
          value: props.value, placeholder: props.placeholder, onChange: props.onChange,
        })
      }
      return h('input', {
        value: props.value, placeholder: props.placeholder, onChange: props.onChange,
        style: {
          width: '100%', boxSizing: 'border-box',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          borderRadius: '8px', padding: '6px 8px', fontSize: '12px',
        },
      })
    }

    function icon(name) {
      if (P && typeof P[name] === 'function') return h(P[name], null)
      return null
    }

    /** 把 `10-笔记/踩坑-架构与同步.md` 显示成 `踩坑-架构与同步`。 */
    function noteLabel(path) {
      var text = String(path || '')
      var slash = text.lastIndexOf('/')
      if (slash >= 0) text = text.slice(slash + 1)
      return text.replace(/\.md$/i, '')
    }

    /**
     * 行内 Markdown：`**粗**` / `` `代码` `` / `[[双链]]`。
     * 不做完整 CommonMark——只处理笔记里高频出现的这三种，其余原样输出。
     */
    function inline(text) {
      var source = String(text == null ? '' : text)
      var out = []
      var pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\[[^\]\n]+\]\])/g
      var last = 0
      var k = 0
      var m
      while ((m = pattern.exec(source)) !== null) {
        if (m.index > last) out.push(source.slice(last, m.index))
        var token = m[0]
        if (token.slice(0, 2) === '**') {
          // 必须递归：`**… `code` …**` 里的反引号在 [^*] 之内会被整段吞进 strong，
          // 不递归就会把字面反引号漏到界面上（实测踩到过）。
          // 递归是安全的：外层已用 [^*\n]+ 排除内部再出现 `**`。
          out.push(h('strong', { key: 'b' + (k++) }, inline(token.slice(2, -2))))
        } else if (token.charAt(0) === '`') {
          out.push(h('code', { key: 'c' + (k++) }, token.slice(1, -1)))
        } else {
          out.push(h('span', { key: 'w' + (k++), className: 'dnc-wikilink' }, token.slice(2, -2)))
        }
        last = m.index + token.length
      }
      if (last < source.length) out.push(source.slice(last))
      return out
    }

    /**
     * 极简 Markdown → React 节点。
     * 故意不用 primitives 的 MarkdownText：它的 props 契约没查到，猜错会整块面板崩掉。
     * 这里只处理标题/列表/代码块/表格/分隔线 + 上方的行内三件套——够读笔记，行为完全可控。
     */
    function renderDoc(text) {
      var lines = String(text || '').split(/\r?\n/)
      var nodes = []
      var i = 0
      var key = 0

      // 跳过 YAML frontmatter
      if (lines.length > 0 && lines[0].trim() === '---') {
        for (var j = 1; j < lines.length; j++) {
          if (lines[j].trim() === '---') { i = j + 1; break }
        }
      }

      while (i < lines.length) {
        var line = lines[i]
        var trimmed = line.trim()

        if (trimmed.length === 0) { i++; continue }

        // 代码块
        var fence = /^(```|~~~)/.exec(trimmed)
        if (fence) {
          var buf = []
          i++
          while (i < lines.length && !/^(```|~~~)/.test(lines[i].trim())) { buf.push(lines[i]); i++ }
          i++
          nodes.push(h('pre', { key: 'p' + (key++) }, h('code', null, buf.join('\n'))))
          continue
        }

        // 标题
        var head = /^(#{1,6})\s+(.*)$/.exec(trimmed)
        if (head) {
          var level = Math.min(head[1].length, 3)
          nodes.push(h('h' + level, { key: 'h' + (key++) }, inline(head[2])))
          i++
          continue
        }

        // 分隔线
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
          nodes.push(h('hr', { key: 'r' + (key++) }))
          i++
          continue
        }

        // 表格（连续以 | 开头的行）
        if (/^\|/.test(trimmed)) {
          var rows = []
          while (i < lines.length && /^\|/.test(lines[i].trim())) { rows.push(lines[i].trim()); i++ }
          if (rows.length >= 2) {
            var cells = function (row) {
              return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim() })
            }
            var headCells = cells(rows[0])
            var bodyRows = rows.slice(2)
            nodes.push(h('table', { key: 't' + (key++) },
              h('thead', null, h('tr', null, headCells.map(function (c, ci) { return h('th', { key: ci }, inline(c)) }))),
              h('tbody', null, bodyRows.map(function (r, ri) {
                return h('tr', { key: ri }, cells(r).map(function (c, ci) { return h('td', { key: ci }, inline(c)) }))
              }))
            ))
            continue
          }
        }

        // 列表
        var bullet = /^([-*+]|\d+\.)\s+(.*)$/.exec(trimmed)
        if (bullet) {
          var ordered = /\d+\./.test(bullet[1])
          var items = []
          while (i < lines.length) {
            var m = /^([-*+]|\d+\.)\s+(.*)$/.exec(lines[i].trim())
            if (!m) break
            items.push(m[2])
            i++
          }
          nodes.push(h(ordered ? 'ol' : 'ul', { key: 'l' + (key++) },
            items.map(function (t, ti) { return h('li', { key: ti }, inline(t)) })))
          continue
        }

        // 段落：吃到空行为止
        var para = []
        while (i < lines.length && lines[i].trim().length > 0
          && !/^(#{1,6})\s/.test(lines[i].trim())
          && !/^(```|~~~)/.test(lines[i].trim())
          && !/^([-*+]|\d+\.)\s/.test(lines[i].trim())
          && !/^\|/.test(lines[i].trim())) {
          para.push(lines[i].trim())
          i++
        }
        if (para.length > 0) nodes.push(h('p', { key: 'g' + (key++) }, inline(para.join(' '))))
      }

      return nodes
    }

    function apply(ctx) {
      var slots = ctx.slots
      if (!slots) {
        console.error('[dsh-note-changes] slots 服务不存在，UI 无法注册')
        return
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () { return insertStyle(CSS) }, 'dsh-note-changes: styles')
      } else {
        insertStyle(CSS)
      }

      var store = {
        override: loadVault(),          // 用户显式输入过的路径；'' = 跟随 host 引导
        vault: loadVault(),             // 当前生效路径（host 返回后刷新），只用于显示
        vaultSource: '',                // host 依据哪一档选的：explicit/env/pointer/vaultFile/default
        vaultPath: '',                  // host 实际用的那个路径
        version: 0,
        subs: [],
        settings: { scanVault: true, autoWriteOnSessionEnd: true },
        settingsPhase: 'idle',
        settingsError: '',
        settingsSource: '',
        lastSync: null,                 // host 最近一次同步回执：{ at, ok, note, rel }
        syncPhase: 'idle',              // 重试同步的进行中状态
        syncError: '',
      }

      function notify() {
        var list = store.subs.slice()
        for (var i = 0; i < list.length; i++) list[i]()
      }
      function bump() { store.version += 1; notify() }
      function subscribe(fn) {
        store.subs.push(fn)
        return function () {
          var index = store.subs.indexOf(fn)
          if (index >= 0) store.subs.splice(index, 1)
        }
      }
      /**
       * 只有用户显式覆盖过才带 ?vault=。不带 = 让 host 按
       * 环境变量 / 指针文件 / 设置文件 / 默认值 的梯子自己裁决 —— 这是换机器能自愈的关键。
       */
      function withQuery(path, extra) {
        var parts = []
        if (store.override.length > 0) parts.push('vault=' + encodeURIComponent(store.override))
        if (extra) parts.push(extra)
        return parts.length > 0 ? path + '?' + parts.join('&') : path
      }

      /** fetch 的 response → { status, body, raw }。解不开 JSON 就 body=null，原文留在 raw 里报错用。 */
      function readJson(response) {
        return response.text().then(function (text) {
          var body = null
          try { body = JSON.parse(text) } catch (err) { body = null }
          return { status: response.status, body: body, raw: text }
        })
      }

      var SOURCE_LABELS = {
        explicit: '设置页里的本机覆盖',
        env: '环境变量 DNC_VAULT',
        pointer: '指针文件 dsh-note-changes/vault.txt',
        vaultFile: 'vault 里的 00-索引/插件设置.md',
        default: '插件内置默认值',
        none: '没解析出任何路径',
      }

      function setVault(next, followHost) {
        var value = followHost ? '' : (typeof next === 'string' ? next.trim() : '')
        store.override = value
        store.vault = value.length > 0 ? value : ''
        saveVault(value)
        bump()
      }

      // ---- 设置：真正的源是 vault 里的 00-索引/插件设置.md（随 git 迁移）----
      // host 返回的 vault 只更新「显示用的生效值」，**不**写回 localStorage ——
      // 写回去就变成永久本机覆盖，指针文件/环境变量以后改了也追不上（v1.4.1 就是这么把
      // host 的引导盖死的）。想固定一个路径请在设置页点「应用」，那才是显式覆盖。
      function applySettings(next) {
        if (!next) { bump(); return }
        if (typeof next.scanVault === 'boolean') store.settings.scanVault = next.scanVault
        if (typeof next.autoWriteOnSessionEnd === 'boolean') {
          store.settings.autoWriteOnSessionEnd = next.autoWriteOnSessionEnd
        }
        if (store.override.length === 0 && typeof next.vault === 'string' && next.vault.trim().length > 0) {
          store.vault = next.vault.trim()
        }
        bump()
      }

      /** host 这次是按哪一档选的，显示出来，免得「为什么是这个路径」只能靠猜。 */
      function captureSource(body) {
        store.vaultSource = String((body && body.vaultSource) || '')
        store.vaultPath = String((body && body.vaultPath) || '')
      }

      /** 设置路由的共用收尾：成功就落地刷新，失败就回报（读和写各传一句自己的失败文案）。 */
      function applySettingsBody(body, fallbackError) {
        if (body && body.ok && body.settings) {
          store.settingsPhase = 'ready'
          store.settingsError = ''
          store.settingsSource = String(body.source || '')
          if (body.lastSync) store.lastSync = body.lastSync
          captureSource(body)
          applySettings(body.settings)
        } else {
          store.settingsPhase = 'error'
          store.settingsError = (body && body.error) ? String(body.error) : fallbackError
          bump()
        }
      }

      /** 网络层/解析层失败时的统一收尾。 */
      function failSettings(error) {
        store.settingsPhase = 'error'
        store.settingsError = errText(error)
        bump()
      }

      function loadSettings() {
        store.settingsPhase = 'loading'
        fetch(withQuery(SETTINGS_PATH), { headers: { accept: 'application/json' } })
          .then(readJson)
          .then(function (res) { applySettingsBody(res.body, '设置读取失败') })
          .catch(failSettings)
      }

      function saveSettings(patch) {
        store.settingsPhase = 'saving'
        bump()
        fetch(withQuery(SETTINGS_PATH), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ patch: patch }),
        })
          .then(readJson)
          .then(function (res) { applySettingsBody(res.body, '设置写入失败') })
          .catch(failSettings)
      }

      /**
       * 重试同步（v1.7.0）：只重推，不碰工作区、不新建提交。
       * 抽屉里显示的那次提交如果当时 push 失败（网络/沙箱），内容只是停在本地 ——
       * 这里给它第二次机会。回执与写入后的自动同步共用同一个显示字段。
       */
      function syncNow() {
        if (store.syncPhase === 'running') return
        store.syncPhase = 'running'
        store.syncError = ''
        bump()
        fetch(withQuery(SYNC_PATH), { method: 'POST', headers: { accept: 'application/json' } })
          .then(readJson)
          .then(function (res) {
            store.syncPhase = 'idle'
            var body = res.body
            if (body && body.lastSync) store.lastSync = body.lastSync
            if (!body || body.ok !== true) {
              store.syncError = (body && (body.error || body.message)) || '推送失败（响应体不是 JSON）'
            }
            bump()
          })
          .catch(function (error) {
            store.syncPhase = 'idle'
            store.syncError = errText(error)
            bump()
          })
      }

      /**
       * 复制库内路径：真正想"一键跳去 Obsidian"，但桌面版把 `obsidian://` 这类外部协议挡掉了
       * （`secureWindow` 的 setWindowOpenHandler 只对 http/https 调 shell.openExternal，其余 deny，
       * 实测 window.open 直接返回 null、新标签页也不出现）。所以退到可验证的一步：
       * 复制库内相对路径，到 Obsidian 里 Ctrl+O 粘贴即可打开。库名取 vault 目录名这条信息不再需要。
       * 用 execCommand 而不是 navigator.clipboard：后者要权限、失败是异步的，这里要一个确定的返回值。
       */
      function copyRelPath(text) {
        var ta = document.createElement('textarea')
        ta.value = String(text)
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        document.body.appendChild(ta)
        ta.select()
        var ok = false
        try { ok = document.execCommand('copy') } catch (e) { ok = false }
        document.body.removeChild(ta)
        return ok
      }
      function useVersion() {
        var pair = React.useState(store.version)
        var setVersion = pair[1]
        React.useEffect(function () {
          return subscribe(function () { setVersion(store.version) })
        }, [])
        return pair[0]
      }

      function useScan() {
        var version = useVersion()
        var pair = React.useState({ phase: 'loading', commits: [], error: '', vault: store.vault })
        var state = pair[0]
        var setState = pair[1]

        React.useEffect(function () {
          var alive = true
          setState({ phase: 'loading', commits: [], error: '', vault: store.vault })

          fetch(withQuery(LOG_PATH), { headers: { accept: 'application/json' } })
            .then(readJson)
            .then(function (res) {
              if (!alive) return
              var body = res.body
              if (body && body.ok) {
                setState({
                  phase: 'ready',
                  commits: Array.isArray(body.commits) ? body.commits : [],
                  error: '',
                  vault: typeof body.vault === 'string' ? body.vault : store.vault,
                })
                return
              }
              if (body && body.error) {
                setState({
                  phase: 'error', commits: [], error: String(body.error),
                  vault: typeof body.vault === 'string' ? body.vault : store.vault,
                })
                return
              }
              var snippet = String(res.raw || '').trim().slice(0, 200)
              setState({
                phase: 'error', commits: [],
                error: '路由没有返回可解析的 JSON（HTTP ' + String(res.status) + '）。'
                  + (snippet.length > 0
                      ? '\n原始响应：' + snippet
                      : '\n响应体为空——通常是 Host 半的路由没注册上（检查 DSH 日志里本插件的报错）。'),
                vault: store.vault,
              })
            })
            .catch(function (error) {
              if (!alive) return
              setState({ phase: 'error', commits: [], error: errText(error), vault: store.vault })
            })

          return function () { alive = false }
        }, [version])

        return state
      }

      /** 读单篇笔记正文。 */
      function useNote(path, enabled) {
        var pair = React.useState({ phase: 'idle', text: '', error: '', truncated: false })
        var state = pair[0]
        var setState = pair[1]

        React.useEffect(function () {
          if (!enabled || !path) { setState({ phase: 'idle', text: '', error: '', truncated: false }); return }
          var alive = true
          setState({ phase: 'loading', text: '', error: '', truncated: false })
          fetch(withQuery(NOTE_PATH, 'path=' + encodeURIComponent(path)), {
            headers: { accept: 'application/json' },
          })
            .then(readJson)
            .then(function (res) {
              if (!alive) return
              var body = res.body
              if (body && body.ok) {
                setState({ phase: 'ready', text: String(body.text || ''), error: '', truncated: body.truncated === true })
              } else {
                setState({
                  phase: 'error', text: '', truncated: false,
                  error: (body && body.error) ? String(body.error) : ('HTTP ' + String(res.status)),
                })
              }
            })
            .catch(function (error) {
              if (!alive) return
              setState({ phase: 'error', text: '', error: errText(error), truncated: false })
            })
          return function () { alive = false }
        }, [path, enabled, store.version])

        return state
      }

      function ErrorBox(props) {
        var text = String(props.text || '')
        var hint = null
        if (/dubious ownership/i.test(text)) {
          hint = h('div', { className: 'dnc-hint' },
            '这个报错的意思是：vault 目录的属主不是当前用户，git 拒绝操作。修复：',
            h('div', { style: { marginTop: '6px' } },
              h('code', { className: 'dnc-code' }, 'git config --global --add safe.directory ' + store.vault)),
            h('div', { style: { marginTop: '6px' } }, '（用提权/管理员身份创建的目录一定会命中这一条。）'))
        } else if (/not a git repository|不是 git 仓库/i.test(text)) {
          hint = h('div', { className: 'dnc-hint' },
            '这个目录还不是 git 仓库。先在 vault 里 ',
            h('code', { className: 'dnc-code' }, 'git init'), ' 并提交一次。')
        }
        return h('div', { className: 'dnc-errorbox' },
          h('div', { className: 'dnc-errtext' }, text), hint)
      }

      /** 时间线：日期在前作标题，隐藏 hash 与作者（hash 放 title 提示）。 */
      /**
       * 置顶气泡避让。
       * 气泡置顶打开、且最后一条提问被滚出会话区上沿时会钉在会话区顶部，
       * 右对齐、宽度可达「列宽 × .55」，底衬 ::before 再外扩 -.4em —— 会和右栏面板重叠。
       * 这里实时量它的底边，把面板往下推刚好让开的距离（有上限，不会把面板推出视口）。
       * 用户手动拖过位置后就不再自动推（尊重手动摆放；双击标题栏复位会重新启用）。
       *
       * 注意：本机浏览器实例里会话不可滚动 ⇒ 钉不出来 ⇒ 无法用真实气泡验证；
       * 用注入一个 [data-cc-pin="1"] 假元素的方式测过响应逻辑。
       */
      function usePinAvoid(enabled) {
        var pair = React.useState(0)
        var shift = pair[0]
        var setShift = pair[1]

        React.useEffect(function () {
          if (!enabled) { setShift(0); return undefined }
          var frame = 0

          function compute() {
            frame = 0
            var panel = document.querySelector('.dnc-panel')
            if (!panel) return
            var pin = document.querySelector('[data-cc-pin="1"]')
            var next = 0
            if (pin) {
              var pinRect = pin.getBoundingClientRect()
              var panelRect = panel.getBoundingClientRect()
              var overlapX = Math.min(pinRect.right, panelRect.right) - Math.max(pinRect.left, panelRect.left)
              if (overlapX > 0 && pinRect.height > 0) {
                // ⚠️ 必须用「未偏移」的基准位置算，不能用当前 rect：
                // 位移本身会改变 rect，用当前值算会形成反馈回路 ——
                // 推下去 58px 后重算出 next=0，于是又弹回中间，来回振荡（实测踩到过）。
                var baseTop = window.innerHeight / 2 - panelRect.height / 2
                var baseBottom = baseTop + panelRect.height
                next = Math.max(0, Math.round(pinRect.bottom + 16 - baseTop))
                // 别把面板推出视口底部（给输入区留 96px）
                var room = Math.max(0, Math.floor(window.innerHeight - 96 - baseBottom))
                if (next > room) next = room
              }
            }
            setShift(function (prev) { return Math.abs(prev - next) > 1 ? next : prev })
          }

          function schedule() { if (!frame) frame = window.requestAnimationFrame(compute) }

          compute()
          var scroller = document.querySelector('[data-conversation-scroll]')
          if (scroller) scroller.addEventListener('scroll', schedule, { passive: true })
          window.addEventListener('resize', schedule)
          var timer = window.setInterval(compute, 1000)
          return function () {
            if (frame) window.cancelAnimationFrame(frame)
            if (scroller) scroller.removeEventListener('scroll', schedule)
            window.removeEventListener('resize', schedule)
            window.clearInterval(timer)
          }
        }, [enabled])

        return shift
      }

      function Timeline(props) {
        // state 由调用方传进来 —— 以前这里自己再 useScan() 一次，抽屉展开时会发两遍同一个请求。
        var state = props.state
        // 过滤框（v1.7.0）：hook 必须排在下面所有提前 return 之前，否则 loading→ready
        // 时 hook 数量变化，React 抛 "Rendered more hooks than during the previous render"。
        var filterPair = React.useState('')
        var rawQuery = filterPair[0]
        var setQuery = filterPair[1]

        if (state.phase === 'loading') return h('div', { className: 'dnc-muted' }, '正在读取 git 历史…')
        if (state.phase === 'error') return h(ErrorBox, { text: state.error })

        var all = state.commits || []
        var query = rawQuery.trim().toLowerCase()
        var commits = query.length === 0 ? all : all.filter(function (c) {
          var hay = String(c.subject || '') + ' ' + String(c.date || '') + ' '
            + String(c.author || '') + ' ' + (c.files || []).join(' ')
          return hay.toLowerCase().indexOf(query) >= 0
        })

        // 按日期分组：日期作一级标题，当天所有改动挂在它下面作二级条目，
        // 不再每条都重复一遍日期。
        var groups = []
        var indexOfDate = {}
        for (var n = 0; n < commits.length; n++) {
          var commit = commits[n]
          var day = String(commit.date || '(无日期)')
          if (indexOfDate[day] === undefined) {
            indexOfDate[day] = groups.length
            groups.push({ date: day, items: [] })
          }
          groups[indexOfDate[day]].items.push(commit)
        }

        var rendered = groups.map(function (group) {
          var items = group.items.map(function (c) {
            var fileList = (c.files && c.files.length > 0)
              ? h('ul', { className: 'dnc-files' }, c.files.map(function (f, i) {
                  return h('li', { key: String(f) + '#' + String(i) }, f)
                }))
              : h('div', { className: 'dnc-nofile' }, '这次提交没有改动 md 笔记')

            return h('div', {
              key: String(c.hash),
              className: 'dnc-item',
              title: String(c.hash) + ' · ' + String(c.author || ''),
            },
            h('div', { className: 'dnc-subject' }, c.subject),
            fileList)
          })

          return h('div', { key: group.date, className: 'dnc-group' },
            h('div', { className: 'dnc-groupDate' }, group.date),
            h('div', { className: 'dnc-groupBody' }, items))
        })

        return h('div', null,
          h('div', { className: 'dnc-count' },
            String(commits.length) + (query.length > 0 ? ' / ' + String(all.length) : '')
            + ' 次提交 · ' + String(groups.length) + ' 天 · ' + state.vault),
          all.length > 0 ? h('input', {
            type: 'search',
            className: 'dnc-filter',
            placeholder: '过滤：标题 / 日期 / 作者 / 文件名',
            value: rawQuery,
            onChange: function (event) { setQuery(event.target.value) },
          }) : null,
          all.length === 0 ? h('div', { className: 'dnc-muted' }, '这个仓库还没有提交。')
            : (commits.length === 0 ? h('div', { className: 'dnc-muted' }, '没有匹配的提交。') : rendered))
      }

      /** 底部拉杆抽屉：列出这批改动碰过的笔记，点开直接读正文。 */
      function KnowledgeDrawer(props) {
        var pathPair = React.useState(null)
        var openPath = pathPair[0]
        var setOpenPath = pathPair[1]
        var copiedPair = React.useState('')
        var copied = copiedPair[0]
        var setCopied = copiedPair[1]
        var noteState = useNote(openPath, openPath != null)

        var paths = props.paths || []
        if (paths.length === 0) return null

        var rows = paths.map(function (p) {
          var isOpen = openPath === p
          return h('div', { key: p },
            h('button', {
              type: 'button',
              className: 'dnc-krow' + (isOpen ? ' open' : ''),
              title: p,
              onClick: function () { setOpenPath(isOpen ? null : p) },
            },
            h('span', { className: 'dnc-caret' }, isOpen ? '▾' : '▸'),
            h('span', { className: 'dnc-kname' }, noteLabel(p)),
            h('span', { className: 'dnc-muted' }, String(p.split('/')[0] || '')),
            ),
            isOpen ? (
              noteState.phase === 'loading' ? h('div', { className: 'dnc-muted', style: { padding: '6px 10px' } }, '正在读取…')
                : noteState.phase === 'error' ? h('div', { className: 'dnc-kdrawer' }, h(ErrorBox, { text: noteState.error }))
                  : h('div', { className: 'dnc-doc' },
                      // 只读预览到这里就够了，真正要改笔记得去 Obsidian —— 但这台 GUI 打不开外部协议，
                      // 所以给的是"复制路径"（Obsidian 里 Ctrl+O 粘进去）而不是一个点了没反应的链接
                      h('div', { className: 'dnc-docbar' },
                        h('button', {
                          type: 'button',
                          className: 'dnc-open',
                          title: '复制库内路径（' + p + '）—— 到 Obsidian 里 Ctrl+O 粘贴即可打开',
                          onClick: function () { setCopied(copyRelPath(p) ? p : '') },
                        }, copied === p ? '已复制' : '复制路径')),
                      noteState.truncated ? h('div', { className: 'dnc-doctrunc' }, '（文件太长，已截断显示）') : null,
                      renderDoc(noteState.text))
            ) : null)
        })

        return h('div', { className: 'dnc-kdrawer' }, rows)
      }

      function ReloadButton() {
        return h(ActionButton, {
          variant: 'ghost', size: 'sm',
          icon: icon('IconRefreshOutline16'),
          title: '重新读取',
          onClick: function () { bump() },
        }, '重新读取')
      }

      // ---- 面板拖拽 ----
      // 为什么需要它：右侧边缘是多方争用的位置——置顶气泡（会话区顶部、右对齐，
      // 上限 列宽×.55）、dsh-browser-live 的观察窗（z 2147483460，全场最高）都会压到这里。
      // 靠固定位置永远摆不平，交给用户自己拖最实在。位置记在 localStorage，
      // 双击标题栏复位回「靠右 + 上下居中」。
      var dragState = null

      function onDragMove(event) {
        if (!dragState) return
        var right = dragState.startRight - (event.clientX - dragState.startX)
        var top = dragState.startTop + (event.clientY - dragState.startY)
        right = Math.max(0, Math.min(window.innerWidth - 140, right))
        top = Math.max(0, Math.min(window.innerHeight - 80, top))
        var next = { right: Math.round(right), top: Math.round(top) }
        if (dragState.setPos) dragState.setPos(next)
        dragState.last = next
      }

      function onDragEnd() {
        if (!dragState) return
        window.removeEventListener('mousemove', onDragMove)
        window.removeEventListener('mouseup', onDragEnd)
        if (dragState.last) savePanelPos(dragState.last)
        dragState = null
      }

      function beginDrag(event, setPos) {
        if (event.button !== 0) return
        var target = event.target
        // 别抢标题栏里按钮的点击
        if (target && typeof target.closest === 'function' && target.closest('button')) return
        var panel = document.querySelector('.dnc-panel')
        if (!panel) return
        var rect = panel.getBoundingClientRect()
        dragState = {
          startX: event.clientX,
          startY: event.clientY,
          startRight: window.innerWidth - rect.right,
          startTop: rect.top,
          setPos: setPos,
          last: null,
        }
        event.preventDefault()
        window.addEventListener('mousemove', onDragMove)
        window.addEventListener('mouseup', onDragEnd)
      }

      function Drawer() {
        var panelPair = React.useState(false)
        var open = panelPair[0]
        var setOpen = panelPair[1]
        var drawerPair = React.useState(false)
        var kOpen = drawerPair[0]
        var setKOpen = drawerPair[1]
        // 自定义位置：null = 默认（靠右 + 上下居中）
        var posPair = React.useState(loadPanelPos())
        var pos = posPair[0]
        var setPos = posPair[1]
        // 置顶气泡避让（必须无条件调用：hook 不能放在提前 return 之后）
        var pinShift = usePinAvoid(open && !pos)

        // ⚠️ hook 必须在任何提前 return 之前调用完：useScan 里含 useState/useEffect，
        // 若放到下面 `if (!open) return` 之后，open 由 false 变 true 时 hook 数量变化，
        // React 会抛 "Rendered more hooks than during the previous render" 并卸载整棵子树。
        var scan = useScan()

        if (!open) {
          return h('button', {
            type: 'button', className: 'dnc-tab', title: '展开「笔记改动」',
            onClick: function () { setOpen(true) },
          }, '笔记改动')
        }

        // 底部抽屉的候选笔记 = 时间线里出现过的 .md（去重、保序、限 12 条）
        var seen = {}
        var paths = []
        // scanVault 开启时，把关键词索引钉在第一位 —— 一条点击就能到"先查哪里"
        if (store.settings.scanVault === true) {
          var INDEX_REL = '00-索引/关键词索引.md'
          seen[INDEX_REL] = 1
          paths.push(INDEX_REL)
        }
        for (var i = 0; i < (scan.commits || []).length; i++) {
          var files = scan.commits[i].files || []
          for (var j = 0; j < files.length; j++) {
            var f = String(files[j])
            if (!seen[f]) { seen[f] = 1; paths.push(f) }
            if (paths.length >= 12) break
          }
          if (paths.length >= 12) break
        }

        return h('div', {
          className: 'dnc-panel',
          style: pos
            ? { right: String(pos.right) + 'px', top: String(pos.top) + 'px', transform: 'none' }
            : (pinShift > 0 ? { transform: 'translateY(calc(-50% + ' + String(pinShift) + 'px))' } : null),
        },
          h('div', {
            className: 'dnc-head',
            title: '拖动可移动面板 · 双击复位到居中',
            onMouseDown: function (event) { beginDrag(event, setPos) },
            onDoubleClick: function () { setPos(null); savePanelPos(null) },
          },
            h('span', { className: 'dnc-title' }, '笔记改动'),
            h(ReloadButton, null),
            h(ActionButton, {
              variant: 'ghost', size: 'sm',
              icon: icon('IconCloseOutline16'), title: '收起',
              onClick: function () { setOpen(false) },
            })
          ),
          h('div', { className: 'dnc-body' }, h(Timeline, { state: scan })),
          kOpen ? h(KnowledgeDrawer, { paths: paths }) : null,
          paths.length > 0 ? h('button', {
            type: 'button', className: 'dnc-kbar',
            title: kOpen ? '收起相关笔记' : '展开相关笔记',
            onClick: function () { setKOpen(!kOpen) },
          },
          h('span', { className: 'dnc-caret' }, kOpen ? '▾' : '▴'),
          h('span', { className: 'dnc-kbarLabel' }, '相关笔记 · ' + String(paths.length) + ' 条'),
          h('span', { className: 'dnc-muted' }, '点开可读正文')
          ) : null
        )
      }

      /**
       * 回执时间戳转本地 MM-DD HH:mm。Host 给的是 `new Date().toISOString()`（UTC），
       * 直接截字符串会显示成 UTC 时间 —— 实测差 8 小时（`…T04:03Z` 显示 04:03，本地其实是 12:03）。
       */
      function localStamp(iso) {
        var d = new Date(iso)
        if (!iso || isNaN(d.getTime())) return String(iso || '').slice(5, 16).replace('T', ' ')
        var p = function (n) { return (n < 10 ? '0' : '') + n }
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      }

      /** 重试同步：本地已有的提交再推一次（网络/沙箱导致的 push 失败用这个，不会新建提交）。 */
      function RetrySyncButton() {
        var busy = store.syncPhase === 'running'
        return h(ActionButton, {
          variant: 'ghost', size: 'sm',
          icon: icon('IconRefreshOutline16'),
          title: busy ? '正在推送…' : '把本地已有的提交再推一次（不改文件、不新建提交）',
          onClick: function () { syncNow() },
        }, busy ? '推送中…' : '重试同步')
      }

      /** 两个开关的渲染：设置页与输入框 chip 共用同一份，避免两处行为不一致。 */
      function ToggleRows(props) {
        return h('div', { className: 'dnc-toggles' },
          store.settingsError
            ? h('div', { className: 'dnc-errorbox', style: { marginBottom: '10px' } },
                h('div', { className: 'dnc-errtext' }, '设置读写失败：' + store.settingsError),
                h('div', { className: 'dnc-hint' },
                  '设置存在 ', h('code', { className: 'dnc-code' }, store.settingsSource || '00-索引/插件设置.md'),
                  ' 里。写不进去时开关会弹回原值——这是失败的表现，不是开关坏了。'))
            : h('div', { style: { marginBottom: '8px' } },
                '设置来源：', h('code', { className: 'dnc-code' }, store.settingsSource || '00-索引/插件设置.md'),
                store.settingsPhase === 'saving' ? ' · 写入中…'
                  : (store.settingsPhase === 'ready' ? ' · 已同步' : '')),
          h('label', { className: 'dnc-toggle' },
            h('input', {
              type: 'checkbox',
              checked: store.settings.scanVault === true,
              onChange: function (event) { saveSettings({ scanVault: event.target.checked }) },
            }),
            h('span', null, '出错时优先查本库')),
          h('div', null,
            '实际行为由 ', h('code', { className: 'dnc-code' }, 'AGENTS.md'),
            ' 的 §0 保证——插件开关管不住 AI 去不去查。开启时「相关笔记」会把 ',
            h('code', { className: 'dnc-code' }, '关键词索引'), ' 钉在第一位。'),
          h('label', { className: 'dnc-toggle' },
            h('input', {
              type: 'checkbox',
              checked: store.settings.autoWriteOnSessionEnd === true,
              onChange: function (event) { saveSettings({ autoWriteOnSessionEnd: event.target.checked }) },
            }),
            h('span', null, '收工自动写入要点')),
          h('div', null,
            '关掉后：AI 调用写入工具会被拒绝，事件兜底也不再补存根——一条都不会写。'),
          // 同步回执（v1.7.0）：push 失败原本只写在工具回执里，回执滚走后就没人看得见了
          h('div', { className: 'dnc-hint' },
            store.lastSync
              ? '上次同步 ' + (store.lastSync.ok ? '成功' : '失败') + ' · '
                + localStamp(store.lastSync.at)
                + ' · ' + String(store.lastSync.note || '').replace(/^[，、（]|[）]/g, '')
              : '本次运行还没有同步回执（Host 重启即清空，写入后自动同步会填上）。',
            store.syncError ? ' · ' + store.syncError : null,
            h('br', null),
            h(RetrySyncButton, null))
        )
      }

      /**
       * 输入框右侧的小 chip（位置对齐「会话策略」那个）。
       * 点开是浮层，里面就是那两个开关——不进设置页也能直接控制。
       */
      function ComposerChip() {
        // ⚠️ 必须订阅：否则 saveSettings 之后的 bump() 不会让它重渲染（坑 13 的教训）
        useVersion()
        var pair = React.useState(false)
        var open = pair[0]
        var setOpen = pair[1]
        var posPair = React.useState(null)
        var pos = posPair[0]
        var setPos = posPair[1]

        React.useEffect(function () {
          if (!open) return undefined
          function place() {
            var el = document.getElementById('dnc-chip')
            if (!el) return
            var rect = el.getBoundingClientRect()
            var width = 300
            var left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
            var bottom = Math.max(8, window.innerHeight - rect.top + 8)
            setPos({ left: Math.round(left), bottom: Math.round(bottom) })
          }
          place()
          window.addEventListener('resize', place)
          return function () { window.removeEventListener('resize', place) }
        }, [open])

        var autoOn = store.settings.autoWriteOnSessionEnd === true
        var chip = h('button', {
          id: 'dnc-chip',
          type: 'button',
          className: 'dnc-chip' + (open ? ' on' : ''),
          title: '笔记改动：写入开关（收工自动写入 ' + (autoOn ? '开' : '关') + '）',
          onClick: function () { setOpen(!open) },
        },
        h('span', { className: 'dnc-chipDot' + (autoOn ? ' on' : '') }),
        h('span', null, '笔记'))

        if (!open) return chip

        return h('span', { className: 'dnc-chipWrap' },
          chip,
          h('div', {
            className: 'dnc-pop',
            style: pos
              ? { left: String(pos.left) + 'px', bottom: String(pos.bottom) + 'px' }
              : { visibility: 'hidden' },
          },
          h('div', { className: 'dnc-popHead' },
            h('span', { className: 'dnc-popTitle' }, '笔记改动'),
            h('button', {
              type: 'button', className: 'dnc-popClose', title: '关闭',
              onClick: function () { setOpen(false) },
            }, '✕')),
          h(ToggleRows, null)))
      }

      function SettingsPage() {
        // ⚠️ 必须订阅 store：否则 bump()（写入成功/失败都会触发）不会让它重渲染，
        // 表现就是「开关怎么按都是开、失败也看不见」。v1.3.0 漏了这一行。
        useVersion()
        var draftPair = React.useState(store.vault)
        var draft = draftPair[0]
        var setDraft = draftPair[1]
        var scan = useScan()

        return h('div', { className: 'dnc-wrap' },
          h('h3', { className: 'dnc-h' }, '笔记改动'),
          h('p', { className: 'dnc-p' },
            '上半是 vault 的 git 改动历史（只读，不提交、不推送）。'
            + '下半的两个开关控制**往本库写入**的行为：AI 收工写要点、以及兜底存根。'
            + 'v1.6.0 起写入落盘后会立刻 git add + commit + push（只加刚写的那个文件），'
            + '所以换设备只需要 git pull；推送失败不会丢内容，只会在回执里附一句原因。'
            + '这些开关存在 ', h('code', { className: 'dnc-code' }, '00-索引/插件设置.md'),
            ' 的 frontmatter 里，随 git 同步到每台设备。'
            + '输入框右侧的「笔记」chip 是同一组开关的快捷入口。'),
          h('div', { className: 'dnc-label' }, 'vault 路径'),
          h('div', { className: 'dnc-field' }, h(VaultInput, {
            value: draft, placeholder: store.vaultPath || DEFAULT_VAULT,
            onChange: function (event) { setDraft(event.target.value) },
          })),
          h('p', { className: 'dnc-p' },
            '留空 = 跟随本机引导。当前生效：',
            h('code', { className: 'dnc-code' }, store.vaultPath || store.vault || '（未解析）'),
            store.vaultSource ? h('span', null, ' · 依据：' + (SOURCE_LABELS[store.vaultSource] || store.vaultSource)) : null,
            h('br', null),
            '换机器只需在 ', h('code', { className: 'dnc-code' }, '$DSH_HOME/dsh-note-changes/vault.txt'),
            ' 里写一行本机路径（或设环境变量 DNC_VAULT），不必在这儿填；这里填了则是本浏览器的显式覆盖，优先级最高。'),
          h(ToggleRows, { compact: false }),
          h('div', { className: 'dnc-bar' },
            h(ActionButton, {
              variant: 'primary', size: 'sm', title: '把这个路径设成本浏览器的显式覆盖，并重新读取',
              onClick: function () { setVault(draft) },
            }, '应用'),
            h(ActionButton, {
              variant: 'ghost', size: 'sm', title: '清掉本机覆盖，改由环境变量 / 指针文件 / 设置文件决定',
              onClick: function () { setVault('', true); setDraft('') },
            }, '跟随本机引导'),
            h(ReloadButton, null)
          ),
          h(Timeline, { state: scan })
        )
      }

      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'note-changes-drawer', order: 45, label: '笔记改动' },
          function () { return h(Drawer) }
        )
      })

      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'note-changes', order: 65, label: '笔记改动' },
          function () { return h(SettingsPage) }
        )
      })

      // 输入框右侧：与「会话策略」(order 200)、「图片/视频提示词」(210) 并排
      slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'note-changes', order: 205, label: '笔记改动' },
          function () { return h(ComposerChip, null) }
        )
      })

      // 设置来自 vault 文件：开页面时拉一次（localStorage 只做首屏兜底）
      try { loadSettings() } catch (err) { console.error('[dsh-note-changes] loadSettings 失败', err) }

      console.log('[dsh-note-changes] client up (v1.7.0), primitives=' + (P ? 'yes' : 'no')
        + ', titlebarInset=' + String(TITLEBAR_INSET))
    }

    var inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    exports.internals = {
      DEFAULT_VAULT: DEFAULT_VAULT,
      LOG_PATH: LOG_PATH,
      NOTE_PATH: NOTE_PATH,
      SETTINGS_PATH: SETTINGS_PATH,
      SYNC_PATH: SYNC_PATH,
    }

    return module.exports
  },
})
