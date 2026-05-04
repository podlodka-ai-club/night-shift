# Project extension model design

## Goal

Split orchestrator bootstrap config from project-specific behavior so one worker can monitor many targets while each repository can customize prompts and quality gates from within the cloned repo.

## Current problem

Today `orchestrator.config.ts` mixes:
- worker/runtime settings
- one GitHub Project target
- branch naming defaults
- behavior defaults that really belong to the repo being automated

That makes multi-target monitoring awkward and leaves no clean place for repo-owned customization.

## Design summary

Adopt a two-layer model:
1. global orchestrator config defines runtime settings and monitored `targets[]`
2. each cloned repo may provide `.orchestrator/project.extension.ts` to customize phase prompts and quality gates

The repo-local file is an explicit extension, not passive config.

## Global orchestrator config

Keep global runtime sections such as:
- `temporal`
- `intake`
- `pickup`
- `git.branchPrefix`
- `targets[]`

Each target should contain:
- `id`: stable logical name
- `project.owner` / `project.number`: GitHub Project coordinates to monitor
- `repo.owner` / `repo.name`: expected repository for issues selected from that target

Why keep both board and repo in the target:
- the worker needs board coordinates before any clone exists
- the orchestrator needs a stable target identity for logs and validation
- explicit repo binding lets the worker fail fast when a board item points at the wrong repo

## Target resolution and runtime threading

`entrypoint-config.ts` should resolve a concrete target before pickup/manual intake starts.

Resolution precedence should be:
1. explicit CLI/env project coordinates, matched back to one configured target
2. a single configured target when there is no ambiguity
3. otherwise, fail with a clear target-selection error

After resolution, the runtime should carry target identity plus the expected repo binding through intake/workflow execution so repo-mismatch validation and logging stay target-scoped. This can be represented by `targetId` plus resolved project/repo fields, or by an equivalent resolved-target structure, but the identity must remain explicit beyond initial config parsing.

## Repo-local project extension

Path:
- `.orchestrator/project.extension.ts`

Authoring shape:
- `export default defineProjectExtension((project) => { ... })`

The extension is trusted executable project customization loaded from the cloned repo. It applies only to the current target run and must not mutate orchestrator-global state.

The trust model should be documented explicitly: monitored repos are trusted to provide extension code and shell quality gates with the same authority the orchestrator already uses to clone, edit, and validate those repos.

## V1 extension API

Support only two capabilities in v1.

### Prompt customization

`project.prompt(phase)` where `phase` is `specify`, `implement`, or `review`.

Supported methods:
- `.prepend(text)`
- `.append(text)`

This lets repos inject conventions such as package-manager guidance, testing expectations, or architecture reminders without changing workflow control flow.

Prompt contributions affect only the phase user-prompt body. They should be rendered in a dedicated project-extension guidance section immediately before the final response-contract section. System prompts, safety preambles, and other orchestrator-owned hardening text remain immutable.

### Quality gates

`project.qualityGate(id, options)` where options include:
- `run: string`

Quality gates run from the repo worktree via `zsh -c <run>`.
They execute in registration order and stop on the first failure.

V1 keeps this contract intentionally narrow. Per-gate `cwd` and timeout customization can be added later if a concrete repo needs them.

## Execution model

For each target run:
1. load global orchestrator config
2. resolve one concrete target from `targets[]`
3. select an issue from that target's GitHub Project
4. validate that the selected issue repo matches the target's configured repo binding
5. create/open the repo worktree for the validated issue
6. look for `.orchestrator/project.extension.ts`
7. if present, load it and run registration once
8. compile the registered prompt contributions and quality gates into a plain manifest
9. cache that manifest for the current target run and use it during phase execution without reloading the extension per phase

Prompt contributions modify `buildSpecifyPrompt(...)`, `buildImplementPrompt(...)`, and `buildReviewPrompt(...)` inputs/output assembly.

Quality gates run during implement after repository files are written. If the manifest registers zero quality gates, the current autodetected `make check` / `npm run check` behavior remains as a fallback. Once a repo registers one or more explicit gates, only those explicit gates determine pass/fail for that run, executed sequentially in registration order.

## Failure handling

- missing extension file: proceed normally with no extension behavior
- invalid extension module or invalid registration: fail only that target run, keep the worker alive, and surface a clear extension-load error on the issue/workflow
- target repo mismatch: fail that run explicitly rather than silently following the board item repo
- quality gate failure: normal implement-phase failure, not an extension-load failure

Extension-load failures are target-scoped workflow/runtime failures, not worker-startup config failures. Invalid repo-local extension code must not take down unrelated targets monitored by the same worker process.

## Constraints and non-goals

V1 intentionally does not include:
- lifecycle hooks such as `beforeImplement` or `afterImplement`
- comment or PR template customization
- policy toggles like `requireTests` or `allowDependencyChanges`
- directory scanning for multiple extension files
- async extension APIs or long-lived runtime extension objects
- per-gate `cwd` or timeout customization

The extension runtime is registration-only in v1. Hook-style live callbacks can be added later once real usage justifies them.

## Testing and migration expectations

Implementation should cover:
- multi-target config parsing and entrypoint resolution
- extension loading success/failure cases
- prompt-contribution propagation into specify/implement/review prompts
- extension-defined quality gates executed via `zsh -c`
- fallback to autodetected quality gates when no extension gates are registered

Migration should:
- replace the current single `github` config block with `targets[]`
- move branch naming to a separate global setting such as `git.branchPrefix`
- document the new `.orchestrator/project.extension.ts` contract in the README

## Expected outcome

After this change:
- one orchestrator process can monitor many targets cleanly
- repo-specific behavior lives with the repo that owns it
- prompt/gate customization is available without opening workflow-control hooks yet
- the codebase has a clean path to future hook-based extensions without overdesigning v1
