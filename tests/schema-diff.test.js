import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { apply, DEBOUNCE_MS, name, serverOf } from '../src/index.js'
import { diffSnapshots, toolContract } from '../src/contract.js'

// The real cordis runtime shipped with DeepSeek Harness 0.1.0-rc.7.
const CORDIS = process.env.CORDIS_PATH ?? 'D:/新建文件夹/DeepSeek-Harness/vendor/cordis/lib/index.js'
const { Context } = await import(pathToFileURL(CORDIS).href)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/** Fires after the plugin's quiet window, with headroom for CI scheduling. */
const WAIT = DEBOUNCE_MS + 200
const originalHome = process.env.DSH_HOME

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'mcp-diff-'))
  process.env.DSH_HOME = home
  return home
}

function restoreHome() {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
}

function cleanup(home) {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Windows can hold a directory briefly; the temp folder is disposable.
  }
  restoreHome()
}

function cacheFile(home, server) {
  return join(home, 'mcp-schema-cache', `${server}.json`)
}

function readVersions(home, server) {
  const file = cacheFile(home, server)
  if (!existsSync(file)) return []
  return JSON.parse(readFileSync(file, 'utf8')).versions
}

function tool(toolName, parameters, description = '') {
  return { name: toolName, description, parameters }
}

function boot(options = {}) {
  const ctx = new Context()
  const schemas = options.schemas ? [...options.schemas] : []
  if (options.tools !== false) ctx.provide('tools', { schemas: () => schemas })

  const registered = []
  if (options.commands !== false) {
    ctx.provide('commands', options.commands ?? {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    })
  }

  const notices = []
  if (options.agents !== false) {
    const agent = { id: 'agent-1', followup(message) { notices.push(message) } }
    ctx.provide('agents', options.agents ?? { roots: () => [agent], list: () => [agent] })
  }

  ctx.plugin({ name, apply })

  return {
    ctx,
    notices,
    registered,
    schemas,
    setSchemas(next, emit = true) {
      schemas.splice(0, schemas.length, ...next)
      if (emit) ctx.emit(null, 'tools/change')
    },
  }
}

function command(booted, rawInput) {
  const definition = booted.registered.find(item => item.name === 'mcp-diff')
  assert.ok(definition, '/mcp-diff was not registered')
  return definition.handler({ rawInput })
}

function stop(ctx) {
  ctx.registry?.stop?.()
}

const SEARCH_V1 = tool('mcp__github__search', {
  type: 'object',
  properties: {
    query: { type: 'string' },
    options: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        format: { type: 'string', enum: ['json', 'text'] },
      },
    },
  },
  required: ['query'],
}, 'Search issues')

const SEARCH_V2 = tool('mcp__github__search', {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    options: {
      type: 'object',
      properties: {
        limit: { type: 'string' },
        format: { type: 'string', enum: ['json'] },
      },
    },
  },
  required: ['owner'],
}, 'Search issues')

const CREATE_ISSUE = tool('mcp__github__create_issue', {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
}, 'Create an issue')

const LIST_REPOS = tool('mcp__github__list_repos', {
  type: 'object',
  properties: {},
}, 'List repositories')

test('first connection records a baseline and stays silent', async () => {
  const home = tempHome()
  const booted = boot({
    schemas: [tool('mcp__srv__greet', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })],
  })
  await sleep(WAIT)

  assert.equal(booted.notices.length, 0, 'a baseline must never alarm')
  const versions = readVersions(home, 'srv')
  assert.equal(versions.length, 1)
  assert.equal(versions[0].tools.length, 1)

  const result = command(booted, '')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /baseline recorded \(1 tool\)/)
  assert.match(result.text, /0 breaking changes/)

  stop(booted.ctx)
  cleanup(home)
})

