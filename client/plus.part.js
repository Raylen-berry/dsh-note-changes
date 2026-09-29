// Pure helpers are shared by the UI and offline regression checks.
function mergeSections(disk, draft) {
  var a = disk.match(/[^\n]*\n|[^\n]+$/g) || [],
    b = draft.match(/[^\n]*\n|[^\n]+$/g) || []
  if (a.length * b.length > 500000 || a.length + b.length > 3000)
    return disk === draft ? [{ same: disk }] : [{ disk, draft, large: true }]
  var table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (var i = a.length - 1; i >= 0; i--)
    for (var j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  var out = [],
    x = 0,
    y = 0
  function add(type, text) {
    var last = out[out.length - 1]
    if (!last || (type === 'same') !== 'same' in last)
      out.push((last = type === 'same' ? { same: '' } : { disk: '', draft: '' }))
    last[type] += text
  }
  while (x < a.length || y < b.length) {
    if (x < a.length && y < b.length && a[x] === b[y]) {
      add('same', a[x++])
      y++
    } else if (x < a.length && (y === b.length || table[x + 1][y] >= table[x][y + 1]))
      add('disk', a[x++])
    else add('draft', b[y++])
  }
  return out
}
function composeMerge(sections, choices) {
  return sections
    .map((s, i) => {
      if ('same' in s) return s.same
      if (choices[i] === 'disk') return s.disk
      if (choices[i] === 'draft') return s.draft
      if (choices[i] === 'both')
        return s.disk + (s.disk && !s.disk.endsWith('\n') && s.draft ? '\n' : '') + s.draft
      throw new Error('还有差异未选择')
    })
    .join('')
}
function MergeView({ disk, draft, onApply, onCancel }) {
  var sections = React.useMemo(() => mergeSections(disk.text, draft), [disk.text, draft]),
    [choices, setChoices] = React.useState({}),
    pending = sections.filter((s, i) => !('same' in s) && !choices[i]).length
  return h(
    'section',
    { className: 'dnc-merge', 'aria-label': '对照合并' },
    h(
      'div',
      { className: 'dnc-merge-head' },
      h('h2', null, '把两边的修改留下来'),
      h('p', null, '相同内容自动保留。每个差异分别选择，合并后仍需保存。'),
      h(Button, { onClick: onCancel }, '返回草稿'),
      h(
        Button,
        {
          className: 'dnc-primary',
          disabled: pending > 0,
          onClick: () => onApply(composeMerge(sections, choices), disk),
        },
        pending ? '还有 ' + pending + ' 处待选择' : '应用合并到草稿',
      ),
    ),
    sections.map((s, i) =>
      'same' in s
        ? h(
            'details',
            { key: i, className: 'dnc-unchanged' },
            h('summary', null, '相同内容 · ' + s.same.split('\n').length + ' 行'),
            h('pre', null, s.same),
          )
        : h(
            'article',
            { key: i, className: 'dnc-change' },
            h(
              'div',
              { className: 'dnc-diff-columns' },
              h('div', null, h('h3', null, '磁盘新版'), h('pre', null, s.disk || '（此处为空）')),
              h('div', null, h('h3', null, '你的草稿'), h('pre', null, s.draft || '（此处为空）')),
            ),
            s.large ? h('p', null, '内容较长，按整篇对照；也可以返回编辑器手动调整。') : null,
            h(
              'div',
              { className: 'dnc-choice' },
              [
                ['disk', '保留磁盘'],
                ['draft', '保留草稿'],
                ['both', '两段都保留'],
              ].map(([value, label]) =>
                h(
                  Button,
                  {
                    key: value,
                    'aria-pressed': choices[i] === value,
                    onClick: () => setChoices({ ...choices, [i]: value }),
                  },
                  label,
                ),
              ),
            ),
          ),
    ),
  )
}
function localDay() {
  var d = new Date()
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}
function templateText(kind, path) {
  var title = noteLabel(path) || '未命名',
    date = localDay()
  if (kind === 'daily')
    return (
      '---\ndate: ' +
      date +
      '\ntags: [日记]\n---\n# ' +
      title +
      '\n\n## 今天的片段\n\n\n## 想做的事\n\n- [ ] \n\n## 留给明天\n\n'
    )
  if (kind === 'meeting')
    return (
      '---\ndate: ' +
      date +
      '\ntags: [会议]\nstatus: 待整理\n---\n# ' +
      title +
      '\n\n## 讨论\n\n\n## 决定\n\n\n## 下一步\n\n- [ ] \n'
    )
  return '# ' + title + '\n\n'
}
function CreateNote({ vault, notes, daily, onClose, onCreated, onOpen }) {
  var [kind, setKind] = React.useState(daily ? 'daily' : 'blank'),
    [path, setPath] = React.useState(daily ? '00-收件箱/日记/' + localDay() + '.md' : ''),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState(''),
    form = React.useRef(null)
  React.useEffect(() => {
    var previous = document.activeElement
    return () => previous?.focus?.()
  }, [])
  var rel = path.trim().replace(/\\/g, '/'),
    finalPath = rel && (/\.md$/i.test(rel) ? rel : rel + '.md'),
    existing = notes.find((n) => n.path.toLowerCase() === finalPath.toLowerCase()),
    text = templateText(kind, finalPath)
  async function create(e) {
    e.preventDefault()
    if (!finalPath || busy) return
    setBusy(true)
    setError('')
    try {
      var result = await api(url(CREATE_PATH, vault), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dnc-editor': '1' },
        body: JSON.stringify({ path: finalPath, text }),
      })
      onCreated(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  return h(
    'div',
    { className: 'dnc-modal' },
    h(
      'form',
      {
        ref: form,
        className: 'dnc-create',
        role: 'dialog',
        'aria-modal': true,
        'aria-label': '新建笔记',
        onSubmit: create,
        onKeyDown: (e) => {
          if (e.key === 'Escape' && !busy) onClose()
          if (e.key === 'Tab') {
            var nodes = [
                ...form.current.querySelectorAll(
                  'button:not(:disabled),input:not(:disabled),select:not(:disabled)',
                ),
              ],
              first = nodes[0],
              last = nodes[nodes.length - 1]
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault()
              last?.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault()
              first?.focus()
            }
          }
        },
      },
      h('h2', null, daily ? '给今天留一页' : '从一页空白开始'),
      h(
        'label',
        null,
        '笔记路径',
        h('input', {
          autoFocus: true,
          required: true,
          value: path,
          disabled: busy,
          placeholder: '例如 想法/雨天的颜色',
          onChange: (e) => setPath(e.target.value),
        }),
      ),
      h(
        'label',
        null,
        '模板',
        h(
          'select',
          {
            'aria-label': '模板',
            value: kind,
            disabled: busy,
            onChange: (e) => setKind(e.target.value),
          },
          [
            ['blank', '空白笔记'],
            ['daily', '每日记录'],
            ['meeting', '会议记录'],
          ].map(([k, v]) => h('option', { key: k, value: k }, v)),
        ),
      ),
      h('pre', { className: 'dnc-template' }, text),
      h(ErrorBox, { text: error }),
      existing
        ? h(
            'p',
            null,
            '这篇笔记已经存在。',
            h(
              Button,
              {
                onClick: () => {
                  onClose()
                  onOpen(existing.path)
                },
              },
              '打开已有笔记',
            ),
          )
        : null,
      h(
        'div',
        { className: 'dnc-actions' },
        h(Button, { disabled: busy, onClick: onClose }, '取消'),
        h(
          'button',
          { type: 'submit', className: 'dnc-primary', disabled: busy || !finalPath || !!existing },
          busy ? '创建中…' : '创建并编辑',
        ),
      ),
    ),
  )
}
function useCollections(vault, selected) {
  var key = 'dnc:collections:' + vault,
    [state, setState] = React.useState({ key: '', favorites: [], recent: [] })
  function persist(value) {
    setState(value)
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (_) {}
  }
  React.useEffect(() => {
    var data
    try {
      data = JSON.parse(stored(window.localStorage, key, '{}'))
    } catch (_) {}
    var clean = (value) =>
      Array.isArray(value) ? value.filter((x) => typeof x === 'string').slice(0, 250) : []
    setState({ key, favorites: clean(data?.favorites), recent: clean(data?.recent).slice(0, 12) })
  }, [key])
  React.useEffect(() => {
    if (state.key === key && selected && state.recent[0] !== selected)
      persist({
        ...state,
        recent: [selected, ...state.recent.filter((p) => p !== selected)].slice(0, 12),
      })
  }, [key, selected, state])
  return {
    favorites: state.key === key ? state.favorites : [],
    recent: state.key === key ? state.recent : [],
    toggle: (path) => {
      if (state.key !== key) return
      persist({
        ...state,
        favorites: state.favorites.includes(path)
          ? state.favorites.filter((p) => p !== path)
          : [...state.favorites, path].slice(-250),
      })
    },
  }
}
function buildGraph(notes) {
  var byPath = new Map(notes.map((n) => [n.path, n])),
    byName = new Map(),
    edges = [],
    linked = new Set(),
    seen = new Set()
  notes.forEach((n) => {
    var name = noteLabel(n.path)
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(n)
  })
  notes.forEach((n) =>
    (n.links || []).forEach((link) => {
      var clean = link.split('#')[0].replace(/\.md$/i, ''),
        sibling = n.path
          .split('/')
          .slice(0, -1)
          .concat(clean + '.md')
          .join('/'),
        exact = [byPath.get(clean + '.md'), byPath.get(sibling)].filter(Boolean),
        matches = clean ? (exact.length ? exact : byName.get(clean) || []) : [n]
      var unique = [...new Set(matches.map((m) => m.path))]
      if (unique.length !== 1 || unique[0] === n.path) return
      var to = unique[0],
        id = n.path + '\n' + to
      if (!seen.has(id)) {
        seen.add(id)
        edges.push({ from: n.path, to })
        linked.add(n.path)
        linked.add(to)
      }
    }),
  )
  return { edges, orphans: notes.filter((n) => !linked.has(n.path)) }
}
function GraphView({ notes, selected, graph, partial, onOpen }) {
  var edges = graph.edges.filter((e) => e.from === selected || e.to === selected),
    peers = [...new Set(edges.flatMap((e) => [e.from, e.to]).filter((p) => p !== selected))],
    shown = peers.slice(0, 18),
    points = new Map([[selected, [360, 220]]])
  shown.forEach((p, i) => {
    var angle = (i / shown.length) * Math.PI * 2 - Math.PI / 2
    points.set(p, [360 + Math.cos(angle) * 235, 220 + Math.sin(angle) * 160])
  })
  return h(
    'div',
    { className: 'dnc-page dnc-graph' },
    h('div', { className: 'dnc-eyebrow' }, 'LOCAL CONNECTIONS'),
    h('h2', null, '一个念头，通向哪里'),
    h(
      'p',
      { className: 'dnc-notice' },
      '以「' +
        noteLabel(selected) +
        '」为中心 · ' +
        peers.length +
        ' 篇相邻笔记' +
        (peers.length > 18 ? '，图中展示前 18 篇' : '') +
        (partial ? ' · 部分文件尚未索引' : ''),
    ),
    h(
      'svg',
      { viewBox: '0 0 720 440', role: 'group', 'aria-label': '当前笔记的局部关系图' },
      edges
        .filter((e) => points.has(e.from) && points.has(e.to))
        .map((e, i) =>
          h('line', {
            key: 'e' + i,
            x1: points.get(e.from)[0],
            y1: points.get(e.from)[1],
            x2: points.get(e.to)[0],
            y2: points.get(e.to)[1],
            className: e.from === selected ? 'dnc-edge-out' : 'dnc-edge-in',
          }),
        ),
      [...points]
        .filter(([p]) => p)
        .map(([p, pos]) =>
          h(
            'g',
            {
              key: p,
              role: 'button',
              tabIndex: 0,
              'aria-label': '打开 ' + p,
              onClick: () => onOpen(p),
              onKeyDown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen(p)
                }
              },
            },
            h('title', null, p),
            h('rect', {
              x: pos[0] - 85,
              y: pos[1] - 18,
              width: 170,
              height: 56,
              fill: 'transparent',
            }),
            h('circle', {
              cx: pos[0],
              cy: pos[1],
              r: p === selected ? 16 : 9,
              className: p === selected ? 'dnc-node-main' : 'dnc-node',
            }),
            h(
              'text',
              { x: pos[0], y: pos[1] + 32, textAnchor: 'middle' },
              noteLabel(p).slice(0, 14),
            ),
          ),
        ),
    ),
    h('p', { className: 'dnc-notice' }, '紫色实线：本篇链接到 · 灰色虚线：链接到本篇'),
    h(
      'div',
      { className: 'dnc-graph-links' },
      peers.map((p) => h(Button, { key: p, title: p, onClick: () => onOpen(p) }, noteLabel(p))),
    ),
    h('h3', null, '尚未连起来的笔记 · ' + graph.orphans.length),
    h('p', { className: 'dnc-notice' }, '这些笔记还没有与其他已索引笔记建立明确的双链。'),
    h(
      'div',
      { className: 'dnc-graph-links' },
      graph.orphans
        .slice(0, 50)
        .map((n) =>
          h(
            Button,
            { key: n.path, title: n.path, onClick: () => onOpen(n.path) },
            noteLabel(n.path),
          ),
        ),
    ),
    graph.orphans.length > 50 ? h('p', null, '左侧「孤立笔记」筛选可以查看全部。') : null,
  )
}
var mathLoader
function loadMath() {
  if (window.katex) return Promise.resolve(window.katex)
  if (!mathLoader)
    mathLoader = new Promise((resolve, reject) => {
      var css = document.createElement('link'),
        script = document.createElement('script')
      css.rel = 'stylesheet'
      css.href = url(VENDOR_PATH, '', { file: 'katex.min.css' })
      document.head.appendChild(css)
      script.src = url(VENDOR_PATH, '', { file: 'katex.min.js' })
      script.onload = () => resolve(window.katex)
      script.onerror = () => {
        script.remove()
        css.remove()
        mathLoader = null
        reject(new Error('公式资源未能加载'))
      }
      document.head.appendChild(script)
    })
  return mathLoader
}
function MathFormula({ text, display }) {
  var node = React.useRef(null),
    [failed, setFailed] = React.useState('')
  React.useEffect(() => {
    var alive = true
    if (text.length > 4000) {
      setFailed('公式过长，显示源码')
      return
    }
    loadMath()
      .then((katex) => {
        if (!alive || !node.current) return
        katex.render(text, node.current, {
          displayMode: !!display,
          throwOnError: false,
          trust: false,
          strict: 'ignore',
          maxSize: 10,
          maxExpand: 500,
          macros: {},
        })
      })
      .catch((e) => {
        if (alive) setFailed(e.message)
      })
    return () => {
      alive = false
    }
  }, [text, display])
  return h(
    'span',
    { className: 'dnc-math', 'data-display': !!display, title: failed || text },
    h('span', { ref: node }, text),
    failed ? h('small', null, ' · ' + failed) : null,
  )
}
function resolveAsset(target, current, assets) {
  var clean
  try {
    clean = decodeURIComponent(target.split('#')[0])
  } catch (_) {
    clean = target.split('#')[0]
  }
  if (/^[a-z][a-z\d+.-]*:|^[\\/]{2}/i.test(clean)) return []
  function normalize(value) {
    var parts = []
    for (var p of value.replace(/\\/g, '/').split('/')) {
      if (p === '..') {
        if (!parts.length) return ''
        parts.pop()
      } else if (p && p !== '.') parts.push(p)
    }
    return parts.join('/')
  }
  var sibling = normalize(current.split('/').slice(0, -1).concat(clean).join('/')),
    root = normalize(clean)
  var exact = assets.filter((a) => a.path === root || a.path === sibling)
  return exact.length
    ? exact
    : assets.filter((a) => !clean.includes('/') && a.path.split('/').pop() === clean)
}
function Attachment({ target, label, embed, context }) {
  var matches = resolveAsset(target, context?.path || '', context?.assets || []),
    [failed, setFailed] = React.useState(false)
  if (matches.length !== 1)
    return h(
      'span',
      { className: 'dnc-attachment-missing' },
      (label || target) +
        (matches.length ? '（同名附件，请使用完整路径）' : '（附件未找到或格式不支持）'),
    )
  var asset = matches[0],
    src = url(ASSET_PATH, context.vault, { path: asset.path }),
    tooLarge = asset.size > 20 * 1024 * 1024,
    link = h(
      'a',
      { href: src, target: '_blank', rel: 'noreferrer noopener', title: asset.path },
      label || asset.path.split('/').pop(),
    )
  if (tooLarge)
    return h(
      'span',
      { className: 'dnc-attachment-missing' },
      (label || target) + '（超过 20 MB，请在 Obsidian 中打开）',
    )
  if (!embed) return link
  if (asset.mime.startsWith('image/') && !failed)
    return h('img', {
      className: 'dnc-image',
      src,
      alt: label || target,
      loading: 'lazy',
      onError: () => setFailed(true),
    })
  if (asset.mime.startsWith('audio/'))
    return h(
      'span',
      { className: 'dnc-media' },
      h('audio', { src, controls: true, preload: 'none' }),
      link,
    )
  if (asset.mime.startsWith('video/'))
    return h(
      'span',
      { className: 'dnc-media' },
      h('video', { src, controls: true, preload: 'metadata' }),
      link,
    )
  return h(
    'span',
    { className: 'dnc-attachment' },
    asset.mime === 'application/pdf' ? 'PDF · ' : '附件 · ',
    link,
    failed ? '（预览失败）' : '',
  )
}
