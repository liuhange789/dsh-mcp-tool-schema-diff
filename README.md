# dsh-mcp-tool-schema-diff

**Your MCP server upgraded and the workflow broke? This tells you which tool's contract changed, at the moment it changed.**

Third-party MCP servers move. A tool gets renamed, a parameter is dropped, `limit` goes from number to string, an optional field becomes required. Nothing announces it. Yesterday's working call returns a validation error today, and the first thing you do is re-read a tool description you had already memorised.

This plugin keeps the last three tool generations per MCP server and diffs the live registry against them. When a breaking change lands, it tells you before you hit the error — with the server, the tool, the parameter path, and what changed.

This is not a permission audit. `dsh-agent-permission-audit` compares declared capability against actual usage inside one session. This compares one server version against the next. Different axis, different failure.

| | Answers | Needs from you |
| --- | --- | --- |
| `dsh-agent-permission-audit` | Can this agent do more than it was allowed to? | one session |
| `dsh-plugin-profiler` | What is my installed plugin set costing me? | one session |
| this plugin | What in an MCP server's contract changed between versions? | one upgrade |

## Install

```bash
dsh plugin add dsh-mcp-tool-schema-diff
```

The bundle declares its own patch (`cordis.patch.yml`), so that is the only install step. The first time a server's tools appear, a baseline is recorded; every later registry change is diffed against it.

## What counts as breaking

| Change | Severity | Why |
| --- | --- | --- |
| Tool removed | breaking | The call finds no tool |
| Parameter removed | breaking | Existing arguments now fail validation |
| Accepted type removed (e.g. `number` → `string`) | breaking | Existing values are rejected |
| New required parameter | breaking | Every existing call is now incomplete |
| Enum / `const` narrowed | breaking | Previously valid values are rejected |
| Optional parameter added | info | Existing calls still validate |
| Required relaxed to optional | info | Existing calls still validate |
| Enum / `const` widened | info | Nothing previously accepted is rejected |
| Description changed | info | Prose only |
| Default changed | warning | Valid, but behaviour may differ |
| Constraint changed (`pattern`, bounds, `format`) | warning | Valid values may now be rejected |
| Composed schema (`anyOf` / `oneOf` / `$ref` …) changed | warning | Compared as one opaque signature |

Nested object and array parameters are walked to depth 4 (64 properties per level), so `parameters.options.limit` is reported by its full path, not as "the schema changed somewhere".

## What a user sees

A transcript notice when a breaking change lands:

```text
MCP tool schema changed for "github": 6 breaking changes. parameters.options.sort no longer accepts "comments" (+5 more breaking). Run /mcp-diff for the full diff.
```

And `/mcp-diff` for the detail card. Real output from the synthetic upgrade used in the tests:

```text
MCP tool schema diff · 1 server connected · 6 breaking changes · no warnings
  checked 0s ago

  github · 6 breaking · 0 warning · 3 info
    breaking  parameters.options.sort no longer accepts "comments"
    breaking  parameters.query was removed
    breaking  parameters.body is now required
    breaking  parameters.repo is now required
    breaking  parameters.options.limit no longer accepts number (now string)
    breaking  tool mcp__github__list_labels was removed
    info      parameters.options.state is new and optional
    info      parameters.query is no longer required
    … 1 more

Cache C:\Users\HP\.dsh\mcp-schema-cache · last 3 versions per server
```

The card keeps the last detected diff after it is stored, so it does not go quiet the moment the warning becomes useful. A later upgrade replaces it.

## How it detects an upgrade

rc.7 has no per-server connect or upgrade event. What it exposes is `tools/change`, which fires on every register, unregister and scope change, plus `ctx.tools.schemas()` for the live registry. `@deepseek-ai/dsh-mcp-client` names its tools `mcp__<serverName>__<rawName>`, so this plugin groups the registry by server from the public name.

An MCP re-sync throws away the whole previous generation and registers the new one, which means `tools/change` fires many times with empty and partial states. Every event only resets a 200ms quiet timer; the diff runs once the registry has stopped moving. Without that window, every reconnect would look like "all tools removed".

- The first snapshot for a server is a baseline and never alarms.
- An unchanged generation is not stored again, so history is three real generations, not three identical ones.
- A fully empty registry is treated as a teardown, not as every tool being removed.

