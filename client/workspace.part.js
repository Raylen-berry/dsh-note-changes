var LOG_PATH = '/note-changes/log',
  NOTE_PATH = '/note-changes/note',
  SETTINGS_PATH = '/note-changes/settings',
  SYNC_PATH = '/note-changes/sync',
  TRANSFER_PATH = '/note-changes/transfer',
  LIBRARY_PATH = '/note-changes/library',
  SAVE_PATH = '/note-changes/save',
  CREATE_PATH = '/note-changes/create',
  ASSET_PATH = '/note-changes/asset',
  VENDOR_PATH = '/note-changes/vendor'
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
    var error = new Error(body.error || body.message || body.lastSync?.note || '请求失败')
    error.conflict = body.conflict
    throw error
  }
  return body
}
function useResource(route, vault, params, revision, enabled) {
  var [state, setState] = React.useState({ loading: false, data: null, error: '' }),
    query = JSON.stringify(params || {}),
    request = JSON.stringify([route, vault, query, revision, enabled])
  React.useEffect(
    function () {
      if (enabled === false) {
        setState({ request, loading: false, data: null, error: '' })
        return
      }
      var controller = new AbortController(),
        alive = true
      setState({ request, loading: true, data: null, error: '' })
      api(url(route, vault, JSON.parse(query)), { signal: controller.signal })
        .then((data) => {
          if (alive) setState({ request, loading: false, data, error: '' })
        })
        .catch((e) => {
          if (alive) setState({ request, loading: false, data: null, error: e.message })
        })
      return () => {
        alive = false
        controller.abort()
      }
    },
    [route, vault, query, revision, enabled],
  )
  return state.request === request ? state : { loading: enabled !== false, data: null, error: '' }
}
function ErrorBox(props) {
  return props.text ? h('div', { className: 'dnc-error', role: 'alert' }, props.text) : null
}
function Button(props) {
  return h('button', { type: 'button', ...props }, props.children)
}
function Tree({ notes, current, onOpen }) {
  var tree = { files: [], folders: Object.create(null) }
  notes.forEach((note) => {
    var parts = note.path.split('/'),
      branch = tree
    parts.slice(0, -1).forEach((name) => {
      branch =
        branch.folders[name] || (branch.folders[name] = { files: [], folders: Object.create(null) })
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
  var override = {
      path: stored(window.localStorage, 'dsh-note-changes:vault', ''),
      revision: 0,
      resolved: '',
    },
    listeners = new Set()
  function setVault(v, resolved) {
    try {
      if (v) window.localStorage.setItem('dsh-note-changes:vault', v)
      else window.localStorage.removeItem('dsh-note-changes:vault')
    } catch (_) {
      throw new Error('无法保存本机连接配置，请检查 Desktop 存储权限')
    }
    override = { path: v, revision: override.revision + 1, resolved }
    listeners.forEach((f) => f(override))
  }
  function useVault() {
    var pair = React.useState(override)
    React.useEffect(() => {
      listeners.add(pair[1])
      return () => listeners.delete(pair[1])
    }, [])
    return pair[0]
  }

  function SyncPanel({ vault, revision = 0, dirty = false, onUpdated }) {
    var [tick, setTick] = React.useState(0),
      state = useResource(TRANSFER_PATH, vault, {}, revision + tick),
      [busy, setBusy] = React.useState(''),
      [message, setMessage] = React.useState(''),
      [error, setError] = React.useState(''),
      currentVault = React.useRef(vault)
    currentVault.current = vault
    React.useEffect(() => {
      setMessage('')
      setError('')
    }, [vault])
    async function transfer(direction) {
      setError('')
      if (dirty) {
        setError('请先保存正在编辑的草稿，再同步笔记。')
        return
      }
      setBusy(direction)
      setMessage(direction === 'download' ? '正在下载远端更新…' : '正在上传本机笔记…')
      try {
        var result = await api(url(TRANSFER_PATH, vault), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dnc-editor': '1' },
          body: JSON.stringify({ direction }),
        })
        if (currentVault.current === vault) setMessage(result.message)
      } catch (e) {
        if (currentVault.current === vault) {
          setMessage('')
          setError(e.message)
        }
      } finally {
        setBusy('')
        setTick((n) => n + 1)
        // Pull/rebase can update files even if a subsequent push fails.
        override = { ...override, revision: override.revision + 1 }
        listeners.forEach((f) => f(override))
        if (onUpdated) onUpdated()
      }
    }
    var info = state.data?.state
    return h(
      'section',
      { className: 'dnc-sync', 'aria-label': 'GitHub 笔记同步', 'aria-busy': !!busy },
      h(
        'div',
        { className: 'dnc-sync-bar' },
        h(
          'span',
          { className: 'dnc-sync-label' },
          '⇄ GitHub',
          h(
            'small',
            null,
            info
              ? info.pending + ' 个本机改动 · ' + info.ahead + ' 个待上传提交'
              : '连接本机笔记仓库',
          ),
        ),
        h(
          'div',
          { className: 'dnc-actions' },
          h(
            Button,
            { disabled: !!busy, onClick: () => transfer('download') },
            busy === 'download' ? '下载中…' : '↓ 下载更新',
          ),
          h(
            Button,
            { className: 'dnc-primary', disabled: !!busy, onClick: () => transfer('upload') },
            busy === 'upload' ? '上传中…' : '↑ 上传笔记',
          ),
        ),
      ),
      h(ErrorBox, {
        text:
          error ||
          state.error ||
          (!message && state.data?.lastSync?.ok === false ? state.data.lastSync.note : ''),
      }),
      message || state.data?.lastSync?.ok
        ? h(
            'p',
            { role: 'status', className: 'dnc-sync-message' },
            message || state.data.lastSync.note,
          )
        : null,
      h(
        'details',
        { className: 'dnc-sync-details' },
        h('summary', null, '同步范围与使用方法'),
        h(
          'p',
          null,
          '开始使用这台电脑 → 下载更新；写完笔记 → 上传笔记；换一台电脑 → 再下载更新。两台电脑连接同一个 GitHub 仓库，本机路径可以不同。',
        ),
        h(
          'p',
          null,
          '上传 Markdown 和常见图片、音频、视频、PDF 附件（单个不超过 20 MB），包含已跟踪文件的删除。隐藏目录、忽略文件及其他类型不自动提交；已有 Git 提交会随分支上传。编辑器保存仍会自动同步当前笔记。',
        ),
        h(
          'p',
          null,
          '首次使用另一台电脑：先把同一个 GitHub 笔记仓库克隆到本机，再在设置里连接该文件夹。',
        ),
        info
          ? h(
              React.Fragment,
              null,
              h('p', { className: 'dnc-sync-remote' }, info.remote + ' · ' + info.branch),
              h(
                'p',
                null,
                '远端比本机多 ' +
                  info.behind +
                  ' 个提交（按最近一次获取的远端状态；点击同步时会重新检查）。',
              ),
              h(
                'ul',
                null,
                info.changes
                  .slice(0, 80)
                  .map((c) =>
                    h(
                      'li',
                      { key: c.path },
                      (c.included ? (c.status.includes('D') ? '删除 · ' : '上传 · ') : '跳过 · ') +
                        c.path +
                        (c.reason ? ' — ' + c.reason : ''),
                    ),
                  ),
              ),
              info.changes.length > 80
                ? h('p', null, '还有 ' + (info.changes.length - 80) + ' 项')
                : null,
            )
          : null,
      ),
    )
  }
  function Settings({ vault, connectionRevision = 0, standalone = false }) {
    var [revision, setRevision] = React.useState(0),
      state = useResource(SETTINGS_PATH, vault, {}, revision + connectionRevision),
      [mode, setMode] = React.useState(vault ? 'custom' : 'local'),
      [draft, setDraft] = React.useState(vault),
      [busy, setBusy] = React.useState(false),
      [message, setMessage] = React.useState(''),
      [connectionMessage, setConnectionMessage] = React.useState(''),
      [error, setError] = React.useState(''),
      id = React.useId()
    React.useEffect(() => {
      setDraft(vault)
      setMode(vault ? 'custom' : 'local')
    }, [vault])
    var settings = state.data?.settings || {}
    async function connect() {
      var next = mode === 'local' ? '' : draft.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      setBusy(true)
      setError('')
      setConnectionMessage('正在检查笔记库…')
      try {
        if (mode === 'custom' && !next)
          throw new Error('指定文件夹不能为空，请填写笔记库的完整路径')
        if (next && !/^(?:[a-z]:\/|\/)/i.test(next))
          throw new Error('请输入完整路径，例如 D:/DeepSeek/vault')
        var result = await api(url(LIBRARY_PATH, next, { refresh: '1' }))
        setVault(next, result.vault)
        setMessage('')
        setConnectionMessage(
          (mode === 'local' ? '已跟随本机配置：' : '已连接指定文件夹：') +
            result.vault +
            ' · ' +
            result.total +
            ' 篇笔记',
        )
      } catch (e) {
        setConnectionMessage('')
        setError('连接未更改：' + e.message)
      } finally {
        setBusy(false)
      }
    }
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
        '选择这台电脑上的 Obsidian 笔记库。连接方式只保存在本机，不会覆盖另一台电脑的路径。',
      ),
      h(ErrorBox, { text: error || state.error }),
      h(
        'section',
        { className: 'dnc-setting' },
        h('h3', null, '连接方式'),
        h(
          'div',
          { className: 'dnc-connection-modes', role: 'radiogroup', 'aria-label': '连接方式' },
          [
            ['local', '跟随本机配置', '读取 Desktop 为这台电脑配置的笔记库路径'],
            ['custom', '指定笔记库文件夹', '使用下方填写的本机路径'],
          ].map(([value, label, hint]) =>
            h(
              'label',
              { key: value, 'data-selected': mode === value },
              h('input', {
                type: 'radio',
                name: id,
                value,
                checked: mode === value,
                disabled: !!busy,
                onChange: () => {
                  setMode(value)
                  setConnectionMessage('')
                  setError('')
                },
              }),
              h('span', null, label, h('small', null, hint)),
            ),
          ),
        ),
        mode === 'custom'
          ? h(
              React.Fragment,
              null,
              h('label', { htmlFor: id + '-vault' }, '本机路径'),
              h('input', {
                id: id + '-vault',
                type: 'text',
                value: draft,
                disabled: !!busy,
                onChange: (e) => setDraft(e.target.value),
                placeholder: '例如 D:/DeepSeek/vault',
              }),
            )
          : null,
        h(
          'p',
          { 'data-dnc-active-connection': true },
          '当前生效：' +
            (vault ? '指定文件夹' : '跟随本机配置') +
            ' · ' +
            (state.data?.vaultPath || vault || '正在读取…'),
        ),
        h(
          Button,
          { className: 'dnc-primary', disabled: !!busy, onClick: connect },
          busy ? '正在检查…' : '应用连接',
        ),
        h('p', { role: 'status', 'data-dnc-connection-status': true }, connectionMessage),
      ),
      standalone ? h(SyncPanel, { vault, revision: connectionRevision }) : null,
      h(
        'section',
        { className: 'dnc-setting' },
        h('h3', null, '会话记录'),
        h(
          'label',
          null,
          h('input', {
            type: 'checkbox',
            checked: settings.scanVault === true,
            disabled: busy || !state.data,
            onChange: (e) => update({ scanVault: e.target.checked }),
          }),
          '允许检索笔记',
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
        h(
          'p',
          { role: 'status' },
          message || state.data?.lastSync?.note || '本地保存和同步结果会在这里显示。',
        ),
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
    var connection = useVault(),
      vault = connection.path,
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
      [merge, setMerge] = React.useState(null),
      [mergeLoading, setMergeLoading] = React.useState(false),
      [creating, setCreating] = React.useState(''),
      [graphVisible, setGraphVisible] = React.useState(false),
      [tag, setTag] = React.useState(''),
      [property, setProperty] = React.useState(''),
      [propertyValue, setPropertyValue] = React.useState(''),
      [shelf, setShelf] = React.useState('all'),
      draftFailed = React.useRef(false)
    var library = useResource(
        LIBRARY_PATH,
        vault,
        { refresh: refresh || connection.revision ? '1' : '0' },
        refresh + connection.revision,
      ),
      results = useResource(
        LIBRARY_PATH,
        vault,
        { q: search },
        refresh + connection.revision,
        !!search,
      ),
      documentState = useResource(
        NOTE_PATH,
        vault,
        { path: selected },
        noteRefresh + connection.revision,
        !!selected,
      )
    var notes = library.data?.notes || [],
      note = documentState.data,
      dirty = draft !== base
    var actualVault = library.data?.vault || note?.vault || vault,
      draftKey = 'dnc:draft:' + actualVault + ':' + selected
    var draftKeyRef = React.useRef(draftKey)
    draftKeyRef.current = draftKey
    var collections = useCollections(actualVault, note?.path === selected ? selected : ''),
      graph = React.useMemo(() => buildGraph(notes), [library.data]),
      orphanSet = new Set(graph.orphans.map((n) => n.path)),
      candidates = search ? results.data?.notes || [] : notes,
      filtered = candidates.filter(
        (n) =>
          (!tag || n.tags?.includes(tag)) &&
          (!property ||
            (n.properties?.[property] &&
              (!propertyValue || n.properties[property].includes(propertyValue)))) &&
          (shelf === 'favorites'
            ? collections.favorites.includes(n.path)
            : shelf === 'recent'
              ? collections.recent.includes(n.path)
              : shelf === 'orphans'
                ? orphanSet.has(n.path)
                : true),
      ),
      tags = [...new Set(notes.flatMap((n) => n.tags || []))].sort(),
      properties = [...new Set(notes.flatMap((n) => Object.keys(n.properties || {})))].sort(),
      values = [...new Set(notes.flatMap((n) => n.properties?.[property] || []))].sort()
    if (shelf === 'recent')
      filtered.sort(
        (a, b) => collections.recent.indexOf(a.path) - collections.recent.indexOf(b.path),
      )
    React.useEffect(() => {
      var timer = setTimeout(() => setSearch(query.trim()), 180)
      return () => clearTimeout(timer)
    }, [query])
    React.useEffect(() => {
      setSelected('')
      setEditing(false)
      setQuery('')
      setError('')
      setChoices([])
      setMessage('')
      setDraft('')
      setBase('')
      setMerge(null)
      setCreating('')
      setTag('')
      setProperty('')
      setPropertyValue('')
      setShelf('all')
      setGraphVisible(false)
    }, [vault, connection.resolved])
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
      setMerge(null)
      setGraphVisible(false)
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
    async function compare() {
      var key = draftKey
      setMergeLoading(true)
      try {
        var latest = await api(url(NOTE_PATH, actualVault, { path: selected }))
        if (draftKeyRef.current !== key) return
        if (latest.truncated) throw new Error('磁盘版本较长，请在 Obsidian 中合并')
        setMerge(latest)
        setGraphVisible(false)
      } catch (e) {
        if (draftKeyRef.current === key) setError(e.message)
      } finally {
        setMergeLoading(false)
      }
    }
    function applyMerge(text, latest) {
      setBase(latest.text)
      setBaseRevision(latest.revision)
      setDraft(text)
      setMerge(null)
      setConflict(false)
      setError('')
      setEditing(true)
      try {
        window.sessionStorage.setItem(draftKey, JSON.stringify({ text, revision: latest.revision }))
        draftFailed.current = false
      } catch (_) {
        draftFailed.current = true
        setError('无法暂存草稿，请在离开前保存或复制正文')
      }
      setMessage('已合并到草稿，请检查正文后保存')
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
      setMerge(null)
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
      if (saving || merge || creating || !note || note.path !== selected || !dirty) return
      const normalizedVault = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '')
      if (vault && normalizedVault(vault) !== normalizedVault(note.vault)) return
      var text = draft,
        revision = baseRevision,
        path = selected,
        key = draftKey
      setSaving(true)
      setError('')
      setMessage('正在保存并同步…')
      try {
        var result = await api(url(SAVE_PATH, actualVault), {
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
    var incoming = new Set(graph.edges.filter((e) => e.to === selected).map((e) => e.from)),
      backlinks = notes.filter((n) => incoming.has(n.path))
    var outbound = (note?.links || []).filter(Boolean)
    return h(
      'div',
      { className: 'dnc-workspace', onKeyDown: onKey, 'data-dnc-workspace': true },
      creating
        ? h(CreateNote, {
            vault: actualVault,
            notes,
            daily: creating === 'daily',
            onClose: () => setCreating(''),
            onOpen: open,
            onCreated: (result) => {
              setCreating('')
              open(result.path)
              setQuery('')
              setTag('')
              setProperty('')
              setPropertyValue('')
              setShelf('all')
              setEditing(true)
              setRefresh((n) => n + 1)
              setMessage('新笔记已创建' + (result.sync || ''))
            },
          })
        : null,
      h(
        'header',
        { className: 'dnc-top' },
        h('div', { className: 'dnc-brand' }, '笔记', h('small', null, 'OBSIDIAN WORKSPACE')),
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
      h(SyncPanel, {
        vault,
        revision: connection.revision + refresh,
        dirty: dirty || saving,
        onUpdated: () => setNoteRefresh((n) => n + 1),
      }),
      tab === 'settings'
        ? h(Settings, { vault, connectionRevision: connection.revision })
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
                  h(
                    'div',
                    { className: 'dnc-actions dnc-new-actions' },
                    h(
                      Button,
                      {
                        className: 'dnc-primary',
                        disabled: !library.data,
                        onClick: () => setCreating('blank'),
                      },
                      '＋ 新建',
                    ),
                    h(
                      Button,
                      { disabled: !library.data, onClick: () => setCreating('daily') },
                      '今日笔记',
                    ),
                  ),
                  h('input', {
                    className: 'dnc-search',
                    type: 'search',
                    'aria-label': '搜索笔记',
                    placeholder: '搜索标题与正文…',
                    value: query,
                    onChange: (e) => setQuery(e.target.value),
                  }),
                  h(
                    'div',
                    { className: 'dnc-shelves', 'aria-label': '笔记集合' },
                    [
                      ['all', '全部'],
                      ['favorites', '收藏'],
                      ['recent', '最近'],
                      ['orphans', '孤立笔记'],
                    ].map(([value, label]) =>
                      h(
                        Button,
                        {
                          key: value,
                          'aria-pressed': shelf === value,
                          onClick: () => setShelf(value),
                        },
                        label,
                      ),
                    ),
                  ),
                  h(
                    'details',
                    { className: 'dnc-filters' },
                    h('summary', null, '标签与属性' + (tag || property ? ' · 已筛选' : '')),
                    h(
                      'label',
                      null,
                      '标签',
                      h(
                        'select',
                        {
                          'aria-label': '标签筛选',
                          value: tag,
                          onChange: (e) => setTag(e.target.value),
                        },
                        h('option', { value: '' }, '全部标签'),
                        tags.map((t) => h('option', { key: t, value: t }, '#' + t)),
                      ),
                    ),
                    h(
                      'label',
                      null,
                      '属性',
                      h(
                        'select',
                        {
                          'aria-label': '属性筛选',
                          value: property,
                          onChange: (e) => {
                            setProperty(e.target.value)
                            setPropertyValue('')
                          },
                        },
                        h('option', { value: '' }, '全部属性'),
                        properties.map((p) => h('option', { key: p, value: p }, p)),
                      ),
                    ),
                    property
                      ? h(
                          'label',
                          null,
                          '属性值',
                          h(
                            'select',
                            {
                              'aria-label': '属性值筛选',
                              value: propertyValue,
                              onChange: (e) => setPropertyValue(e.target.value),
                            },
                            h('option', { value: '' }, '任意值'),
                            values.map((v) => h('option', { key: v, value: v }, v)),
                          ),
                        )
                      : null,
                    tag || property
                      ? h(
                          Button,
                          {
                            onClick: () => {
                              setTag('')
                              setProperty('')
                              setPropertyValue('')
                            },
                          },
                          '清除筛选',
                        )
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'dnc-label' },
                    (search ? '搜索结果' : '文件目录') + ' · ' + filtered.length,
                  ),
                  h(ErrorBox, { text: library.error || results.error }),
                  library.loading
                    ? h('p', { className: 'dnc-notice' }, '正在读取笔记库…')
                    : search || shelf === 'recent'
                      ? results.loading
                        ? h('p', null, '正在搜索…')
                        : filtered.length
                          ? filtered.map((n) =>
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
                      : filtered.length
                        ? h(Tree, { notes: filtered, current: selected, onOpen: open })
                        : h('p', { className: 'dnc-notice' }, '这个集合还没有笔记'),
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
                        disabled: !note || saving || !!merge,
                        'aria-pressed': editing,
                        onClick: () => {
                          setEditing(!editing)
                          setGraphVisible(false)
                        },
                      },
                      editing ? '阅读' : '编辑',
                    ),
                    h(
                      Button,
                      {
                        disabled: !selected,
                        'aria-pressed': collections.favorites.includes(selected),
                        onClick: () => collections.toggle(selected),
                      },
                      collections.favorites.includes(selected) ? '已收藏' : '收藏',
                    ),
                    h(
                      Button,
                      {
                        disabled: !selected || !!merge,
                        'aria-pressed': graphVisible,
                        onClick: () => setGraphVisible(!graphVisible),
                      },
                      '关系图',
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
                            disabled: !dirty || saving || !!merge || note?.truncated,
                            onClick: save,
                          },
                          saving ? '保存中…' : '保存',
                        )
                      : null,
                  ),
                  h(ErrorBox, { text: documentState.error || error }),
                  message ? h('div', { className: 'dnc-status', role: 'status' }, message) : null,
                  conflict && !merge
                    ? h(
                        'div',
                        { className: 'dnc-notice' },
                        h(
                          Button,
                          { disabled: mergeLoading, className: 'dnc-primary', onClick: compare },
                          mergeLoading ? '正在读取差异…' : '对照合并',
                        ),
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
                  merge
                    ? h(MergeView, {
                        key: merge.revision,
                        disk: merge,
                        draft,
                        onApply: applyMerge,
                        onCancel: () => setMerge(null),
                      })
                    : graphVisible
                      ? h(GraphView, {
                          notes,
                          selected,
                          graph,
                          partial: library.data?.partial,
                          onOpen: open,
                        })
                      : documentState.loading
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
                                h(
                                  'article',
                                  { className: 'dnc-doc' },
                                  renderDoc(draft, follow, {
                                    path: selected,
                                    vault: actualVault,
                                    assets: library.data?.assets || [],
                                  }),
                                ),
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
            ? notes.length +
                ' 篇笔记' +
                (library.data.partial ? ' · 部分内容未索引' : '') +
                (library.data.stats
                  ? ' · 读取 ' + library.data.stats.read + ' / 复用 ' + library.data.stats.reused
                  : '')
            : '本地笔记库',
        ),
        h('span', null, dirty ? '草稿未保存' : actualVault || '未连接'),
      ),
      library.data?.warnings?.length
        ? h('div', { className: 'dnc-notice' }, library.data.warnings.join('；'))
        : null,
    )
  }
  slots.inject('conversation.view', () =>
    slots.register(
      { name: 'conversation.view', id: 'note-workspace', order: 40, label: '笔记' },
      Workspace,
    ),
  )
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'note-changes', order: 65, label: '笔记库' },
      function () {
        var connection = useVault()
        return h(
          'div',
          { className: 'dnc-workspace' },
          h(Settings, {
            vault: connection.path,
            connectionRevision: connection.revision,
            standalone: true,
          }),
        )
      },
    ),
  )
  console.log('[dsh-note-changes] client up (v1.10.0)')
}
exports.name = 'dsh-note-changes'
exports.inject = ['slots']
exports.apply = apply
exports.internals = {
  mergeSections,
  composeMerge,
  templateText,
  buildGraph,
  resolveAsset,
  CREATE_PATH,
  ASSET_PATH,
  VENDOR_PATH,
  LOG_PATH,
  NOTE_PATH,
  SETTINGS_PATH,
  SYNC_PATH,
  TRANSFER_PATH,
  LIBRARY_PATH,
  SAVE_PATH,
  resolveLinks,
  renderDoc,
}