test('marks every breaking shape change after an upgrade', async () => {
  const home = tempHome()
  const booted = boot({ schemas: [SEARCH_V1, CREATE_ISSUE, LIST_REPOS] })
  await sleep(WAIT)

  booted.setSchemas([SEARCH_V2, CREATE_ISSUE])
  await sleep(WAIT)

  assert.equal(booted.notices.length, 1, 'one notice per unique breaking diff')
  const notice = booted.notices[0]
  assert.match(notice.content[0].text, /github/)
  assert.match(notice.content[0].text, /5 breaking changes/)
  assert.match(notice.content[0].text, /Run \/mcp-diff/)
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.form, 'notice')

  const versions = readVersions(home, 'github')
  assert.equal(versions.length, 2, 'the changed generation is appended')

  const result = command(booted, '')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /github · 5 breaking · 0 warning · 1 info/)
  assert.match(result.text, /tool mcp__github__list_repos was removed/)
  assert.match(result.text, /parameters\.query was removed/)
  assert.match(result.text, /parameters\.owner is now required/)
  assert.match(result.text, /parameters\.options\.limit no longer accepts number/)
  assert.match(result.text, /parameters\.options\.format no longer accepts "text"/)

  // A repeat of the same generation must not warn twice.
  booted.setSchemas([SEARCH_V2, CREATE_ISSUE])
  await sleep(WAIT)
  assert.equal(booted.notices.length, 1)

  stop(booted.ctx)
  cleanup(home)
})

test('debounces re-sync churn instead of reporting removed tools', async () => {
  const home = tempHome()
  const stable = [tool('mcp__srv__fetch', {
    type: 'object',
    properties: { url: { type: 'string' }, timeout: { type: 'number' } },
    required: ['url'],
  })]
  const booted = boot({ schemas: stable })
  await sleep(WAIT)

  // What an mcp-client re-sync looks like from the event bus: empty, partial,
  // then the full generation, all inside one quiet window.
  booted.setSchemas([])
  await sleep(20)
  booted.setSchemas([tool('mcp__srv__fetch', {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  })])
  await sleep(20)
  booted.setSchemas(stable)
  await sleep(WAIT)

  assert.equal(booted.notices.length, 0, 'intermediate generations must never alarm')
  assert.equal(readVersions(home, 'srv').length, 1, 'an unchanged generation is not stored again')
  const result = command(booted, '')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /0 breaking changes/)
  assert.ok(!result.text.includes('was removed'))

  stop(booted.ctx)
  cleanup(home)
})

test('keeps the last three versions only', async () => {
  const home = tempHome()
  const booted = boot({ schemas: [tool('mcp__srv__a', { type: 'object', properties: { value: { type: 'string' } } })] })
  await sleep(WAIT)

  booted.setSchemas([tool('mcp__srv__a', { type: 'object', properties: { value: { type: 'number' } } })])
  await sleep(WAIT)
  booted.setSchemas([tool('mcp__srv__a', { type: 'object', properties: { value: { type: 'boolean' } } })])
  await sleep(WAIT)
  booted.setSchemas([
    tool('mcp__srv__a', { type: 'object', properties: { value: { type: 'boolean' } } }),
    tool('mcp__srv__b', { type: 'object', properties: {} }),
  ])
  await sleep(WAIT)

  const versions = readVersions(home, 'srv')
  assert.equal(versions.length, 3)
  const latest = versions[versions.length - 1]
  assert.ok(latest.tools.some(item => item.n === 'mcp__srv__b'), 'the newest generation is retained')

  stop(booted.ctx)
  cleanup(home)
})

test('treats a registry teardown as silence, not as removed tools', async () => {
  const home = tempHome()
  const booted = boot({ schemas: [tool('mcp__srv__one', { type: 'object', properties: {} })] })
  await sleep(WAIT)

  booted.setSchemas([])
  await sleep(WAIT)

  assert.equal(booted.notices.length, 0)
  assert.equal(readVersions(home, 'srv').length, 1, 'shutdown must not consume a version slot')
  assert.match(command(booted, '').text, /cached, server not connected/)

  stop(booted.ctx)
  cleanup(home)
})

test('survives malformed, circular and hostile schemas', async () => {
  const home = tempHome()
  const circular = { type: 'object', properties: { self: null } }
  circular.properties.self = circular

  const booted = boot({
    schemas: [
      tool('mcp__odd__null_params', null),
      tool('mcp__odd__circular', { type: 'object', properties: { loop: circular, mixed: { type: ['string', 5] } } }),
      tool('mcp__odd__array_params', [1, 2, 3]),
    ],
  })
  await sleep(WAIT)

  assert.equal(readVersions(home, 'odd').length, 1, 'the baseline is still writable')

  booted.setSchemas([tool('mcp__odd__null_params', { type: 'object', properties: { a: { type: 'integer' } } })])
  await sleep(WAIT)

  const result = command(booted, '')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /mcp__odd__circular was removed/)
  assert.doesNotThrow(() => diffSnapshots(
    [{ n: 'x', d: '', s: null }],
    [{ n: 'x', d: '', s: { k: 'object' } }],
  ))

  stop(booted.ctx)
  cleanup(home)
})

