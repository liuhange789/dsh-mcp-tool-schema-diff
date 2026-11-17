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
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
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
    const out = []
    for (const value of values.slice(0, MAX_ENUM)) {
      const encoded = encodeLiteral(value)
      if (encoded !== undefined) out.push(encoded)
    }
    return out.length > 0 ? out : undefined
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
    if (!Array.isArray(raw)) return []
    const names = []
    for (const name of raw.slice(0, MAX_REQUIRED)) {
      if (typeof name === 'string') names.push(name)
    }
    return [...new Set(names)].sort()
  } catch {
    return []
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
  } catch {
    return undefined
  }
  if (parts.length === 0) return undefined
  const text = parts.join('|')
  return text.length > MAX_OPAQUE ? text.slice(0, MAX_OPAQUE) : text
}

/**
 * Reduce one JSON Schema node to the contract fields this plugin compares.
 * @param node - any value a server claimed was a schema.
 * @param depth - recursion depth, bounded by {@link MAX_DEPTH}.
 * @param seen - cycle guard for hostile or accidental self-reference.
 */
function normalize(node, depth, seen) {
  if (!isRecord(node)) return { k: 'any' }
  if (seen.has(node)) return { k: 'cycle' }
  if (depth > MAX_DEPTH) return { k: 'deep' }
  seen.add(node)
  try {
    const out = { k: kindOf(node) }
    const types = typeList(node)
    if (types.length > 0) out.ts = [...new Set(types)].sort()

    const values = enumOf(node)
    if (values) out.e = values
    const constant = literalOf(node, 'const')
    if (constant !== undefined) out.c = constant
    const fallback = literalOf(node, 'default')
    if (fallback !== undefined) out.d = fallback
    const constraints = constraintsOf(node)
    if (constraints) out.f = constraints
    const required = requiredOf(node)
    if (required.length > 0) out.r = required

    if (isRecord(node.properties)) {
      const properties = {}
      let kept = 0
      let truncated = false
      for (const key of Object.keys(node.properties).sort()) {
        if (kept >= MAX_PROPS) {
          truncated = true
          break
        }
        properties[key] = normalize(node.properties[key], depth + 1, seen)
        kept += 1
      }
      out.p = properties
      if (truncated) out.pt = true
    }
    if (isRecord(node.items)) out.i = normalize(node.items, depth + 1, seen)

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
  if (!Array.isArray(types) || types.length === 0) return 'any'
  return types.join('|')
}

function showEncoded(value) {
  return value === undefined ? 'unset' : value
}

function joinPath(prefix, key) {
  return prefix === '' ? key : `${prefix}.${key}`
}

function compareNode(before, after, tool, path, issues) {
  if (!isRecord(before) || !isRecord(after)) return

  const beforeTypes = before.ts ?? []
  const afterTypes = after.ts ?? []
  const lostTypes = beforeTypes.filter(type => !afterTypes.includes(type))
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

  // const is a one-value enum.
  if (before.c !== after.c) {
    if (after.c === undefined) {
      issues.push(issue('info', 'param.const.removed', tool, path, `${path} is no longer fixed to one value`))
    } else if (before.c === undefined) {
      issues.push(issue('breaking', 'param.const.added', tool, path, `${path} is now fixed to ${after.c}`))
    } else {
      issues.push(issue('breaking', 'param.const.changed', tool, path, `${path} changed from ${before.c} to ${after.c}`))
    }
  }

  const beforeEnum = before.e
  const afterEnum = after.e
  if (beforeEnum || afterEnum) {
    if (!beforeEnum && afterEnum) {
      issues.push(issue('breaking', 'param.enum.added', tool, path, `${path} now accepts only ${afterEnum.join(', ')}`))
    } else if (beforeEnum && !afterEnum) {
      issues.push(issue('info', 'param.enum.removed', tool, path, `${path} no longer restricts its values`))
    } else {
      const lostValues = beforeEnum.filter(value => !afterEnum.includes(value))
      const gainedValues = afterEnum.filter(value => !beforeEnum.includes(value))
      if (lostValues.length > 0) {
        issues.push(issue(
          'breaking',
          'param.enum.narrowed',
          tool,
          path,
          `${path} no longer accepts ${lostValues.join(', ')}`,
        ))
      }
      if (gainedValues.length > 0) {
        issues.push(issue(
          'info',
          'param.enum.widened',
          tool,
          path,
          `${path} now also accepts ${gainedValues.join(', ')}`,
        ))
      }
    }
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
      `${path} constraint${changedConstraints.length === 1 ? '' : 's'} changed: ${changedConstraints.join(', ')}`,
    ))
  }

  if (before.o !== after.o && (before.o || after.o)) {
    issues.push(issue('warning', 'param.schema.changed', tool, path, `${path} composed schema changed`))
  }

  const beforeRequired = before.r ?? []
  const afterRequired = after.r ?? []
  for (const name of afterRequired) {
    if (!beforeRequired.includes(name)) {
      issues.push(issue(
        'breaking',
        'param.required.added',
        tool,
        joinPath(path, name),
        `${joinPath(path, name)} is now required`,
      ))
    }
  }
  for (const name of beforeRequired) {
    if (!afterRequired.includes(name)) {
      issues.push(issue(
        'info',
        'param.required.removed',
        tool,
        joinPath(path, name),
        `${joinPath(path, name)} is no longer required`,
      ))
    }
  }

  const beforeProps = before.p ?? {}
  const afterProps = after.p ?? {}
  for (const name of Object.keys(beforeProps)) {
    if (Object.hasOwn(afterProps, name)) continue
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
    issues.push(issue(
      'info',
      'param.added',
      tool,
      joinPath(path, name),
      `${joinPath(path, name)} is new and optional`,
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
    .map(item => `${item.kind}:${item.tool}:${item.path}`)
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
