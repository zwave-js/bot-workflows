# bot-workflows

Single source of truth for the zwave-js organization's AI-powered CI workflows, bot
scripts, and composite actions. Consumer repos (zwave-js, zwave-js-ui) reference this
repo instead of vendoring the scripts.

## AI-assisted contributions

Read the [AI policy](AI_POLICY.md) before using AI tools to contribute. AI assistance
is welcome when you personally review, understand, and can explain every change.
Autonomous-agent contributions and unreviewed AI communication are prohibited.

## Layout

```
bot-scripts/            Node (CommonJS) scripts, installed with `npm ci --ignore-scripts`
  index.cjs             Façade: the shared surface consumed by gh-aw workflows
  config.cjs            Loads/validates the consumer's bot config (see below)
  answer/               Docs-answer bot (gating, retrieval, rendering, posting)
  logfile/              Logfile extraction, classification, and feedback comments
  indexes/              Docs/posts embedding indexes: build, load, cache keys, restore
  feedback/             Docs-answer feedback collection and tracking issue
  eval/                 Retrieval eval runners and eval tracking issue
  lib/                  Shared helpers (GitHub API, comments, logfile text, sanitizing)
actions/
  setup-bot/            Installs bot-scripts deps, restores the model cache,
                        exports BOT_SCRIPTS_DIR
  restore-bot-index/    Restores a docs/posts index from cache or artifact
  report-index-status/  Updates the index/eval tracking issue
workflows/
  answer-from-docs.md        Agentic: answer discussions from the docs index
  analyze-logfile-auto.md    Agentic: analyze new logfiles posted to discussions
  analyze-logfile-command.md Agentic: on-demand logfile analysis via bot command
  classify-issue-repo.md     Agentic: classify whether an issue belongs in the repo
  shared/                    Frontmatter/prompt components the workflows import
aw.yml                  gh-aw package manifest listing the agentic workflows
.github/workflows/
  docs-embeddings.yml   Reusable (workflow_call): build + eval the docs index
  posts-embeddings.yml  Reusable (workflow_call): build + eval the posts index
  bot-index-selfcheck.yml  Reusable (workflow_call): verify index restorability
  ci.yml, release.yml   This repo's own CI and release automation
```

## Consumer contract

- **Setup**: run `zwave-js/bot-workflows/actions/setup-bot@v1` first in any job that
  runs bot scripts. It installs the runtime dependencies and exports
  `BOT_SCRIPTS_DIR`; scripts are then invoked as
  `node "$BOT_SCRIPTS_DIR/<subdir>/<script>.cjs"` or required from
  `$BOT_SCRIPTS_DIR/index.cjs` (gh-aw workflows use the façade).
  `restore-bot-index` and `report-index-status` self-locate the scripts and do not
  need setup-bot. Leave `save-caches` at its default: only the embeddings builders
  populate the dependency and model caches, every other job restores them read-only.
- **Index producer naming**: `restore-bot-index`'s artifact fallback looks up runs of
  the workflow that publishes the index. Reusable-workflow runs are attributed to the
  caller's filename, so name your embeddings callers `docs-embeddings.yml` /
  `posts-embeddings.yml`, or pass the actual filename via the action's
  `producer-workflow` input.
- **Config**: every consumer repo provides `.github/zwave-js-bot.config.json` in its
  own checkout — `config.cjs` resolves it via `GITHUB_WORKSPACE`, which reusable
  workflows point at the caller's checkout. Start from
  [`config.example.json`](config.example.json); the schema is validated strictly at
  load time (unknown or missing keys fail the job). The `redirects` and `cache`
  groups are optional. `evalCases.*File` paths are relative to the consumer checkout.
- **Reusable workflows**: call with `uses: zwave-js/bot-workflows/.github/workflows/<name>.yml@v1`.
  They only need `github.token`; consumers own schedules, push path filters, and
  concurrency groups.

## Installing the agentic workflows

Install a workflow into a consumer repo with the [gh-aw](https://github.github.com/gh-aw/)
CLI, pinned to a release tag:

```sh
gh aw add zwave-js/bot-workflows/answer-from-docs@v1
gh aw add zwave-js/bot-workflows/analyze-logfile-auto@v1
gh aw add zwave-js/bot-workflows/analyze-logfile-command@v1
gh aw add zwave-js/bot-workflows/classify-issue-repo@v1
```

`gh aw add zwave-js/bot-workflows@v1` installs the whole package (see `aw.yml`).
Recompile with `gh aw compile` after any change and commit the `.lock.yml` files.

What stays consumer-side:

- **Triggers and pre-activation** (`on:` incl. `on.steps:`), gate `if:`, `permissions`,
  runner selection, `network`, and `timeout-minutes` live in the installed `.md` file —
  edit them there after `gh aw add`. Only the engine hardening, safe-output jobs, MCP
  servers, and prompts come from this repo's `workflows/shared/` imports.
  `gh aw update` rewrites that frontmatter into canonical form and drops any comments
  in it, so explain the consumer-side blocks here in `workflows/*.md`, where the
  comments survive and a fresh `gh aw add` carries them over. Pass
  `--no-release-bump` when syncing, or the update also rewrites the floating action
  majors below as exact releases.
- **Config file**: `.github/zwave-js-bot.config.json` (see consumer contract above).
- **Eval cases**: the files `evalCases.*File` points at.
- **Caller workflows** for the reusable embeddings/selfcheck workflows, plus the
  `BOT_TOKEN` / `COPILOT_GITHUB_TOKEN` secrets.

## Development

```sh
cd bot-scripts
npm ci --ignore-scripts
cp ../config.example.json ../.github/zwave-js-bot.config.json  # tests load it
GITHUB_WORKSPACE=$(git rev-parse --show-toplevel) npx vitest run
```

vitest is fetched by npx on purpose: keeping it out of package.json keeps the
runtime install the bot jobs pay for lean.

## Releases

Tag a SemVer release (`vX.Y.Z`); `release.yml` creates the GitHub release with
generated notes and force-moves the floating major tag (`v1`) to it. Consumers pin
the floating major. Reusable workflows internally reference sibling actions
`@v1`, so a consumer pinned to another major still runs `@v1` actions until a
release bumps those references.

The agentic workflows in `workflows/` import their shared components pinned to a
commit SHA, so consumer recompiles are byte-reproducible. When a release changes
anything under `workflows/shared/`, re-pin the import specs in `workflows/*.md` to
the SHA of the commit that last touched the shared files (a release tag cannot be
used — it does not exist yet when this repo's own CI compiles), recompile, commit,
then tag. Action refs inside the workflows stay on the floating `@v1`.
