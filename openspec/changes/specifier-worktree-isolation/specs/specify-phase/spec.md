## ADDED Requirements

### Requirement: Specify phase isolates branch work in a temporary worktree

The phase SHALL create a temporary worktree for the deterministic ticket branch
before reading any prior draft, opening the specifier agent session, writing
spec files, committing, or running OpenSpec validation. If the ticket branch
does not yet exist, the phase SHALL create it from the configured base branch
and create the worktree checked out to that new branch. If the ticket branch
already exists, the phase SHALL create the worktree checked out to that
existing branch. The agent working directory, prior-draft reads, spec file
writes, git commit, and OpenSpec validation SHALL all use the worktree path
rather than the main repo checkout. On every terminal outcome (`refined` or
`needs_input`) the phase SHALL remove the worktree so later phases can create a
fresh worktree for the same branch.

#### Scenario: First run creates a ticket branch from the base branch in a worktree
- **WHEN** the phase runs against a repo where the ticket branch does not yet exist
- **THEN** it creates the branch from the configured base branch before any spec files are written
- **AND** it creates a worktree checked out to that branch

#### Scenario: Revision run reuses the existing branch in a worktree
- **GIVEN** a prior specify run already created and pushed the ticket branch
- **WHEN** the phase runs again for the same ticket
- **THEN** it creates a fresh worktree checked out to that branch
- **AND** it reads the prior draft and writes the revised files inside that worktree

#### Scenario: Validation and agent execution are worktree-scoped
- **WHEN** the phase opens the specifier agent session and validates the generated change
- **THEN** the agent working directory is the worktree path
- **AND** `openspecCli.validate(changeName, { strict: true })` runs with the worktree as cwd

#### Scenario: Terminal completion removes the worktree
- **WHEN** the phase returns either `refined` or `needs_input`
- **THEN** it removes the temporary worktree before returning
- **AND** the ticket branch remains available for GitHub push / PR operations and later implement worktree creation