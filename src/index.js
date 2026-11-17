/**
 * dsh-mcp-tool-schema-diff — breaking-change warning for MCP tool contracts.
 *
 * rc.7 has no per-server connect or upgrade event. What it does expose is
 * `tools/change`, emitted synchronously on every register, unregister and
 * scope change. `@deepseek-ai/dsh-mcp-client` names its tools
 * `mcp__<server>__<raw>`, so this plugin can group the live registry by server
 * without parsing raw MCP names.
 *
 * A re-sync disposes the whole previous generation before registering the new
 * one, so `tools/change` fires many times with intermediate empty or partial
 * states. Every event only resets a quiet timer; the diff runs once the
 * registry has been still for {@link DEBOUNCE_MS}. The first snapshot for a
 * server is a baseline and never raises an alarm.
 *
 * Robustness contract: nothing here throws into the host. Listener bodies,
 * timer callbacks, agent notices, optional services and filesystem failures are
 * each contained; the worst case is a missing report, never a broken session.
 */

import { diffSnapshots, toolContract } from './contract.js'
import { appendVersion, cacheRoot, forgetAll, forgetServer, KEEP, listCachedServers, loadVersions } from './store.js'
import { renderNotice, renderReport } from './report.js'

export const name = 'mcp-tool-schema-diff'

/** Quiet window that absorbs an MCP re-sync's many intermediate `tools/change` emissions. */
export const DEBOUNCE_MS = 200

const PREFIX = 'mcp__'
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const MAX_NOTICES = 64
const NOTICE_SUMMARY_CHARS = 120

function safeText(value) {
  try {
    return value == null ? '' : String(value)
  } catch {
    return ''
  }
}

function describeThrown(error) {
  try {
    const text = error instanceof Error ? error.message : String(error)
    return text.length > 160 ? `${text.slice(0, 159)}…` : text
  } catch {
    return 'unknown error'
  }
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`[mcp-tool-schema-diff] ${message}`)
  } catch {
    // Logging is never load-bearing.
  }
}

