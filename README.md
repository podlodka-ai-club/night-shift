# Night Shift

Turn tickets into reviewable PRs with measurable quality, cost, and latency — so human engineers spend their time on the work that actually needs them.

See [`openspec/project.md`](openspec/project.md) for the project context and [`openspec/changes/`](openspec/changes/) for active changes.

## Setup

### Prerequisites

- **Node.js ≥ 22.9**
- **Temporal server** — install via [Temporal CLI](https://docs.temporal.io/cli) or run `temporal server start-dev`
- **GitHub App** — required for board integration, PR creation, and webhooks (see [GitHub App Setup](#github-app-setup) below)

### Install

```bash
git clone <repo-url> && cd night-shift
npm install
```

### Configure

Copy the example config and edit it:

```bash
cp night-shift.config.example.ts night-shift.config.ts
```

Key sections in [night-shift.config.example.ts](night-shift.config.example.ts):

| Section | Purpose |
|---|---|
| `roles` | Agent provider + model per role (specifier, implementer, reviewer) |
| `qualityGates` | Toggle typecheck / lint / test gates |
| `github` | GitHub App credentials, repo, and project board ID |
| `pickup` | Auto-pickup: `enabled`, `intervalMinutes` (divisor of 60), `maxConcurrent` |
| `temporal` | Temporal server URL, namespace, task queue |

Config is discovered in order: explicit path → `NIGHT_SHIFT_CONFIG` env var → `night-shift.config.{ts,mts,mjs,js}` in cwd.

### GitHub Setup

1. Create a **fine-grained PAT** at *Settings → Developer settings → Personal access tokens → Fine-grained tokens* with these repository permissions: **Contents**, **Issues**, **Pull requests**, **Projects** — all Read & write

2. Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
# GitHub
GITHUB_TOKEN=ghp_...
GITHUB_PROJECT_OWNER=your-username-or-org
GITHUB_PROJECT_OWNER_TYPE=user          # user | org
GITHUB_PROJECT_NUMBER=1
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-repo
```

The config reads these env vars automatically. The project's GraphQL node ID (`PVT_...`) is resolved from the project number at startup — no need to look it up manually.

`GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME` select the GitHub repository Night Shift talks to over the API. They do not select the local checkout used for spec generation, implementation, or review. Local filesystem operations default to the current working directory; pass `--repo-root <path>` to `worker`, `specify`, `implement`, or `review` when you want to target a different checkout.

> **Tip:** For production, consider using a [GitHub App](https://docs.github.com/en/apps/creating-github-apps) instead of a PAT for bot identity, higher rate limits, and auto-rotating tokens. The config supports `appId` + `installationId` + `privateKeyPath` as an alternative — see [night-shift.config.example.ts](night-shift.config.example.ts).

> **Note:** Tests use an in-memory fake client automatically — no GitHub credentials needed for `npm test`.

### Verify

```bash
npm run typecheck
npm test
npm run lint:boundaries
```

### Run

```bash
# Start the Temporal dev server (separate terminal)
temporal server start-dev
```

Main worker run:

```bash
# Run from the Night Shift repo while targeting the application checkout
# Night Shift should read, modify, and validate.
npm run worker -- --repo-root /abs/path/to/target-repo
```

This is the expected main mode. `--repo-root` selects the local checkout used by `specify`, `implement`, and `review`.

Workflow control commands:

```bash
# Run from the Night Shift repo root, or pass --config if invoking elsewhere.
# These commands do not use a local target checkout.

# Trigger a workflow for a project item
npm run start -- <projectItemId> --change <change-name>

# One-shot: scan Backlog + Ready and start workflows
npm run pickup
```

When `pickup.enabled` is `true` in your config, the worker automatically starts a cron workflow that scans the board every `intervalMinutes` — no separate command needed.

Manual phase runs:

```bash
npm run specify -- --item <projectItemId> --change <change-name> [--repo-root /abs/path/to/target-repo]
npm run implement -- --item <projectItemId> --change <change-name> [--repo-root /abs/path/to/target-repo]
npm run review -- <projectItemId> [--iteration <n>] [--repo-root /abs/path/to/target-repo]
```

`specify` and `review` open agent sessions in the selected repo root. `implement` opens its agent session in the per-ticket worktree created under that repo root.

`start` and `pickup` are different: they only talk to GitHub and Temporal, so they do not need `--repo-root` and do not care which application checkout you want to modify later. Their only cwd-sensitive behavior is config discovery.

## Modules

- [`src/contracts/`](src/contracts/) — shared phase contracts (Ticket, I/O schemas, observability events). All downstream phases depend on this.
- [`src/adapters/`](src/adapters/) — normalised agent-SDK interface + provider adapters (Codex, Claude stub, in-memory fake). See [`src/adapters/README.md`](src/adapters/README.md).
- [`src/config/`](src/config/) — `night-shift.config.*` loader and `NightShiftConfigSchema`. See [`src/config/README.md`](src/config/README.md).
- [`src/github/`](src/github/) — typed wrappers around GitHub REST/GraphQL/webhooks for Projects v2, issues, labels, comments, branches, and PRs. See [`src/github/README.md`](src/github/README.md).
- [`src/git/`](src/git/) — minimal `GitOps` surface (real `simple-git` impl + in-memory fake). See [`src/git/README.md`](src/git/README.md).
- [`src/phases/specify/`](src/phases/specify/) — Specify phase runtime that converts a ticket into an OpenSpec change folder. See [`src/phases/specify/README.md`](src/phases/specify/README.md).
- [`src/phases/implement/`](src/phases/implement/) — Implement phase runtime that drives the implementer agent, runs quality gates in a worktree, and opens a PR. See [`src/phases/implement/README.md`](src/phases/implement/README.md).
- [`src/phases/review/`](src/phases/review/) — Review phase runtime that reviews PRs, posts findings as review comments, and produces a verdict. See [`src/phases/review/README.md`](src/phases/review/README.md).
- [`src/worktree/`](src/worktree/) — `WorktreeOps` surface for creating/removing per-ticket git worktrees. See [`src/worktree/README.md`](src/worktree/README.md).
- [`src/quality-gates/`](src/quality-gates/) — `QualityGateRunner` that executes typecheck/lint/test gates with per-gate timeouts and 4 KiB log truncation. See [`src/quality-gates/README.md`](src/quality-gates/README.md).
- [`src/orchestration/`](src/orchestration/) — Durable ticket workflow engine built on Temporal (workflow, activities, worker, webhook bridge). See [`src/orchestration/README.md`](src/orchestration/README.md).
- [`src/cli/`](src/cli/) — CLI entry points (`night-shift specify …`, `night-shift implement …`, `night-shift review …`, `night-shift worker`, `night-shift start …`, `night-shift pickup`).

## Scripts

- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run Vitest suites
- `npm run lint:contracts` — guardrail: `src/contracts/**` imports only `zod` and siblings
- `npm run lint:boundaries` — guardrail: enforce import boundaries for `contracts`, `adapters`, `config`, `github`, `git`, `phases`, `worktree`, `quality-gates`, `orchestration`, and `cli` modules
- `npm run specify -- --item <projectItemId> --change <change-name> [--repo-root <path>]` — run the Specify phase against a single project item
- `npm run implement -- --item <projectItemId> --change <change-name> [--repo-root <path>]` — run the Implement phase against a single project item
- `npm run review -- <projectItemId> [--iteration <n>] [--repo-root <path>]` — run the Review phase against a single project item
- `npm run worker -- --repo-root <path>` — start the Temporal worker against a specific local checkout (also runs the pickup cron when `pickup.enabled` is `true`)
- `npm run start -- <projectItemId> --change <change-name>` — trigger a ticket workflow; run from the Night Shift repo root unless you pass `--config`, no target checkout required
- `npm run pickup` — one-shot scan of Backlog + Ready columns; run from the Night Shift repo root unless you pass `--config`, no target checkout required

## Workflow Phases

### Specify

Converts a ticket into a validated OpenSpec change folder (proposal, design, tasks).

```mermaid
flowchart TD
    Start([specifyActivity]) --> Resolve[Resolve project item + issue]
    Resolve --> StatusCheck{Status blocks entry?}
    StatusCheck -- yes --> Err[SpecifyValidationError]
    StatusCheck -- no --> Transition[Set status → Refinement]
    Transition --> Branch[Ensure branch exists + checkout]
    Branch --> ReadDraft[Read prior draft if any]
    ReadDraft --> Agent[Specifier agent call]
    Agent --> Parse[Parse structured response]
    Parse --> Commit[Write files + commit]
    Commit --> Validate{openspec validate --strict}
    Validate -- pass --> Questions{Open questions?}
    Validate -- fail, attempt < max --> Agent
    Questions -- none --> Refined["Status → Refined<br/>return refined"]
    Questions -- yes --> NeedsInput["Status → Blocked<br/>return needs_input"]
    Validate -- fail, max attempts --> NeedsInput

    Refined --> AwaitReview["⏸ Workflow blocks<br/>awaiting_spec_review"]
    AwaitReview -- "🧑 Operator approves spec<br/>Board → Ready → specReviewed signal" --> ImplPhase([→ Implement phase])
    AwaitReview -- "🧑 Operator requests changes<br/>Board → Backlog → specifyRetry signal" --> Agent

    NeedsInput --> AwaitInput["⏸ Workflow blocks<br/>specify_needs_input"]
    AwaitInput -- "🧑 Operator answers questions<br/>Board → Backlog → specifyRetry signal" --> Agent

    style AwaitReview fill:#fff3cd,stroke:#ffc107
    style AwaitInput fill:#fff3cd,stroke:#ffc107
    style ImplPhase fill:#d1ecf1,stroke:#0dcaf0
```

### Implement

Drives the implementer agent in a worktree, runs quality gates, and opens a PR.

```mermaid
flowchart TD
    Start([implementActivity]) --> Load[Load item, issue, spec bundle]
    Load --> EntryCheck{Status allows entry?}
    EntryCheck -- no --> Err[ImplementPhaseError]
    EntryCheck -- yes --> Prepare[Set status → In progress<br/>Create worktree]
    Prepare --> AgentTurn[Implementer agent call]
    AgentTurn --> WriteCommit[Write files to worktree + commit]
    WriteCommit --> Gates[Run quality gates<br/>typecheck / lint / test]
    Gates --> GateCheck{All gates pass?}
    GateCheck -- no, attempt < max --> AgentTurn
    GateCheck -- no, max attempts --> NeedsInput["Status → Blocked<br/>return needs_input"]
    GateCheck -- yes --> Push[Push branch]
    Push --> PR[Upsert pull request]
    PR --> PrOpened["Status → In review<br/>return pr_opened"]

    NeedsInput --> AwaitRetry["⏸ Workflow blocks<br/>implement_needs_input"]
    AwaitRetry -- "🧑 Operator unblocks<br/>Board → Ready → implementRetry signal" --> AgentTurn

    PrOpened --> ReviewPhase([→ Review phase])

    subgraph Worktree [Isolated worktree]
        AgentTurn
        WriteCommit
        Gates
    end

    style AwaitRetry fill:#fff3cd,stroke:#ffc107
    style ReviewPhase fill:#d1ecf1,stroke:#0dcaf0
```

### Review

Reviews a PR, posts findings as review comments, and produces a verdict.

```mermaid
flowchart TD
    Start([reviewActivity]) --> EntryCheck{Item status = In review?}
    EntryCheck -- no --> Err[ReviewValidationError]
    EntryCheck -- yes --> ReadSpec[Read spec bundle files]
    ReadSpec --> FetchPR[Fetch diff + changed files + comments]
    FetchPR --> Agent[Reviewer agent call]
    Agent --> ParseResp[Parse findings + summary]
    ParseResp --> SchemaCheck{Schema valid?}
    SchemaCheck -- no, first attempt --> Agent
    SchemaCheck -- yes --> Verdict[decideVerdict based on findings]
    Verdict --> V{Verdict?}

    V -- ready-to-merge --> Approve[APPROVE review<br/>Post line comments]
    Approve --> Merge["Status → Ready to merge<br/>return ready_to_merge"]
    Merge --> Done([✅ Workflow complete])

    V -- needs-fix --> RequestChanges[REQUEST_CHANGES review<br/>Post line comments]
    RequestChanges --> Fix["Status → Ready<br/>return needs_fix"]
    Fix --> ReImpl["Auto: re-run implement → review<br/>up to maxIterations"]

    V -- escalate --> Escalate[COMMENT review<br/>Add escalation label]
    Escalate --> Esc["return escalated"]
    Esc --> AwaitResume["⏸ Workflow blocks<br/>review_escalation"]
    AwaitResume -- "🧑 Operator resolves escalation<br/>Board → In review → resume signal" --> Start

    ReImpl -- max iterations exhausted --> AwaitResume

    style AwaitResume fill:#fff3cd,stroke:#ffc107
    style Done fill:#d4edda,stroke:#198754
```