test('loads silently without a commands service or tools registry', async () => {
  const home = tempHome()
  const booted = boot({ commands: false, schemas: [tool('mcp__srv__x', { type: 'object' })] })
  await sleep(WAIT)
  assert.equal(readVersions(home, 'srv').length, 1)
  stop(booted.ctx)

  // A bare context: no tools registry and no commands service at all.
  const bare = new Context()
  bare.plugin({ name, apply })
  await sleep(WAIT)
  assert.ok(!existsSync(join(home, 'mcp-schema-cache', 'missing.json')))
  stop(bare)

  cleanup(home)
})

test('keeps watching when a second copy cannot take /mcp-diff', async () => {
  const home = tempHome()
  const accepted = []
  const commands = {
    register(definition) {
      if (accepted.some(item => item.name === definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      accepted.push(definition)
      return () => {}
    },
  }
  const booted = boot({ commands, schemas: [tool('mcp__srv__a', { type: 'object' })] })
  booted.ctx.plugin({ name, apply })
  await sleep(WAIT)

  assert.equal(accepted.length, 1, 'only the first copy owns the command')
  booted.setSchemas([tool('mcp__srv__a', { type: 'object', properties: { b: { type: 'string' } } })])
  await sleep(WAIT)
  assert.equal(command({ registered: accepted }, '').kind, 'success')

  stop(booted.ctx)
  cleanup(home)
})

test('degrades to in-memory history when the cache is not writable', async () => {
  restoreHome()
  const blocked = join(tmpdir(), `mcp-diff-blocked-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  writeFileSync(blocked, 'not a directory', 'utf8')
  process.env.DSH_HOME = blocked

  const booted = boot({ schemas: [tool('mcp__srv__a', { type: 'object', properties: { value: { type: 'string' } } })] })
  await sleep(WAIT)
  assert.equal(booted.notices.length, 0)
  assert.ok(!existsSync(join(blocked, 'mcp-schema-cache')))

  booted.setSchemas([tool('mcp__srv__a', { type: 'object', properties: { value: { type: 'integer' } } })])
  await sleep(WAIT)
  assert.equal(booted.notices.length, 1, 'in-memory history still detects the break')

  const result = command(booted, '')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /not writable, using in-memory history/)
  assert.match(result.text, /1 breaking/)

  stop(booted.ctx)
  try {
    rmSync(blocked, { force: true })
  } catch {
    // The temp file is disposable.
  }
  restoreHome()
})

test('reset clears the cache and the next check re-baselines', async () => {
  const home = tempHome()
  const booted = boot({ schemas: [tool('mcp__srv__a', { type: 'object', properties: { value: { type: 'string' } } })] })
  await sleep(WAIT)
  assert.ok(existsSync(cacheFile(home, 'srv')))

  const reset = command(booted, 'reset srv')
  assert.equal(reset.kind, 'success')
  assert.match(reset.text, /Cleared cached schema versions for "srv"/)
  assert.ok(!existsSync(cacheFile(home, 'srv')))

  const after = command(booted, '')
  assert.equal(after.kind, 'success')
  assert.match(after.text, /baseline recorded/)
  assert.equal(readVersions(home, 'srv').length, 1)

  const bad = command(booted, 'nonsense')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /Usage: \/mcp-diff/)

  stop(booted.ctx)
  cleanup(home)
})

test('parses only the documented mcp__ naming and ignores other tools', () => {
  assert.equal(serverOf('mcp__github__create_issue'), 'github')
  assert.equal(serverOf('mcp__a_b__tool'), 'a_b')
  assert.equal(serverOf('mcp__srv__raw_0123456789ab'), 'srv')
  assert.equal(serverOf('mcp__'), '')
  assert.equal(serverOf('bash'), '')
  assert.equal(toolContract({ name: 'mcp__srv__x', parameters: {} }).n, 'mcp__srv__x')
})