/** Read an optional service without letting a proxy getter break the load. */
function optionalService(ctx, key) {
  try {
    const value = ctx.get(key, false)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function emptyDiff() {
  return { breaking: 0, warning: 0, info: 0, total: 0, issues: [], signature: '' }
}

/**
 * Server half of a public MCP tool name.
 *
 * `mcp-client` fixes the `mcp__<serverName>__<rawName>` prefix, and a lossy
 * normalization appends `_<12hex>` after a separator, so the first `__` after
 * the prefix is always the server boundary unless a server name itself
 * contains `__` (impossible under the documented `[A-Za-z0-9_-]{1,32}` config
 * pattern). Raw names are never recovered — the public name is the identity
 * callers actually break on.
 */
export function serverOf(publicName) {
  const text = safeText(publicName)
  if (!text.startsWith(PREFIX)) return ''
  const rest = text.slice(PREFIX.length)
  const boundary = rest.indexOf('__')
  if (boundary <= 0) return ''
  const server = rest.slice(0, boundary)
  return SERVER_NAME.test(server) ? server : ''
}

/** Group the live tool registry by MCP server, dropping every non-MCP tool. */
function collectLive(ctx) {
  const live = new Map()
  let schemas
  try {
    const tools = ctx.get('tools', false)
    if (!tools || typeof tools.schemas !== 'function') return live
    schemas = tools.schemas()
  } catch {
    return live
  }
  if (!Array.isArray(schemas)) return live
  for (const schema of schemas) {
    try {
      const publicName = safeText(schema?.name)
      const server = serverOf(publicName)
      if (server === '') continue
      if (!live.has(server)) live.set(server, [])
      live.get(server).push(toolContract(schema))
    } catch {
      // One hostile tool drops only itself.
    }
  }
  return live
}

function clipSummary(text) {
  const value = safeText(text)
  return value.length > NOTICE_SUMMARY_CHARS ? `${value.slice(0, NOTICE_SUMMARY_CHARS - 1)}…` : value
}

function noticeMessage(text) {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `mcp-diff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: clipSummary(text),
    },
  }
}

/** Live root agents, if the `agents` service is present. */
function liveAgents(ctx) {
  try {
    const agents = ctx.get('agents', false)
    if (!agents || typeof agents !== 'object') return []
    if (typeof agents.roots === 'function') {
      const roots = agents.roots()
      return Array.isArray(roots) ? roots : []
    }
    if (typeof agents.list === 'function') {
      const list = agents.list()
      return Array.isArray(list) ? list : []
    }
  } catch {
    // No agent surface this session.
  }
  return []
}

/** Attach a registered command's disposer to this plugin's fiber. */
function keepCommandAlive(ctx, dispose) {
  if (typeof dispose !== 'function' || typeof ctx.effect !== 'function') return
  try {
    ctx.effect(() => dispose, 'mcp-tool-schema-diff command')
  } catch {
    try {
      dispose()
    } catch {
      // Nothing left to release.
    }
  }
}

export function apply(ctx) {
  const state = {
    entries: new Map(),
    memory: new Map(),
    advised: new Set(),
    /** Servers whose first snapshot this process wrote itself. */
    baselines: new Set(),
    /** Last non-empty diff per server, so `/mcp-diff` keeps reporting it after it was persisted. */
    lastDiffs: new Map(),
    checkedAt: 0,
    cachePath: '',
    persistFailed: false,
  }
  let timer = null

  const remember = (server, versions) => {
    state.memory.set(server, versions.slice(-KEEP))
  }

  const persist = (server, tools, root) => {
    const entry = { takenAt: new Date().toISOString(), tools }
    const memory = state.memory.get(server) ?? []
    remember(server, memory.concat([entry]))
    const written = appendVersion(root, server, tools, { takenAt: entry.takenAt })
    if (!written) state.persistFailed = true
    return written
  }

  const advise = (server, diff) => {
    const text = renderNotice(server, diff)
    const key = `${server}|${diff.signature}`
    if (state.advised.has(key)) return
    state.advised.add(key)
    while (state.advised.size > MAX_NOTICES) {
      const oldest = state.advised.values().next().value
      state.advised.delete(oldest)
    }
    warn(ctx, text)
    for (const agent of liveAgents(ctx)) {
      try {
        agent?.followup?.(noticeMessage(text))
      } catch {
        // A single agent's inbox must not block the others.
      }
    }
  }

  const refresh = (notify) => {
    try {
      const root = cacheRoot()
      state.cachePath = root
      const live = collectLive(ctx)
      const entries = new Map()

      for (const [server, tools] of live) {
        const stored = loadVersions(root, server)
        const memory = state.memory.get(server) ?? []
        const history = stored.length > 0 ? stored : memory
        if (stored.length > 0) remember(server, stored)
        const last = history[history.length - 1]
        let diff = emptyDiff()
        let baseline = false

        if (!last) {
          baseline = true
          state.baselines.add(server)
          persist(server, tools, root)
        } else {
          diff = diffSnapshots(last.tools, tools)
          // An identical generation must not consume one of the three slots.
          if (diff.total > 0) {
            persist(server, tools, root)
            state.lastDiffs.set(server, { diff, at: Date.now() })
          }
        }

        // After the changed generation is stored, the latest version already
        // matches the live registry. Keep showing the diff that was detected,
        // otherwise `/mcp-diff` would go quiet the moment the warning matters.
        const reported = diff.total > 0 ? diff : (state.lastDiffs.get(server)?.diff ?? emptyDiff())

        entries.set(server, {
          server,
          connected: true,
          baseline: baseline || (state.baselines.has(server) && reported.total === 0),
          tools: tools.length,
          baseAt: last?.takenAt ?? '',
          diff: reported,
        })
        if (notify && diff.breaking > 0) advise(server, diff)
      }

      // A server the cache knows but this session does not: shown, never
      // alarmed. A profile-level uninstall is not a schema break, and an
      // in-progress reconnect would otherwise page the user twice.
      for (const server of listCachedServers(root)) {
        if (entries.has(server)) continue
        const history = loadVersions(root, server)
        const last = history[history.length - 1]
        entries.set(server, {
          server,
          connected: false,
          baseline: false,
          tools: Array.isArray(last?.tools) ? last.tools.length : 0,
          baseAt: last?.takenAt ?? '',
          diff: emptyDiff(),
        })
      }

      state.entries = entries
      state.checkedAt = Date.now()
    } catch (error) {
      warn(ctx, `schema check failed: ${describeThrown(error)}`)
    }
  }

  const schedule = () => {
    try {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        refresh(true)
      }, DEBOUNCE_MS)
      // Never hold the host process open on a pending check.
      timer?.unref?.()
    } catch {
      // A scheduling failure costs one check.
    }
  }

  try {
    ctx.on('tools/change', schedule, { global: true })
  } catch {
    warn(ctx, 'could not listen for tools/change; schema diff is inactive')
    return
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
      }, 'mcp-tool-schema-diff debounce')
    } catch {
      // Disposal cleanup is best-effort.
    }
  }

  // Tools may already be registered when this plugin loads (upgrade while
  // running), so the first check also runs without waiting for an event.
  schedule()

  const commands = optionalService(ctx, 'commands')
  if (!commands || typeof commands.register !== 'function') return

  const definition = {
    name: 'mcp-diff',
    description: 'MCP tool schema changes since the previous version (breaking / warning / info)',
    handler(invocation) {
      try {
        const raw = safeText(invocation?.rawInput).trim()
        const [verb = '', target = ''] = raw === '' ? [] : raw.split(/\s+/)
        const normalized = verb.toLowerCase()

        if (normalized === 'reset') {
          const root = cacheRoot()
          if (target !== '') {
            forgetServer(root, target)
            state.memory.delete(target)
            state.entries.delete(target)
            state.lastDiffs.delete(target)
            state.baselines.delete(target)
          } else {
            forgetAll(root)
            state.memory.clear()
            state.entries.clear()
            state.lastDiffs.clear()
            state.baselines.clear()
          }
          state.advised.clear()
          return {
            kind: 'success',
            text: target !== ''
              ? `Cleared cached schema versions for "${target}"; the next check re-baselines it.`
              : 'Cleared cached schema versions for every MCP server; the next check re-baselines them.',
          }
        }
        if (normalized !== '') return { kind: 'error', text: 'Usage: /mcp-diff [reset [server]]' }

        // The card is synchronous and must reflect the registry now, not the
        // last timer tick. A manual check never wakes an agent.
        refresh(false)
        return { kind: 'success', text: renderReport(state, Date.now()) }
      } catch (error) {
        return {
          kind: 'error',
          text: `MCP schema diff failed: ${describeThrown(error)}. The watcher is still running; try /mcp-diff again.`,
        }
      }
    },
  }

  try {
    const dispose = commands.register(definition)
    keepCommandAlive(ctx, dispose)
  } catch (error) {
    // A duplicate name (a second copy, or a reload whose old registration
    // survived) costs the command only; the watcher keeps checking.
    warn(ctx, `could not register /mcp-diff: ${describeThrown(error)}`)
  }
}