## Commands

- `/mcp-diff` — force a fresh check and print the detail card (never wakes an agent)
- `/mcp-diff reset` — clear cached versions for every server; the next check re-baselines
- `/mcp-diff reset <server>` — clear one server, e.g. `/mcp-diff reset github`

## Storage

`$DSH_HOME/mcp-schema-cache/<server>.json`, falling back to `~/.dsh/mcp-schema-cache/<server>.json`. One file per server, last three snapshots, written through a temporary file so a killed process cannot leave a half-written cache that looks like a schema change. Files are capped at 256 KB and 512 tools per server; oversized snapshots are skipped rather than truncated.

The brief suggested `~/.dsh/profiles/web/`. That path is not reachable from inside a plugin: rc.7 exposes no `DSH_PROFILE`, and hard-coding `web` would silently disable the plugin under `tui` or `headless`. The cache is therefore per DSH home, shared across profiles.

## What this cannot know

Read this before installing:

- **No banner service.** rc.7 exposes no `ctx.ui` and no `injectBanner`. The "banner" is implemented as the two surfaces that do exist: a one-line `logger.warn` and a `plugin`-sourced `notice` message in the live agent's transcript. Details stay in `/mcp-diff`, which is the collapsible view.
- **No per-server upgrade event.** Detection is registry-based. If a server replaces its tool set so fast that the registry never settles, the diff waits for the quiet window; nothing is reported mid-sync.
- **Server removal is not alarmed.** A server that disappears from the registry while others remain only shows as "cached, server not connected". Profiles, config edits and reconnects can all cause that transiently, and paging on it would be noise. Tool removal inside a connected server is still breaking.
- **Raw tool names are unrecoverable.** `mcp-client` may append `_<12hex>` after lossy normalization or truncation. Reports use the public name callers actually invoke, and never guess the original.
- **Grouping assumes the documented server-name pattern.** `mcp__` is split at the first `__`. A server name containing `__` would group wrongly; the documented config pattern is `[A-Za-z0-9_-]{1,32}`, which cannot.
- **Depth and size bounds are deliberate.** Parameters nested deeper than four levels, or beyond 64 properties per level, are compared at the level where the bound stops, not ignored silently.
- **A read-only home costs persistence, not detection.** The last three generations then live in memory for the rest of the session.

## Robustness

Written so it can never be the reason your host breaks:

- Every listener body, timer callback and agent notice is contained; a failure is logged, never thrown into the host.
- The plugin never mutates another plugin or a tool definition; it reads `ctx.tools.schemas()` only.
- A missing `tools`, `commands` or `agents` service costs the corresponding surface only.
- A `/mcp-diff` name already taken (a second copy, or a stale registration) costs the command only; the watcher keeps checking.
- Circular parameters, non-object schemas, hostile getters and hand-edited cache files degrade one entry, not the report.
- Cache writes are atomic and bounded; a full disk or a read-only home does not break the session.

## Limitations

- The baseline is written the first time the plugin sees a server. Installing this plugin after an already-broken upgrade gives you a clean baseline, not a historical diff.
- Descriptions are compared by hash, so a prose edit with identical meaning still reports as `info`.
- `warning` on a constraint change is a judgement call: a tighter `pattern` can be breaking in practice, but the schema does not say which direction it moved.
- The notice wakes the root agent's turn once per unique breaking diff. Repeated identical diffs are suppressed in-process.

## Compatibility

DeepSeek Harness `0.1.0-rc.7` (`@deepseek-ai/cordis` 4.x event bus). Node `^22.19.0 || >=24.0.0`. No runtime dependencies beyond Node built-ins. `/mcp-diff` requires the `commands` service.

## Tests

```bash
npm test
```

Eleven tests run against a real cordis runtime: first-connection silence, five breaking shapes in one upgrade, re-sync churn with empty and partial generations, three-version trimming, teardown silence, malformed/circular/hostile schemas, missing commands and tools services, a duplicate command name, a read-only cache with in-memory fallback, reset plus re-baseline, and `mcp__` name parsing. Point `CORDIS_PATH` at a cordis `lib/index.js` if your checkout is not at the test's default vendored path.

## License

MIT
