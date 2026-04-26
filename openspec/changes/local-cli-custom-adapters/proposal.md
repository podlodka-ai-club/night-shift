## Why

Night Shift already discovers `night-shift.config.ts` and can target a repo root, but the user experience still reads like an internal tool that is driven from the Night Shift checkout and wired to a fixed adapter list. That makes adoption awkward for teams who want to install the CLI in the repository they actually automate and blocks them from plugging in their own agent SDKs without forking the project.

## What Changes

- Add a repo-local CLI interface centered on running `night-shift` from the repository being automated, with consistent config-discovery and working-directory semantics across commands.
- Add automatic `.env` loading for repo-local CLI usage so environment-backed secrets are available before `night-shift.config.ts` is imported.
- Add a `night-shift init` workflow that scaffolds `night-shift.config.ts` for the current repository, uses environment variables for secret fields by default, and documents the repo-local usage model.
- Extend the TypeScript config contract so repositories can register custom agent adapters and bind roles to them without modifying Night Shift source.
- Preserve the existing role model and built-in adapters so current Codex and Claude-based setups keep working.

## Capabilities

### New Capabilities
- `repo-local-cli`: Repo-first CLI setup and command behavior for running Night Shift directly inside the repository being automated.

### Modified Capabilities
- `agent-adapter`: Role providers resolve through a configurable adapter registry that includes built-in adapters and user-defined adapters declared in TypeScript config.

## Impact

- `src/cli/` — add repo-local initialization and align command semantics/documentation around running from the target repository.
- `src/config/` — extend the config shape beyond static provider enums, auto-load repo-local `.env` files before config import, and support adapter factories safely.
- `src/adapters/` — replace the hardcoded provider switch with a registry-based adapter resolution path.
- `night-shift.config.example.ts`, init template output, README, and tests — document env-based secrets, `.env` usage, and custom-adapter resolution.