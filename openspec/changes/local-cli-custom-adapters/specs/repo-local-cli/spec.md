## ADDED Requirements

### Requirement: Repo-local command model

The system SHALL support Night Shift as a CLI that runs from the repository being automated. When a shipped CLI command is invoked without `--repo-root`, config discovery and repo-relative behavior SHALL default to `process.cwd()`. When `--repo-root <path>` is provided, the command SHALL use that path as the selected repo root instead.

Commands that operate on a checkout (`worker`, `specify`, `implement`, `review`) SHALL use the selected repo root for git operations, OpenSpec validation, worktree creation, prompt-file resolution, and quality-gate execution. Commands that do not modify a checkout (`start`, `pickup`) SHALL still use the selected repo root for config discovery so they can be run from the same local-repo workflow.

#### Scenario: Worker runs from the target repository by default
- **WHEN** a user runs `night-shift worker` inside a repository containing `night-shift.config.ts`
- **THEN** the command loads that config and uses the same repository as the working repo for ticket execution

#### Scenario: Explicit repo root overrides the current directory
- **WHEN** a user runs `night-shift implement --item ITEM-1 --change add-login --repo-root /tmp/app` from another directory
- **THEN** the command loads config relative to `/tmp/app` and performs git, worktree, and quality-gate operations in `/tmp/app`

#### Scenario: Start uses repo-local config without a separate Night Shift checkout
- **WHEN** a user runs `night-shift start ITEM-1 --change add-login` from the repository being automated
- **THEN** the command resolves `night-shift.config.ts` from that repository and starts the workflow without requiring a dedicated Night Shift working copy

### Requirement: Private package installation model

The system SHALL expose an executable named `night-shift` as a package binary and SHALL support installing Night Shift into the target repository as a private Git dependency. The documented and supported invocation model SHALL use `npm exec` against that repo-local installation rather than requiring a global install.

Night Shift SHALL support these invocation modes:
- inside the target repository: `npm exec night-shift -- <command> ...`
- from another directory: `npm exec --prefix <repo-root> night-shift -- <command> ...`

The repo-local installation model SHALL work with the same config discovery and `.env` loading rules as direct binary invocation.

#### Scenario: Repo-local install exposes the package binary
- **WHEN** a target repository installs Night Shift from a private Git dependency
- **THEN** `npm exec night-shift -- --help` resolves the repo-local `night-shift` binary successfully

#### Scenario: Npm exec works inside the target repository
- **WHEN** a user runs `npm exec night-shift -- worker` from the target repository root
- **THEN** Night Shift loads config and `.env` from that repository and starts the worker

#### Scenario: Npm exec works from another directory
- **WHEN** a user runs `npm exec --prefix /tmp/app night-shift -- start ITEM-1 --change add-login` from another directory
- **THEN** Night Shift resolves config and `.env` from `/tmp/app` and starts the workflow for that repository

#### Scenario: Global install is not required
- **WHEN** Night Shift is installed only in the target repository and not globally on the machine
- **THEN** the supported `npm exec` invocation modes continue to work

### Requirement: Automatic `.env` loading

The system SHALL automatically load `.env` from the same directory as the resolved `night-shift.config.*` file before importing that config module. If the `.env` file does not exist, loading SHALL be a no-op. Environment variables already present in the parent process SHALL take precedence over values loaded from `.env`.

#### Scenario: Repo-local `.env` populates config lookups
- **WHEN** a repository contains both `night-shift.config.ts` and `.env`, and the config reads `process.env.GITHUB_TOKEN`
- **THEN** the value from `.env` is available during config import without requiring extra CLI flags

#### Scenario: Explicit repo root uses its own `.env`
- **WHEN** a user runs `night-shift worker --repo-root /tmp/app` and `/tmp/app/night-shift.config.ts` exists with `/tmp/app/.env`
- **THEN** Night Shift loads `/tmp/app/.env` before importing `/tmp/app/night-shift.config.ts`

#### Scenario: Existing process env is not overwritten
- **WHEN** the parent shell already sets `GITHUB_TOKEN` and the repo-local `.env` also defines `GITHUB_TOKEN`
- **THEN** Night Shift keeps the value from the parent shell

### Requirement: Init scaffolds TypeScript config

The system SHALL ship an executable `night-shift init` that writes `night-shift.config.ts` into the selected repo root. The generated config SHALL be a TypeScript module that uses `defineNightShiftConfig(...)`, includes the built-in role defaults, uses `process.env` lookups for secret-bearing settings by default, and contains comments telling the user to put those values in `.env` for local use. The template SHALL also contain a commented example showing how to register a custom adapter factory.

If `night-shift.config.ts` already exists, `night-shift init` SHALL refuse to overwrite it unless the user passes `--force`.

#### Scenario: Init creates a repo-local config file
- **WHEN** a user runs `night-shift init` in a repository without an existing config file
- **THEN** the command writes `night-shift.config.ts` in that repository and exits successfully

#### Scenario: Init protects an existing config by default
- **WHEN** a user runs `night-shift init` in a repository that already contains `night-shift.config.ts`
- **THEN** the command exits with an error and leaves the existing file unchanged

#### Scenario: Init can target another repository explicitly
- **WHEN** a user runs `night-shift init --repo-root /tmp/app --force`
- **THEN** the command writes the generated TypeScript config to `/tmp/app/night-shift.config.ts`

#### Scenario: Init template keeps secrets in env vars
- **WHEN** a user runs `night-shift init`
- **THEN** the generated config uses `process.env` for secret fields and includes a comment directing the user to set those values in `.env`