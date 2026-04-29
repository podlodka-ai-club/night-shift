# Task 10 — Add donor-compatible configuration loading

## Motivation

This task adds a proper configuration layer so the orchestrator can be configured with a TypeScript config file in the same general style as the donor branch, instead of relying only on CLI arguments and environment variables. The goal is compatibility at the configuration surface: config-file discovery, explicit config-path selection, adjacent `.env` loading, typed config exports, and shared resolved-config consumption across entrypoints.

## References

- Current branch
  - `orchestrator/src/client.ts`
  - `orchestrator/src/worker.ts`
  - `e2e/src/config.ts`
  - `orchestrator/README.md`
- Architecture donor branch (`remotes/origin/milestone-1-deterministic-phases`)
  - `package.json`
  - `night-shift.config.example.ts`
  - `src/config/loader.ts`

## Execution Baseline

- Implementation base snapshot: current branch `96609d330f47ad9588a8c925b6e29caf0708cb09` (`96609d3`)
- Architecture donor snapshot: `214e90f8d9de7833975f764017557ea1741c9c2e` (`214e90f`)
- Tasks 1 through 9 are already complete; this task is a compatibility/usability follow-up, not a prerequisite for the phased workflow itself.
- This task should preserve the current branch's runtime behavior and workflow semantics. It is about configuration ergonomics and compatibility, not workflow redesign.

## Prerequisites

- Task 9 complete and green.
- Existing CLI/env-driven worker, intake, and E2E entrypoints remain operational before the config layer is introduced.

## Target Code State

- A shared config loader exists for orchestrator entrypoints and supports donor-style TypeScript config loading semantics.
- Config discovery/precedence is explicit and documented, with support for:
  - explicit `--config <path>`
  - config-path environment override
  - automatic discovery of known config filenames under the working directory
- The loader auto-loads an adjacent `.env` file before importing the config file, matching the donor branch experience.
- A typed config export/helper exists so repo-local config files can be authored in TypeScript with editor/type support.
- Worker, client/manual intake, and E2E use the same resolved-config layer instead of each reading ad hoc environment variables directly.
- Existing CLI/environment-variable inputs remain supported as compatibility fallbacks and are normalized through the resolved config model.
- Donor compatibility is defined at the config surface only; this task must not force a full transplant of donor-only domain/schema concepts that do not map cleanly onto the current orchestrator.

## Acceptance Criteria (AC)

1. A config loader resolves configuration using documented precedence: explicit `--config` path first, then env override, then discovered config files.
2. Discovered config filenames include the project's canonical config name and at least one donor-compatible filename pattern so repo-local adoption/migration is practical.
3. The config loader supports TypeScript config exports, adjacent `.env` loading, relative-path resolution where applicable, and typed validation/defaulting.
4. `orchestrator/src/worker.ts` and `orchestrator/src/client.ts` can run from resolved config without requiring the current positional project-owner/project-number CLI contract.
5. Existing environment-variable and CLI flows continue to work, with documented precedence when both config and env/CLI overrides are present.
6. If `e2e` remains in scope for this task, its config parsing is either migrated to the same resolved-config layer or explicitly documented as a deliberate temporary exception.
7. Tests cover discovery precedence, donor-compatible filename support, `.env` loading, validation failures, and backward-compatibility behavior.

## Definition of Done (DoD)

- Targeted unit tests cover config discovery, precedence, validation/defaulting, and compatibility fallbacks.
- Entry-point tests prove worker/client behavior works with config-file-driven setup, not only direct env/CLI setup.
- `make check` passes from the repository root.
- Documentation includes a sample TypeScript config file and explains the supported precedence/override rules.
- At least one fake-agent verification path exercises the config-file-driven entrypoint flow end to end; if the live E2E harness remains the documented `e2e/src/config.ts` exception for this task, record that deferral explicitly and keep local entrypoint/config tests green alongside the existing live fake-agent proof.

## Risks and Mitigations

- Risk: compatibility work accidentally becomes a schema transplant from the donor branch.
  - Mitigation: keep the task scoped to config-loading ergonomics and resolved-config plumbing, not donor-only feature/model adoption.
- Risk: precedence between config files, env vars, and CLI overrides becomes confusing or unstable.
  - Mitigation: define one precedence order up front, encode it in tests, and document it in the README/example config.
- Risk: config-file support breaks current automation environments that still rely on env-only setup.
  - Mitigation: preserve env/CLI fallback behavior and add regression tests for legacy invocation paths.
- Risk: `.env` loading or dynamic config import behaves differently across entrypoints/test environments.
  - Mitigation: centralize loading logic in one module and test explicit path, discovered path, and no-config cases separately.