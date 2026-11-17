/**
 * Pure MCP tool-contract extraction and diff.
 *
 * A contract is the part of a tool definition a caller can break on: the tool's
 * presence, its description identity, and the JSON Schema of its parameters.
 * Everything here is defensive. Registration already validates the schema, but
 * this module also runs on hostile test doubles and on cache files a user could
 * have edited, so every read is contained and recursion is cycle-bounded.
 *
 * Severity rules (the reason this plugin exists):
 *   breaking — an existing call would now fail validation or find no tool:
 *              tool removed, parameter removed, accepted type removed,
 *              a new required parameter, enum/const narrowed, new array item
 *              schema requirement.
 *   warning  — the call still validates but may behave differently:
 *              default changed, constraint changed, composed schema changed.
 *   info     — safe to ignore for existing callers: tool added, optional
 *              parameter added, required dropped, enum widened, description.
 */

import { createHash } from 'node:crypto'

/** Recursion and payload bounds: a hostile schema must not cost the session. */
const MAX_DEPTH = 4
const MAX_PROPS = 64
const MAX_ENUM = 64
const MAX_REQUIRED = 64
const MAX_OPAQUE = 320

/** Keys that carry prose, never contract. Ignored by structural comparison. */
const PROSE_KEYS = new Set([
  'description',
  'title',
  'examples',
  'example',
  '$comment',
  'deprecated',
  'markdownDescription',
])

/** Keys whose whole value is compared as one opaque signature. */
const OPAQUE_KEYS = [
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'dependentSchemas',
  'if',
  'then',
  'else',
]

/** Keys that restrict accepted values without changing their type. */
const CONSTRAINT_KEYS = [
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]

const SEVERITY_RANK = { breaking: 0, warning: 1, info: 2 }

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deterministic, key-sorted JSON without prose, cycle-safe and total. */
function stableStringify(value, seen = new WeakSet()) {
  try {
    if (value === null) return 'null'
    const type = typeof value
    if (type === 'string') return JSON.stringify(value)
    if (type === 'number' || type === 'boolean') return String(value)
    if (type === 'bigint') return `${String(value)}n`
    if (type !== 'object') return 'undefined'
    if (seen.has(value)) return '"<cycle>"'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const items = []
        for (const item of value) items.push(stableStringify(item, seen))
        return `[${items.join(',')}]`
      }
      const keys = Object.keys(value).filter(key => !PROSE_KEYS.has(key)).sort()
      const items = []
      for (const key of keys) {
        const encoded = stableStringify(value[key], seen)
        if (encoded !== 'undefined') items.push(`${JSON.stringify(key)}:${encoded}`)
      }
      return `{${items.join(',')}}`
    } finally {
      seen.delete(value)
    }
  } catch {
    // A getter that throws or an exotic proxy yields no comparable value.
    return 'undefined'
  }
}

function encodeLiteral(value) {
  const text = stableStringify(value)
  if (text === 'undefined') return undefined
  if (text.length <= 120) return text
  // Keep the readable prefix, but the hash is what makes an edit past the
  // cutoff visible instead of silently identical.
  return `${text.slice(0, 100)}…#${hash(text)}`
}

