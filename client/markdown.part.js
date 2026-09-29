function noteLabel(path) {
  return String(path).split('/').pop().replace(/\.md$/i, '')
}
function resolveLinks(target, current, notes) {
  var clean = target.split('#')[0].replace(/\.md$/i, '')
  if (!clean) return notes.filter((n) => n.path === current)
  var parent = current.split('/').slice(0, -1).join('/')
  var exact = notes.filter(
    (n) =>
      n.path.replace(/\.md$/i, '') === clean ||
      n.path.replace(/\.md$/i, '') === (parent ? parent + '/' : '') + clean,
  )
  return exact.length ? exact : notes.filter((n) => noteLabel(n.path) === clean)
}
function inline(text, onLink) {
  return String(text)
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g)
    .map(function (token, i) {
      if (token.startsWith('**')) return h('strong', { key: i }, inline(token.slice(2, -2), onLink))
      if (token.startsWith('`')) return h('code', { key: i }, token.slice(1, -1))
      if (token.startsWith('[[')) {
        var parts = token.slice(2, -2).split('|')
        return h(
          'button',
          { key: i, type: 'button', className: 'dnc-wikilink', onClick: () => onLink(parts[0]) },
          parts[1] || parts[0],
        )
      }
      var link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(token)
      if (link)
        return h(
          'a',
          { key: i, href: link[2], target: '_blank', rel: 'noreferrer noopener' },
          link[1],
        )
      return token
    })
}
function renderDoc(raw, onLink) {
  var text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''),
    lines = text.split(/\r?\n/),
    out = [],
    i = 0,
    heading = 0
  function push(tag, props, children) {
    out.push(h(tag, { key: out.length, ...props }, children))
  }
  while (i < lines.length) {
    var line = lines[i],
      trim = line.trim(),
      match
    if (!trim) {
      i++
      continue
    }
    if ((match = /^(`{3,}|~{3,})/.exec(trim))) {
      var fence = match[1],
        code = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++])
      i++
      push('pre', {}, h('code', null, code.join('\n')))
      continue
    }
    if ((match = /^(#{1,6})\s+(.+)$/.exec(line))) {
      push('h' + match[1].length, { id: 'dnc-h-' + heading++ }, inline(match[2], onLink))
      i++
      continue
    }
    if (/^(?:---+|\*\*\*+)\s*$/.test(trim)) {
      push('hr', {}, null)
      i++
      continue
    }
    if (trim.startsWith('>')) {
      push('blockquote', {}, inline(trim.replace(/^>\s?/, ''), onLink))
      i++
      continue
    }
    if (/^\|/.test(trim) && /^\s*\|?[ :|-]+\|[ :|-]*$/.test(lines[i + 1] || '')) {
      var cells = (l) =>
          l
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|'),
        headers = cells(line),
        rows = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      push('table', {}, [
        h(
          'thead',
          { key: 'h' },
          h(
            'tr',
            null,
            headers.map((c, j) => h('th', { key: j }, inline(c, onLink))),
          ),
        ),
        h(
          'tbody',
          { key: 'b' },
          rows.map((row, j) =>
            h(
              'tr',
              { key: j },
              row.map((c, k) => h('td', { key: k }, inline(c, onLink))),
            ),
          ),
        ),
      ])
      continue
    }
    if ((match = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line))) {
      var ordered = /\d/.test(match[1]),
        items = []
      while (i < lines.length && (match = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]))) {
        var task = /^\[([ xX])\]\s+(.*)$/.exec(match[2])
        items.push(
          h(
            'li',
            { key: items.length },
            task
              ? [
                  h('input', {
                    key: 'c',
                    type: 'checkbox',
                    checked: task[1] !== ' ',
                    readOnly: true,
                    tabIndex: -1,
                  }),
                  ' ' + task[2],
                ]
              : inline(match[2], onLink),
          ),
        )
        i++
      }
      push(ordered ? 'ol' : 'ul', {}, items)
      continue
    }
    var para = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(\s*[-*+] |\s*\d+\. |#{1,6} |>|```|~~~|\|)/.test(lines[i])
    )
      para.push(lines[i++])
    push('p', {}, inline(para.join('\n'), onLink))
  }
  return out
}
