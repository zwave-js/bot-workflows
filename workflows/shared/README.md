# Shared workflow components

Importable fragments for the agentic workflows in `workflows/`. Import them with
absolute pinned refs (relative imports are vendored once by `gh aw add` and never
refresh):

```yaml
imports:
  - zwave-js/bot-workflows/workflows/shared/<name>.md@main
```

Components never carry `on:` or the pre-activation `on.steps:` block - triggers
stay in the top-level workflow the consumer installs.

## hardening.md

Common engine/safety baseline. Frontmatter keys: `engine` (`id: copilot`) and
`tools` (`github: false`). Per-workflow hardening that differs - `engine.max-turns`,
`network`, `timeout-minutes`, `permissions`, threat-detection gating on safe-output
jobs - stays in each workflow file.

Import spec: `zwave-js/bot-workflows/workflows/shared/hardening.md@main`

## docs-answer-judge.md

The docs-answer judge: prompt body plus the `post-docs-answer` safe-output job
(`safe-outputs.jobs.post-docs-answer`, `safe-outputs.timeout-minutes: 10`). The job
posts the final comment via `postDocsAnswer` from the shared bot-scripts and expects
the `docs-answer-handoff` artifact uploaded by the workflow's pre-activation steps.
Frontmatter keys: `safe-outputs`.

Import spec: `zwave-js/bot-workflows/workflows/shared/docs-answer-judge.md@main`

## zwave-log-analysis.md

Z-Wave logfile analysis instructions plus the `zwave-log-analyzer` MCP server
definition. Expects the logfile at `/tmp/gh-aw/agent/logfile.log` (mounted read-only
into the MCP container). Frontmatter keys: `mcp-servers`.

Import spec: `zwave-js/bot-workflows/workflows/shared/zwave-log-analysis.md@main`
