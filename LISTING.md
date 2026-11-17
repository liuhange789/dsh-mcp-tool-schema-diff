# dsh-mcp-tool-schema-diff — plugin center listing draft

## Entry

```yaml
url: https://github.com/liuhange789/dsh-mcp-tool-schema-diff
name: DSH MCP Tool Schema Diff
category: tools
description:
  en: "Breaking-change watchdog for MCP tool contracts. Remembers the last three tool generations per MCP server from the live tools/change registry and diffs them: removed tools, dropped parameters, accepted-type changes, new required fields and narrowed enums are graded breaking; default and constraint changes are warnings; additions are info. A quiet-window debounce absorbs mcp-client re-sync churn, so first connections and reconnects never false-alarm. Reports through a transcript notice plus `/mcp-diff`, caches snapshots under `$DSH_HOME/mcp-schema-cache` (last 3 versions), reads the registry only and writes no other state."
  zh: "MCP 工具契约的破坏性变更预警。从运行中的 tools/change 注册表里，为每个 MCP server 记住最近三代工具定义并做结构化 diff：工具删除、参数删除、可接受类型收窄、新增必填、枚举收窄记为 breaking；默认值与约束变化记为 warning；新增工具/可选参数记为 info。静默窗口防抖吸收 mcp-client 的重新同步抖动，首次连接和重连都不会误报。通过会话通知加 `/mcp-diff` 输出，快照存 `$DSH_HOME/mcp-schema-cache`（每个 server 保留 3 个版本），只读注册表，不写其他状态。"
```

## Tagline candidates

- EN: **Your MCP server upgraded and the workflow broke? This names the tool contract that changed.**
- ZH: **MCP server 升级后工作流断了？它直接告诉你是哪个工具的契约变了。**

## Why it is not another permission audit

`dsh-agent-permission-audit` compares a declared capability set against what was actually called inside one session. This compares one server generation against the next: tool presence, parameter shape, types, required lists, enums. One asks "is this agent doing more than it was allowed?"; the other asks "will yesterday's call still validate against today's schema?"

## What a user sees

On a breaking upgrade:

```text
MCP tool schema changed for "github": 6 breaking changes. parameters.options.sort no longer accepts "comments" (+5 more breaking). Run /mcp-diff for the full diff.
```

`/mcp-diff` keeps the last detected diff, even after it has been stored:

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
```

## Commands

- `/mcp-diff` — force a fresh check and print the card
- `/mcp-diff reset` — clear every server's cached versions
- `/mcp-diff reset <server>` — clear one server

## Submission checklist

- [x] `npm test` — 17/17 against rc.7 (real cordis runtime, hostile-input and false-positive cases included)
- [x] GitHub repo — <https://github.com/liuhange789/dsh-mcp-tool-schema-diff>, public, topics `dsh-plugin, dsh, deepseek-harness, mcp, schema, breaking-change`, `dsh.bundle` declared, `cordis.patch.yml` shipped
- [x] `npm publish` — `dsh-mcp-tool-schema-diff@0.1.1` public; registry readback: `https://registry.npmjs.org/dsh-mcp-tool-schema-diff/-/dsh-mcp-tool-schema-diff-0.1.1.tgz`
- [x] plugin-center PR — <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16237>, one file `data/plugins/liuhange789__dsh-mcp-tool-schema-diff.yml`
- [ ] Submission gate — local `check-submission` passes everything except repository age: 0.0 days old (needs 1). Expected for a same-day repo; CI re-runs by itself, so there is nothing to resubmit
