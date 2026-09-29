var LOG_PATH = '/note-changes/log',
  NOTE_PATH = '/note-changes/note',
  SETTINGS_PATH = '/note-changes/settings',
  SYNC_PATH = '/note-changes/sync',
  LIBRARY_PATH = '/note-changes/library',
  SAVE_PATH = '/note-changes/save'
function stored(storage, key, fallback) {
  try {
    return storage.getItem(key) || fallback
  } catch (_) {
    return fallback
  }
}
function copyRelPath(text) {
  var ta = document.createElement('textarea'),
    focused = document.activeElement
  ta.value = String(text)
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  document.body.appendChild(ta)
  ta.select()
  var ok = false
  try {
    ok = document.execCommand('copy')
  } catch (_) {}
  ta.remove()
  if (focused && focused.focus) focused.focus()
  return ok
}
function url(route, vault, params) {
  var q = new URLSearchParams(params || {})
  if (vault) q.set('vault', vault)
  return route + (q.size ? '?' + q : '')
}
async function api(route, options) {
  var response = await fetch(route, options),
    body
  try {
    body = await response.json()
  } catch (_) {
    throw new Error('页面接口暂不可用，请重启 Desktop 后重试')
  }
  if (!body.ok) {
    var error = new Error(body.error || '请求失败')
    error.conflict = body.conflict
    throw error
  }
  return body
}
function useResource(route, vault, params, revision, enabled) {
  var [state, setState] = React.useState({ loading: false, data: null, error: '' }),
    query = JSON.stringify(params || {})
  React.useEffect(
    function () {
      if (enabled === false) {
        setState({ loading: false, data: null, error: '' })
        return
      }
      var controller = new AbortController(),
        alive = true
      setState({ loading: true, data: null, error: '' })
      api(url(route, vault, JSON.parse(query)), { signal: controller.signal })
        .then((data) => {
          if (alive) setState({ loading: false, data, error: '' })
        })
        .catch((e) => {
          if (alive) setState({ loading: false, data: null, error: e.message })
        })
      return () => {
        alive = false
        controller.abort()
      }
    },
    [route, vault, query, revision, enabled],
  )
  return state
}
function ErrorBox(props) {
  return props.text ? h('div', { className: 'dnc-error', role: 'alert' }, props.text) : null
}
function Button(props) {
  return h('button', { type: 'button', ...props }, props.children)
}
function Tree({ notes, current, onOpen }) {
  var tree = { files: [], folders: {} }
  notes.forEach((note) => {
    var parts = note.path.split('/'),
      branch = tree
    parts.slice(0, -1).forEach((name) => {
      branch = branch.folders[name] || (branch.folders[name] = { files: [], folders: {} })
    })
    branch.files.push(note)
  })
  function render(branch, prefix) {
    return [
      Object.entries(branch.folders).map(([name, child]) =>
        h(
          'details',
          { key: prefix + name, open: true },
          h('summary', null, name),
          h('div', null, render(child, prefix + name + '/')),
        ),
      ),
      branch.files.map((n) =>
        h(
          Button,
          {
            key: n.path,
            title: n.path,
            'aria-current': current === n.path ? 'page' : undefined,
            onClick: () => onOpen(n.path),
          },
          noteLabel(n.path),
        ),
      ),
    ]
  }
  return h('div', { className: 'dnc-tree' }, render(tree, ''))
}
function apply(ctx) {
  var slots = ctx.get('slots')
  if (!slots) return
  var style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  if (ctx.effect) ctx.effect(() => () => style.remove(), 'dsh-note-changes: styles')
  var override = stored(window.localStorage, 'dsh-note-changes:vault', ''),
    listeners = new Set()
  function setVault(v) {
    override = v
    try {
      if (v) window.localStorage.setItem('dsh-note-changes:vault', v)
      else window.localStorage.removeItem('dsh-note-changes:vault')
    } catch (_) {}
    listeners.forEach((f) => f(v))
  }
  function useVault() {
    var pair = React.useState(override)
    React.useEffect(() => {
      listeners.add(pair[1])
      return () => listeners.delete(pair[1])
    }, [])
    return pair[0]
  }

  function Settings({ vault, onRefresh }) {
    var [revision, setRevision] = React.useState(0),
      state = useResource(SETTINGS_PATH, vault, {}, revision),
      [draft, setDraft] = React.useState(vault),
      [busy, setBusy] = React.useState(false),
      [message, setMessage] = React.useState(''),
      [error, setError] = React.useState('')
    React.useEffect(() => setDraft(vault), [vault])
    var settings = state.data?.settings || {}
    async function update(patch) {
      setBusy(true)
      setError('')
      try {
        await api(url(SETTINGS_PATH, vault), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch }),
        })
        setRevision((n) => n + 1)
        setMessage('设置已保存')
        onRefresh?.()
      } catch (e) {
        setError(e.message)
      } finally {
        setBusy(false)
      }
    }
    async function sync() {
      setBusy(true)
      setError('')
      try {
        var result = await api(url(SYNC_PATH, vault), { method: 'POST' })
        setMessage(result.message || '已同步')
        setRevision((n) => n + 1)
      } catch (e) {
        setError(e.message)
      } finally {
        setBusy(false)
      }
    }
    return h(
      'div',
      { className: 'dnc-page' },
      h('h2', null, '笔记设置'),
      h(
        'p',
        { className: 'dnc-notice' },
        '连接你的本地 Obsidian 笔记库，浏览和编辑普通 Markdown 文件。',
      ),
      h(ErrorBox, { text: state.error || error }),
      h(
        'section',
        { className: 'dnc-setting' },
        h('h3', null, '笔记库'),
        h('label', { htmlFor: 'dnc-vault' }, '本机路径'),
        h('input', {
          id: 'dnc-vault',
          type: 'text',
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          placeholder: state.data?.vaultPath || '留空，跟随本机配置',
        }),
        h('p', null, '当前：' + (state.data?.vaultPath || vault || '等待连接')),
        h(
          Button,
          { className: 'dnc-primary', onClick: () => setVault(draft.trim()) },
          '连接笔记库',
        ),
        h(
          Button,
          {
            onClick: () => {
              setVault('')
              setDraft('')
            },
          },
          '跟随本机配置',
        ),
      ),
      h(
        'section',
        { className: 'dnc-setting' },
        h('h3', null, '记录与同步'),
        h(
          'label',
          null,
          h('input', {
            type: 'checkbox',
            checked: settings.scanVault === true,
            disabled: busy || !state.data,
            onChange: (e) => update({ scanVault: e.target.checked }),
          }),
          '允许 AI 读取笔记上下文',
        ),
        h(
          'label',
          null,
          h('input', {
            type: 'checkbox',
            checked: settings.autoWriteOnSessionEnd === true,
            disabled: busy || !state.data,
            onChange: (e) => update({ autoWriteOnSessionEnd: e.target.checked }),
          }),
          '会话结束时记录要点',
        ),
        h('p', null, '手动保存会保留全文与双链，并只提交当前文件。同步失败时，本地内容仍然保留。'),
        h(Button, { disabled: busy, onClick: sync }, busy ? '正在处理…' : '重试推送'),
        h('p', { role: 'status' }, message || state.data?.lastSync?.note || '还没有同步回执'),
      ),
    )
  }
  function History({ vault, onOpen, revision }) {
    var state = useResource(LOG_PATH, vault, {}, revision),
      [query, setQuery] = React.useState('')
    var commits = (state.data?.commits || []).filter((c) =>
      (c.subject + ' ' + c.date + ' ' + c.files.join(' '))
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    return h(
      'div',
      { className: 'dnc-page' },
      h('h2', null, '改动历史'),
      h('input', {
        className: 'dnc-search',
        type: 'search',
        'aria-label': '搜索改动历史',
        placeholder: '按日期、标题或文件名搜索',
        value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
      h(ErrorBox, { text: state.error }),
      state.loading
        ? h('p', null, '正在读取历史…')
        : commits.length
          ? commits.map((c) =>
              h(
                'article',
                { className: 'dnc-history', key: c.hash },
                h('time', null, c.date),
                h('h3', null, c.subject),
                c.files.map((p) => h(Button, { key: p, onClick: () => onOpen(p) }, noteLabel(p))),
              ),
            )
          : h('p', { className: 'dnc-notice' }, '没有匹配的改动记录。'),
    )
  }
  function Workspace() {
    var vault = useVault(),
      [tab, setTab] = React.useState('notes'),
      [refresh, setRefresh] = React.useState(0),
      [noteRefresh, setNoteRefresh] = React.useState(0)
    var [selected, setSelected] = React.useState(''),
      [query, setQuery] = React.useState(''),
      [search, setSearch] = React.useState(''),
      [mobile, setMobile] = React.useState(false),
      [editing, setEditing] = React.useState(false)
    var [draft, setDraft] = React.useState(''),
      [base, setBase] = React.useState(''),
      [baseRevision, setBaseRevision] = React.useState(''),
      [saving, setSaving] = React.useState(false),
      [message, setMessage] = React.useState(''),
      [error, setError] = React.useState(''),
      [choices, setChoices] = React.useState([]),
      [conflict, setConflict] = React.useState(false),
      draftFailed = React.useRef(false)
    var library = useResource(LIBRARY_PATH, vault, { refresh: refresh ? '1' : '0' }, refresh),
      results = useResource(LIBRARY_PATH, vault, { q: search }, refresh, !!search),
      documentState = useResource(NOTE_PATH, vault, { path: selected }, noteRefresh, !!selected)
    var notes = library.data?.notes || [],
      note = documentState.data,
      dirty = draft !== base
    var actualVault = library.data?.vault || note?.vault || vault,
      draftKey = 'dnc:draft:' + actualVault + ':' + selected
    var draftKeyRef = React.useRef(draftKey)
    draftKeyRef.current = draftKey
    React.useEffect(() => {
      var timer = setTimeout(() => setSearch(query.trim()), 180)
      return () => clearTimeout(timer)
    }, [query])
    React.useEffect(() => {
      setSelected('')
      setQuery('')
      setError('')
      setChoices([])
      setMessage('')
      setDraft('')
      setBase('')
    }, [vault])
    React.useEffect(() => {
      if (library.data && !selected) {
        var last = stored(window.localStorage, 'dnc:last:' + actualVault, '')
        setSelected(notes.some((n) => n.path === last) ? last : notes[0]?.path || '')
      }
    }, [library.data, selected, actualVault])
    React.useEffect(() => {
      if (!note || note.path !== selected) return
      var saved = null
      try {
        saved = JSON.parse(stored(window.sessionStorage, draftKey, ''))
      } catch (_) {}
      setBase(note.text)
      setBaseRevision(saved?.revision || note.revision)
      setDraft(saved?.text ?? note.text)
      if (saved) {
        setEditing(true)
        setMessage(
          saved.revision === note.revision
            ? '已恢复未保存草稿'
            : '已恢复草稿；磁盘版本已有变化，保存前请合并',
        )
      }
    }, [note, draftKey, selected])
    React.useEffect(() => {
      function guard(e) {
        if (dirty) {
          e.preventDefault()
          e.returnValue = ''
        }
      }
      window.addEventListener('beforeunload', guard)
      return () => window.removeEventListener('beforeunload', guard)
    }, [dirty])
    function change(text) {
      setDraft(text)
      setError('')
      setMessage('有未保存修改')
      try {
        window.sessionStorage.setItem(draftKey, JSON.stringify({ text, revision: baseRevision }))
        draftFailed.current = false
      } catch (_) {
        draftFailed.current = true
        setError('浏览器无法暂存草稿，请在离开页面前保存或复制正文')
      }
    }
    function open(path) {
      if (dirty && draftFailed.current) {
        setError('草稿尚未暂存，请先保存再切换笔记')
        return
      }
      setSelected(path)
      setTab('notes')
      setMobile(false)
      setEditing(false)
      setMessage('')
      setError('')
      setConflict(false)
      setChoices([])
      try {
        window.localStorage.setItem('dnc:last:' + actualVault, path)
      } catch (_) {}
    }
    function reloadDisk() {
      if (dirty && !copyRelPath(draft)) {
        setError('未能复制草稿，请手动复制后再读取新版')
        return
      }
      try {
        window.sessionStorage.removeItem(draftKey)
      } catch (_) {}
      setConflict(false)
      setError('')
      setMessage(dirty ? '草稿已复制，请对照新版合并' : '已重新读取')
      setDraft(base)
      setNoteRefresh((n) => n + 1)
    }
    function jumpHeading(text) {
      var list = note?.headings || [],
        index = list.findIndex((x) => x.text === text)
      if (index >= 0) document.getElementById('dnc-h-' + index)?.scrollIntoView({ block: 'start' })
    }
    function follow(target) {
      var matches = resolveLinks(target, selected, notes)
      if (matches.length === 1) {
        if (matches[0].path === selected) jumpHeading(target.split('#')[1])
        else open(matches[0].path)
      } else {
        setChoices(matches)
        setMessage(matches.length ? '找到同名笔记，请选择：' : '尚未找到这篇笔记：' + target)
      }
    }
    async function save() {
      if (saving || !note || !dirty) return
      var text = draft,
        revision = baseRevision,
        path = selected,
        key = draftKey
      setSaving(true)
      setError('')
      setMessage('正在保存并同步…')
      try {
        var result = await api(url(SAVE_PATH, vault), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dnc-editor': '1' },
          body: JSON.stringify({ path, text, revision }),
        })
        if (draftKeyRef.current === key) {
          setBase(text)
          setBaseRevision(result.revision)
          setConflict(false)
          draftFailed.current = false
          setMessage('本地已保存' + (result.sync || ''))
          setRefresh((n) => n + 1)
        }
        try {
          window.sessionStorage.removeItem(key)
        } catch (_) {}
      } catch (e) {
        if (draftKeyRef.current === key) {
          setConflict(e.conflict === true)
          setError(e.message)
          setMessage('尚未保存，草稿已保留')
        }
      } finally {
        setSaving(false)
      }
    }
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    var backlinks = notes.filter(
      (n) =>
        n.path !== selected &&
        n.links.some((link) => resolveLinks(link, n.path, notes).some((x) => x.path === selected)),
    )
    var outbound = (note?.links || []).filter(Boolean)
    return h(
      'div',
      { className: 'dnc-workspace', onKeyDown: onKey, 'data-dnc-workspace': true },
      h(
        'header',
        { className: 'dnc-top' },
        h('div', { className: 'dnc-brand' }, '笔记库', h('small', null, 'OBSIDIAN WORKSPACE')),
        h(
          'nav',
          { 'aria-label': '笔记栏目' },
          [
            ['notes', '笔记'],
            ['history', '改动'],
            ['settings', '设置'],
          ].map(([id, label]) =>
            h(Button, { key: id, 'aria-pressed': tab === id, onClick: () => setTab(id) }, label),
          ),
        ),
        h(Button, { title: '刷新目录和搜索索引', onClick: () => setRefresh((n) => n + 1) }, '刷新'),
      ),
      tab === 'settings'
        ? h(Settings, { vault, onRefresh: () => setRefresh((n) => n + 1) })
        : tab === 'history'
          ? h(History, { vault, revision: refresh, onOpen: open })
          : h(
              React.Fragment,
              null,
              h(
                Button,
                {
                  className: 'dnc-mobile-toggle',
                  'aria-expanded': mobile,
                  onClick: () => setMobile(!mobile),
                },
                mobile ? '收起目录' : '目录与搜索',
              ),
              h(
                'div',
                { className: 'dnc-layout' },
                h(
                  'aside',
                  { className: 'dnc-left', 'data-open': mobile },
                  h('input', {
                    className: 'dnc-search',
                    type: 'search',
                    'aria-label': '搜索笔记',
                    placeholder: '搜索标题与正文…',
                    value: query,
                    onChange: (e) => setQuery(e.target.value),
                  }),
                  h('div', { className: 'dnc-label' }, search ? '搜索结果' : '文件目录'),
                  h(ErrorBox, { text: library.error || results.error }),
                  library.loading
                    ? h('p', { className: 'dnc-notice' }, '正在读取笔记库…')
                    : search
                      ? results.loading
                        ? h('p', null, '正在搜索…')
                        : results.data?.notes?.length
                          ? results.data.notes.map((n) =>
                              h(
                                Button,
                                {
                                  className: 'dnc-result',
                                  key: n.path,
                                  onClick: () => open(n.path),
                                },
                                n.title,
                                h('small', null, n.excerpt),
                              ),
                            )
                          : h('p', { className: 'dnc-notice' }, '没有匹配的笔记')
                      : h(Tree, { notes, current: selected, onOpen: open }),
                ),
                h(
                  'main',
                  { className: 'dnc-center' },
                  h(
                    'div',
                    { className: 'dnc-documentbar' },
                    h(
                      'span',
                      { className: 'dnc-breadcrumb', title: selected },
                      selected || '选择一篇笔记',
                    ),
                    h(
                      Button,
                      {
                        disabled: !note || saving,
                        'aria-pressed': editing,
                        onClick: () => setEditing(!editing),
                      },
                      editing ? '阅读' : '编辑',
                    ),
                    h(
                      Button,
                      {
                        disabled: !selected,
                        onClick: () =>
                          setMessage(copyRelPath(selected) ? '路径已复制' : '复制失败'),
                      },
                      '复制路径',
                    ),
                    editing
                      ? h(
                          Button,
                          {
                            className: 'dnc-primary',
                            disabled: !dirty || saving || note?.truncated,
                            onClick: save,
                          },
                          saving ? '保存中…' : '保存',
                        )
                      : null,
                  ),
                  h(ErrorBox, { text: documentState.error || error }),
                  message ? h('div', { className: 'dnc-status', role: 'status' }, message) : null,
                  conflict
                    ? h(
                        'div',
                        { className: 'dnc-notice' },
                        h(Button, { onClick: reloadDisk }, '复制草稿并读取新版'),
                      )
                    : null,
                  choices.length
                    ? h(
                        'div',
                        { className: 'dnc-notice' },
                        choices.map((n) =>
                          h(Button, { key: n.path, onClick: () => open(n.path) }, n.path),
                        ),
                      )
                    : null,
                  documentState.loading
                    ? h('div', { className: 'dnc-empty' }, '正在打开笔记…')
                    : !note
                      ? h(
                          'div',
                          { className: 'dnc-empty' },
                          h('h2', null, '让笔记有自己的空间'),
                          h(
                            'p',
                            null,
                            notes.length
                              ? '从左侧目录选择一篇笔记。'
                              : '连接本地笔记库，开始整理你的想法。',
                          ),
                          h(Button, { onClick: () => setTab('settings') }, '笔记库设置'),
                        )
                      : editing
                        ? note.truncated
                          ? h(
                              'div',
                              { className: 'dnc-notice' },
                              '这篇笔记较长，仅提供阅读预览，请在 Obsidian 中编辑。',
                            )
                          : h('textarea', {
                              className: 'dnc-editor',
                              'aria-label': 'Markdown 正文',
                              spellCheck: false,
                              value: draft,
                              disabled: saving,
                              onChange: (e) => change(e.target.value),
                            })
                        : h(
                            'div',
                            { className: 'dnc-scroll' },
                            h('article', { className: 'dnc-doc' }, renderDoc(draft, follow)),
                            note.truncated
                              ? h(
                                  'div',
                                  { className: 'dnc-notice' },
                                  '这里只展示前 60,000 字符，完整正文仍在本地。',
                                )
                              : null,
                          ),
                ),
                h(
                  'aside',
                  { className: 'dnc-right' },
                  h(
                    'section',
                    null,
                    h('div', { className: 'dnc-label' }, '本篇大纲'),
                    (note?.headings || []).map((item, i) =>
                      h(
                        Button,
                        {
                          key: i,
                          style: { paddingLeft: (item.level - 1) * 8 },
                          onClick: () => {
                            setEditing(false)
                            setTimeout(() => jumpHeading(item.text), 0)
                          },
                        },
                        item.text,
                      ),
                    ),
                  ),
                  h(
                    'section',
                    null,
                    h('div', { className: 'dnc-label' }, '链接到'),
                    outbound.length
                      ? outbound.map((link) =>
                          h(Button, { key: link, onClick: () => follow(link) }, link),
                        )
                      : h('span', { className: 'dnc-notice' }, '还没有双链'),
                  ),
                  h(
                    'section',
                    null,
                    h('div', { className: 'dnc-label' }, '反向链接 · ' + backlinks.length),
                    backlinks.map((n) =>
                      h(
                        Button,
                        { key: n.path, title: n.path, onClick: () => open(n.path) },
                        noteLabel(n.path),
                      ),
                    ),
                  ),
                ),
              ),
            ),
      h(
        'footer',
        { className: 'dnc-footer' },
        h(
          'span',
          null,
          library.data
            ? notes.length + ' 篇笔记' + (library.data.partial ? ' · 部分内容未索引' : '')
            : '本地笔记库',
        ),
        h('span', null, dirty ? '草稿未保存' : actualVault || '未连接'),
      ),
      library.data?.warnings?.length
        ? h('div', { className: 'dnc-notice' }, library.data.warnings.join('；'))
        : null,
    )
  }
  slots.inject('main', () => slots.register({ name: 'main', key: 'notes' }, Workspace))
  slots.inject('sidebar.panellist', () =>
    slots.register({ name: 'sidebar.panellist', id: 'notes', order: 45, label: '笔记库' }, () =>
      h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          'aria-hidden': true,
        },
        h('path', {
          d: 'M5 3h11a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3m0 0v14m-3 1a2 2 0 0 1 2-2h13M10 7h6m-6 4h5',
        }),
      ),
    ),
  )
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'note-changes', order: 65, label: '笔记库' },
      function () {
        var vault = useVault()
        return h('div', { className: 'dnc-workspace' }, h(Settings, { vault }))
      },
    ),
  )
  console.log('[dsh-note-changes] client up (v1.8.0)')
}
exports.name = 'dsh-note-changes'
exports.inject = ['slots']
exports.apply = apply
exports.internals = {
  LOG_PATH,
  NOTE_PATH,
  SETTINGS_PATH,
  SYNC_PATH,
  LIBRARY_PATH,
  SAVE_PATH,
  resolveLinks,
  renderDoc,
}