/** Short deterministic digest of a long string, used where truncation must not hide changes. */
function hash(text) {
  try {
    return createHash('sha256').update(String(text)).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

/** Types that a later type list still accepts; JSON Schema `number` accepts integers. */
const WIDER_TYPES = new Map([['integer', 'number']])

function acceptsType(afterTypes, beforeType) {
  if (afterTypes.includes(beforeType)) return true
  const wider = WIDER_TYPES.get(beforeType)
  return wider !== undefined && afterTypes.includes(wider)
}

/** Detail text that names a bounded number of values, so the notice keeps its call to action. */
function joinValues(values, limit = 5) {
  if (!Array.isArray(values) || values.length === 0) return ''
  const shown = values.slice(0, limit).join(', ')
  return values.length > limit ? `${shown} … (+${values.length - limit} more)` : shown
}

/** The value set a parameter accepts: `const` is a one-value enum. */
function allowedOf(node) {
  if (!isRecord(node)) return undefined
  if (node.c !== undefined) return [node.c]
  if (Array.isArray(node.e)) return node.e
  return undefined
}

function sameValues(a, b) {
  return a.length === b.length && a.every(value => b.includes(value))
}

function typeList(node) {
  try {
    const raw = node?.type
    if (typeof raw === 'string') return raw.split('|').filter(Boolean)
    if (Array.isArray(raw)) return raw.filter(item => typeof item === 'string')
  } catch {
    // Hostile `type` getter: no declared type.
  }
  return []
}

function kindOf(node) {
  const types = typeList(node)
  if (types.length > 0) return [...new Set(types)].sort().join('|')
  try {
    if (isRecord(node?.properties)) return 'object'
    if (isRecord(node?.items) || Array.isArray(node?.items)) return 'array'
  } catch {
    // Same containment as above.
  }
  return 'any'
}

function enumOf(node) {
  try {
    const values = node?.enum
    if (!Array.isArray(values)) return undefined
    const encoded = []
    for (const value of values) {
      const text = encodeLiteral(value)
      if (text !== undefined) encoded.push(text)
    }
    if (encoded.length === 0) return undefined
    // Sort before the cap so a pure reorder can never look like a narrowed set.
    const sorted = [...encoded].sort()
    return {
      values: sorted.slice(0, MAX_ENUM),
      truncated: sorted.length > MAX_ENUM,
      hash: hash(sorted.join('\u0000')),
    }
  } catch {
    return undefined
  }
}

function literalOf(node, key) {
  try {
    if (node == null || !(key in node)) return undefined
    return encodeLiteral(node[key])
  } catch {
    return undefined
  }
}

function constraintsOf(node) {
  const out = {}
  let any = false
  for (const key of CONSTRAINT_KEYS) {
    const encoded = literalOf(node, key)
    if (encoded === undefined) continue
    out[key] = encoded
    any = true
  }
  return any ? out : undefined
}

function requiredOf(node) {
  try {
    const raw = node?.required
    if (!Array.isArray(raw)) return { names: [], truncated: false, hash: '' }
    const names = []
    for (const name of raw) {
      if (typeof name === 'string') names.push(name)
    }
    const sorted = [...new Set(names)].sort()
    return {
      names: sorted.slice(0, MAX_REQUIRED),
      truncated: sorted.length > MAX_REQUIRED,
      hash: hash(sorted.join('\u0000')),
    }
  } catch {
    return { names: [], truncated: false, hash: '' }
  }
}

function opaqueOf(node) {
  const parts = []
  try {
    for (const key of OPAQUE_KEYS) {
      if (node == null || !(key in node)) continue
      const encoded = stableStringify(node[key])
      if (encoded !== 'undefined') parts.push(`${key}:${encoded}`)
    }
    // Tuple items are a list, not a schema object; keep them comparable as a whole.
    if (Array.isArray(node?.items)) {
      const encoded = stableStringify(node.items)
      if (encoded !== 'undefined') parts.push(`items:${encoded}`)
    }
  } catch {
    return undefined
  }
  if (parts.length === 0) return undefined
  const text = parts.join('|')
  return text.length > MAX_OPAQUE ? `${text.slice(0, MAX_OPAQUE - 13)}…#${hash(text)}` : text
}

/**
 * Reduce one JSON Schema node to the contract fields this plugin compares.
 * @param node - any value a server claimed was a schema.
 * @param depth - recursion depth, bounded by {@link MAX_DEPTH}.
 * @param seen - cycle guard for hostile or accidental self-reference.
 */
function normalize(node, depth, seen) {
  // JSON Schema allows boolean schemas: `true` accepts anything, `false` nothing.
  if (node === true) return { k: 'any' }
  if (node === false) return { k: 'never' }
  if (!isRecord(node)) return { k: 'any' }
  if (seen.has(node)) return { k: 'cycle' }
  if (depth > MAX_DEPTH) {
    // Past the depth budget, compare a digest instead of silently ignoring it.
    return { k: 'deep', h: hash(stableStringify(node)) }
  }
  seen.add(node)
  try {
    const out = { k: kindOf(node) }
    const types = typeList(node)
    if (types.length > 0) out.ts = [...new Set(types)].sort()

    const values = enumOf(node)
    if (values) {
      out.e = values.values
      if (values.truncated) out.et = true
      out.eh = values.hash
    }
    const constant = literalOf(node, 'const')
    if (constant !== undefined) out.c = constant
    const fallback = literalOf(node, 'default')
    if (fallback !== undefined) out.d = fallback
    const constraints = constraintsOf(node)
    if (constraints) out.f = constraints
    const required = requiredOf(node)
    if (required.names.length > 0) out.r = required.names
    if (required.truncated) out.rt = true
    out.rh = required.hash

    if (isRecord(node.properties)) {
      const keys = Object.keys(node.properties).sort()
      const properties = {}
      let kept = 0
      let truncated = false
      for (const key of keys) {
        if (kept >= MAX_PROPS) {
          truncated = true
          break
        }
        properties[key] = normalize(node.properties[key], depth + 1, seen)
        kept += 1
      }
      out.p = properties
      out.ph = hash(keys.join('\u0000'))
      if (truncated) out.pt = true
    }
    if (Array.isArray(node.items)) {
      // Tuple validation; the opaque signature above carries the member schemas.
      out.i = { k: 'tuple' }
    } else if (node.items === true || node.items === false) {
      out.i = { k: node.items ? 'any' : 'never' }
    } else if (isRecord(node.items)) {
      out.i = normalize(node.items, depth + 1, seen)
    }

    const opaque = opaqueOf(node)
    if (opaque) out.o = opaque
    return out
  } catch {
    return { k: kindOf(node) }
  } finally {
    seen.delete(node)
  }
}

/** Hash a description so prose edits cost one small field, not a full copy. */
function digest(text) {
  try {
    return createHash('sha256').update(text).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

function safeText(value, limit) {
  try {
    if (value == null) return ''
    const text = String(value)
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return ''
  }
}

/**
 * Build the persisted contract for one visible tool schema.
 * @param schema - `{ name, description, parameters }` as `ctx.tools.schemas()` returns it.
 * @returns `{ n, d, s }`: name, description digest, normalized parameter schema.
 */
export function toolContract(schema) {
  return {
    n: safeText(schema?.name, 256),
    d: digest(safeText(schema?.description, 100000)),
    s: normalize(schema?.parameters, 0, new WeakSet()),
  }
}

function issue(severity, kind, tool, path, detail) {
  return { severity, kind, tool, path, detail }
}

function describeTypes(types) {
  return joinValues(types) || 'any'
}

function showEncoded(value) {
  return value === undefined ? 'unset' : value
}

function joinPath(prefix, key) {
  return prefix === '' ? key : `${prefix}.${key}`
}

function compareNode(before, after, tool, path, issues) {
  if (!isRecord(before) || !isRecord(after)) return

  // Below the depth budget only a digest exists, so the honest report is
  // "something changed", never a guessed direction.
  if (before.k === 'deep' || after.k === 'deep') {
    if (before.h !== after.h) {
      issues.push(issue(
        'warning',
        'param.truncated',
        tool,
        path,
        `${path} changed below the ${MAX_DEPTH}-level comparison limit; inspect this tool by hand`,
      ))
    }
    return
  }
  if (before.k === 'cycle' || after.k === 'cycle') return

  if (after.k === 'never' && before.k !== 'never') {
    issues.push(issue('breaking', 'param.never', tool, path, `${path} now accepts no value`))
    return
  }
  if (before.k === 'never' && after.k !== 'never') {
    issues.push(issue('info', 'param.type.widened', tool, path, `${path} accepts values again`))
  }

  const beforeTypes = Array.isArray(before.ts) ? before.ts : undefined
  const afterTypes = Array.isArray(after.ts) ? after.ts : undefined
  if (beforeTypes && afterTypes) {
    const lostTypes = beforeTypes.filter(type => !acceptsType(afterTypes, type))
    const gainedTypes = afterTypes.filter(type => !beforeTypes.includes(type))
    if (lostTypes.length > 0) {
      // Deeper shape is meaningless once an accepted type is gone.
      issues.push(issue(
        'breaking',
        'param.type.changed',
        tool,
        path,
        `${path} no longer accepts ${describeTypes(lostTypes)} (now ${describeTypes(afterTypes)})`,
      ))
      return
    }
    if (gainedTypes.length > 0) {
      issues.push(issue(
        'info',
        'param.type.widened',
        tool,
        path,
        `${path} now also accepts ${describeTypes(gainedTypes)}`,
      ))
    }
  } else if (beforeTypes || afterTypes) {
    // The other side is composed (`anyOf`, `$ref`, ...) or untyped. Claiming a
    // lost type here would turn every union/nullable schema into a false break.
    issues.push(issue(
      'warning',
      'param.type.undeclared',
      tool,
      path,
      `${path} ${beforeTypes ? 'no longer declares' : 'now declares'} a plain type; check the schema source`,
    ))
  }

  // `const` is a one-value enum: compare accepted value sets, never the syntax
  // a server chose, so `const: "a"` -> `enum: ["a","b"]` is a widening.
  const beforeAllowed = allowedOf(before)
  const afterAllowed = allowedOf(after)
  if (beforeAllowed && afterAllowed) {
    if (before.et || after.et) {
      if (before.eh !== after.eh) {
        issues.push(issue(
          'warning',
          'param.values.truncated',
          tool,
          path,
          `${path} allowed values changed beyond the ${MAX_ENUM}-value comparison limit`,
        ))
      }
    } else {
      const lostValues = beforeAllowed.filter(value => !afterAllowed.includes(value))
      const gainedValues = afterAllowed.filter(value => !beforeAllowed.includes(value))
      if (lostValues.length > 0) {
        issues.push(issue(
          'breaking',
          'param.enum.narrowed',
          tool,
          path,
          `${path} no longer accepts ${joinValues(lostValues)}`,
        ))
      }
      if (gainedValues.length > 0) {
        issues.push(issue(
          'info',
          'param.enum.widened',
          tool,
          path,
          `${path} now also accepts ${joinValues(gainedValues)}`,
        ))
      }
    }
  } else if (!beforeAllowed && afterAllowed) {
    issues.push(issue('breaking', 'param.enum.added', tool, path, `${path} now accepts only ${joinValues(afterAllowed)}`))
  } else if (beforeAllowed && !afterAllowed) {
    issues.push(issue('info', 'param.enum.removed', tool, path, `${path} no longer restricts its values`))
  }

  if (before.d !== after.d) {
    issues.push(issue(
      'warning',
      'param.default.changed',
      tool,
      path,
      `${path} default changed from ${showEncoded(before.d)} to ${showEncoded(after.d)}`,
    ))
  }

  const beforeConstraints = before.f ?? {}
  const afterConstraints = after.f ?? {}
  const changedConstraints = [...new Set([...Object.keys(beforeConstraints), ...Object.keys(afterConstraints)])]
    .filter(key => beforeConstraints[key] !== afterConstraints[key])
  if (changedConstraints.length > 0) {
    issues.push(issue(
      'warning',
      'param.constraints.changed',
      tool,
      path,
      `${path} constraint${changedConstraints.length === 1 ? '' : 's'} changed: ${joinValues(changedConstraints)}`,
    ))
  }

  if (before.o !== after.o && (before.o || after.o)) {
    issues.push(issue('warning', 'param.schema.changed', tool, path, `${path} composed schema changed`))
  }

  const beforeRequired = before.r ?? []
  const afterRequired = after.r ?? []
  const addedRequired = afterRequired.filter(name => !beforeRequired.includes(name))
  const droppedRequired = beforeRequired.filter(name => !afterRequired.includes(name))
  for (const name of addedRequired) {
    issues.push(issue(
      'breaking',
      'param.required.added',
      tool,
      joinPath(path, name),
      `${joinPath(path, name)} is now required`,
    ))
  }
  for (const name of droppedRequired) {
    issues.push(issue(
      'info',
      'param.required.removed',
      tool,
      joinPath(path, name),
      `${joinPath(path, name)} is no longer required`,
    ))
  }
  if (addedRequired.length === 0 && droppedRequired.length === 0
    && (before.rt || after.rt) && before.rh !== after.rh) {
    issues.push(issue(
      'warning',
      'param.required.truncated',
      tool,
      path,
      `${path} required list changed beyond the ${MAX_REQUIRED}-name comparison limit`,
    ))
  }

  const beforeProps = before.p ?? {}
  const afterProps = after.p ?? {}
  let removedProps = 0
  let addedProps = 0
  for (const name of Object.keys(beforeProps)) {
    if (Object.hasOwn(afterProps, name)) continue
    removedProps += 1
    issues.push(issue(
      'breaking',
      'param.removed',
      tool,
      joinPath(path, name),
      `${joinPath(path, name)} was removed`,
    ))
  }
  for (const name of Object.keys(afterProps)) {
    if (Object.hasOwn(beforeProps, name)) continue
    // A new required property was already reported as required.added.
    if (afterRequired.includes(name)) continue
    addedProps += 1
    issues.push(issue(
      'info',
      'param.added',
      tool,
      joinPath(path, name),
      `${joinPath(path, name)} is new and optional`,
    ))
  }
  if (removedProps === 0 && addedProps === 0
    && (before.pt || after.pt) && before.ph !== after.ph) {
    issues.push(issue(
      'warning',
      'param.properties.truncated',
      tool,
      path,
      `${path} property list changed beyond the ${MAX_PROPS}-property comparison limit`,
    ))
  }
  for (const name of Object.keys(beforeProps)) {
    if (!Object.hasOwn(afterProps, name)) continue
    compareNode(beforeProps[name], afterProps[name], tool, joinPath(path, name), issues)
  }

  if (before.i || after.i) {
    if (before.i && after.i) {
      compareNode(before.i, after.i, tool, `${path}[]`, issues)
    } else {
      issues.push(issue(
        'warning',
        'param.items.changed',
        tool,
        path,
        `${path} item schema ${before.i ? 'was removed' : 'was added'}`,
      ))
    }
  }
}

function toContractMap(contracts) {
  const map = new Map()
  if (!Array.isArray(contracts)) return map
  for (const contract of contracts) {
    try {
      if (!isRecord(contract) || typeof contract.n !== 'string' || contract.n === '') continue
      if (!isRecord(contract.s)) continue
      map.set(contract.n, contract)
    } catch {
      // One unreadable entry is not allowed to stop a whole server's diff.
    }
  }
  return map
}

/**
 * Compare two persisted tool generations.
 * @param before - contracts from the previous version (`{ n, d, s }[]`).
 * @param after - contracts from the current version.
 * @returns Counts, the ordered issue list, and a signature for duplicate advice.
 */
export function diffSnapshots(before, after) {
  const issues = []
  const oldMap = toContractMap(before)
  const newMap = toContractMap(after)

  for (const name of oldMap.keys()) {
    if (newMap.has(name)) continue
    issues.push(issue('breaking', 'tool.removed', name, '', `tool ${name} was removed`))
  }
  for (const name of newMap.keys()) {
    if (oldMap.has(name)) continue
    issues.push(issue('info', 'tool.added', name, '', `tool ${name} is new`))
  }
  for (const [name, oldContract] of oldMap) {
    const newContract = newMap.get(name)
    if (!newContract) continue
    try {
      if (oldContract.d !== newContract.d) {
        issues.push(issue('info', 'tool.description.changed', name, '', `${name} description changed`))
      }
      compareNode(oldContract.s, newContract.s, name, 'parameters', issues)
    } catch {
      // A hostile contract degrades one tool, not the report.
    }
  }

  issues.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.kind.localeCompare(b.kind)
    || a.tool.localeCompare(b.tool)
    || a.path.localeCompare(b.path))

  const breaking = issues.filter(item => item.severity === 'breaking')
  const warning = issues.filter(item => item.severity === 'warning')
  const info = issues.filter(item => item.severity === 'info')
  const signature = issues
    // The detail carries the actual values: the same path narrowing twice
    // (`enum [a,b,c] -> [a,b]` then `-> [a]`) is two different alarms.
    .map(item => `${item.kind}:${item.tool}:${item.path}:${item.detail}`)
    .join('|')
    .slice(0, 400)

  return {
    breaking: breaking.length,
    warning: warning.length,
    info: info.length,
    total: issues.length,
    issues,
    signature,
  }
}
