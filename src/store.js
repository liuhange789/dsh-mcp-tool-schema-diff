/**
 * Versioned schema snapshots per MCP server.
 *
 * Location: `$DSH_HOME/mcp-schema-cache/<server>.json`, falling back to
 * `~/.dsh/mcp-schema-cache/`. The brief suggested `profiles/web/`, but a
 * plugin cannot learn which profile it runs under (rc.7 exposes no
 * `DSH_PROFILE`), and hard-coding `web` would silently disable the plugin in
 * `tui` and `headless`. Each file keeps the last {@link KEEP} snapshots.
 *
 * Every filesystem failure is reported as `false` and nothing more: a
 * read-only home costs persistence, never the session.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Number of versions retained per server. */
export const KEEP = 3

const FILE_VERSION = 1
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOOLS = 512

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Resolve `$DSH_HOME`, else `~/.dsh`, then the cache directory below it. */
export function cacheRoot() {
  const configured = typeof process !== 'undefined' ? process.env?.DSH_HOME : undefined
  const home = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh')
  return join(home, 'mcp-schema-cache')
}

/** A server name is already `[A-Za-z0-9_-]{1,32}`, but never trust a cache path. */
export function safeServerName(server) {
  try {
    const text = String(server)
    const clean = text.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
    return clean === '' ? '_' : clean
  } catch {
    return '_'
  }
}

function fileOf(root, server) {
  return join(root, `${safeServerName(server)}.json`)
}

function normalizeVersions(raw) {
  if (!Array.isArray(raw)) return []
  const versions = []
  for (const entry of raw) {
    try {
      if (!isRecord(entry) || !Array.isArray(entry.tools)) continue
      if (entry.tools.length > MAX_TOOLS) continue
      versions.push({
        takenAt: typeof entry.takenAt === 'string' ? entry.takenAt : '',
        tools: entry.tools,
      })
    } catch {
      // A cache edited by hand may contain anything; skip what cannot be read.
    }
  }
  return versions.slice(-KEEP)
}

/**
 * Read the retained versions of one server.
 * @param root - cache directory.
 * @param server - MCP server name.
 * @returns Versions in chronological order, or `[]` when absent or unreadable.
 */
export function loadVersions(root, server) {
  try {
    const file = fileOf(root, server)
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    if (typeof text !== 'string' || text.length > MAX_FILE_BYTES * 2) return []
    const data = JSON.parse(text)
    if (!isRecord(data)) return []
    return normalizeVersions(data.versions)
  } catch {
    return []
  }
}

/**
 * Append one snapshot, trimming history to {@link KEEP}.
 * Written through a temporary file so a killed process cannot leave a
 * half-written cache that looks like a schema change.
 * @param root - cache directory.
 * @param server - MCP server name.
 * @param tools - contracts captured from the live registry.
 * @param options - `{ takenAt }`, defaults to now.
 * @returns `true` only when the file is durably replaced.
 */
export function appendVersion(root, server, tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > MAX_TOOLS) return false
  const takenAt = typeof options.takenAt === 'string' && options.takenAt !== ''
    ? options.takenAt
    : new Date().toISOString()
  const versions = loadVersions(root, server).concat([{ takenAt, tools }]).slice(-KEEP)
  const text = JSON.stringify({ version: FILE_VERSION, server: safeServerName(server), versions })
  if (text.length > MAX_FILE_BYTES) return false

  const file = fileOf(root, server)
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      // Windows can refuse replace-rename; retry once after clearing the target.
      try {
        unlinkSync(file)
      } catch {
        // The target may not exist yet.
      }
      renameSync(tmp, file)
    }
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing was written, or the temporary already vanished.
    }
    return false
  }
}

/**
 * List servers with a cache file, for the "cached but not connected" line.
 * @param root - cache directory.
 */
export function listCachedServers(root) {
  try {
    const names = readdirSync(root)
    const servers = new Set()
    for (const name of names) {
      if (typeof name !== 'string' || !name.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(join(root, name), 'utf8'))
        if (isRecord(data) && typeof data.server === 'string' && data.server !== '') {
          servers.add(data.server)
          continue
        }
      } catch {
        // Fall back to the filename below.
      }
      servers.add(name.slice(0, -'.json'.length))
    }
    return [...servers].sort()
  } catch {
    return []
  }
}

/** Drop one server's cached versions. */
export function forgetServer(root, server) {
  try {
    unlinkSync(fileOf(root, server))
    return true
  } catch {
    return false
  }
}

/** Drop every cached server. */
export function forgetAll(root) {
  try {
    for (const name of readdirSync(root)) {
      if (typeof name === 'string' && name.endsWith('.json')) {
        try {
          unlinkSync(join(root, name))
        } catch {
          // One locked file does not block the rest.
        }
      }
    }
    return true
  } catch {
    return false
  }
}
