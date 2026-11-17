/**
 * Rendering for the `/mcp-diff` card and the proactive notice.
 *
 * rc.7 has no `ctx.ui` and no banner service, so the "banner" the brief asks
 * for is delivered as two surfaces that rc.7 does expose: a one-line warning
 * on the host logger, and a `plugin`-sourced `notice` message in the live
 * agent's transcript. `/mcp-diff` is the collapsible detail view.
 */

/** Detail rows shown per server before the card collapses the rest. */
const MAX_ROWS = 8

const SEVERITY_LABEL = {
  breaking: 'breaking',
  warning: 'warning ',
  info: 'info    ',
}

function safeText(value) {
  try {
    return value == null ? '' : String(value)
  } catch {
    return ''
  }
}

function clip(text, limit) {
  const value = safeText(text)
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function elapsed(since, now) {
  if (!Number.isFinite(since) || since <= 0) return 'not yet'
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * Render the `/mcp-diff` card.
 * @param state - `{ entries, checkedAt, cachePath, persistFailed }` from the watcher.
 * @param now - current epoch milliseconds.
 */
export function renderReport(state, now) {
  const entries = [...state.entries.values()]
  if (entries.length === 0) {
    return 'No MCP tool schemas are visible yet. A baseline is stored the first time an mcp__ server\'s tools appear, and every later tools/change is diffed against it.'
  }

  const connected = entries.filter(entry => entry.connected)
  const breaking = entries.reduce((sum, entry) => sum + entry.diff.breaking, 0)
  const warning = entries.reduce((sum, entry) => sum + entry.diff.warning, 0)
  const info = entries.reduce((sum, entry) => sum + entry.diff.info, 0)

  const lines = []
  lines.push(`MCP tool schema diff · ${plural(connected.length, 'server')} connected · ${plural(breaking, 'breaking change')} · ${regressionWord(breaking, warning)}`)
  lines.push(`  checked ${elapsed(state.checkedAt, now)} ago`)

  entries.sort((a, b) =>
    Number(b.connected) - Number(a.connected)
    || b.diff.breaking - a.diff.breaking
    || a.server.localeCompare(b.server))

  for (const entry of entries) {
    lines.push('')
    if (!entry.connected) {
      lines.push(`  ${entry.server} · cached, server not connected in this session${entry.baseAt ? ` (baseline ${entry.baseAt})` : ''}`)
      continue
    }
    if (entry.baseline) {
      lines.push(`  ${entry.server} · baseline recorded (${plural(entry.tools, 'tool')})`)
      continue
    }
    if (entry.diff.total === 0) {
      lines.push(`  ${entry.server} · no schema changes since ${entry.baseAt || 'baseline'} (${plural(entry.tools, 'tool')})`)
      continue
    }
    lines.push(`  ${entry.server} · ${entry.diff.breaking} breaking · ${entry.diff.warning} warning · ${entry.diff.info} info`)
    const shown = entry.diff.issues.slice(0, MAX_ROWS)
    for (const item of shown) {
      lines.push(`    ${SEVERITY_LABEL[item.severity] ?? item.severity}  ${item.detail}`)
    }
    if (entry.diff.issues.length > shown.length) {
      lines.push(`    … ${entry.diff.issues.length - shown.length} more`)
    }
  }

  lines.push('')
  const cache = safeText(state.cachePath) || '(cache path unavailable)'
  lines.push(`Cache ${cache} · last 3 versions per server${state.persistFailed ? ' · not writable, using in-memory history' : ''}`)
  if (breaking === 0 && warning === 0) {
    lines.push('No breaking changes. Existing tool calls still validate against the current schemas.')
  }
  return lines.join('\n')
}

function regressionWord(breaking, warning) {
  const parts = []
  if (warning > 0) parts.push(plural(warning, 'warning'))
  if (breaking === 0 && warning === 0) return 'no changes'
  return parts.length > 0 ? parts.join(' · ') : 'no warnings'
}

/**
 * One-paragraph notice for the logger and the agent transcript.
 * @param server - MCP server whose contract moved.
 * @param diff - result from `diffSnapshots`.
 */
export function renderNotice(server, diff) {
  const first = diff.issues.find(item => item.severity === 'breaking')
  const extra = diff.breaking - (first ? 1 : 0)
  const tail = extra > 0 ? ` (+${extra} more breaking).` : '.'
  const warnings = diff.warning > 0 ? `, ${plural(diff.warning, 'warning')}` : ''
  const head = `MCP tool schema changed for "${safeText(server)}": ${plural(diff.breaking, 'breaking change')}${warnings}. `
  const detail = first ? first.detail : 'contract changed'
  const cta = ' Run /mcp-diff for the full diff.'
  // Clip the detail, never the call to action: a long enum list once pushed
  // the command pointer off the end of the notice.
  const room = Math.max(40, 480 - head.length - tail.length - cta.length)
  return `${head}${clip(detail, room)}${tail}${cta}`
}
