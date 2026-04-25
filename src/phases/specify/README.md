# `src/phases/specify/`

Runs the Specify phase of the Night-Shift workflow against a GitHub Projects v2
item. Produces an OpenSpec change folder on the ticket branch, upserts a
summary comment on the issue, and transitions the item to `Refined` (success)
or `Blocked` (needs input).

## Public surface

- `runSpecifyPhase(deps, input)` — the entry point.
- `SpecifierResponseSchema` + `SpecifierResponseJsonSchema` — contract for the
  specifier agent's final message (used both as a runtime guard and as a hint
  passed to the provider via `TurnOpts.outputSchema`).
- `SpecifyPhaseError` and subclasses (`SpecifyItemMissingError`,
  `SpecifyAgentError`, `SpecifyValidationError`) — the error taxonomy with
  stable `code` fields.
- `createOpenSpecCli()` / `createFakeOpenSpecCli()` — thin wrapper around
  `npx openspec change validate <name> --strict` plus an in-memory fake.

## Dependencies

| dep          | purpose                                                  |
| ------------ | -------------------------------------------------------- |
| `github`     | read item/issue/comments; transitions; comment upsert; branch |
| `git`        | anchor to the base branch, checkout the ticket branch, commit specifier output |
| `fs`         | load prior change-folder files for revision round-trips  |
| `agent`      | run the specifier role against the configured provider   |
| `openspecCli`| strict-validate the produced change folder               |
| `events`     | optional; emits `PhaseStarted` / `PhaseCompleted` / `PhaseFailed` |

## CLI

```
npm run specify -- --item <projectItemId> --change <change-name>
```

Exit codes: `0` refined, `2` needs_input, `1` error, `64` usage.

## Test recipe

```ts
import { runSpecifyPhase } from "./phase.js";
import { createInMemoryFakeGitHubClient } from "../../github/__test__/fake.js";
import { createInMemoryFakeGitOps } from "../../git/__test__/fake.js";
import { createFakeOpenSpecCli } from "./openspec-cli.js";
import { InMemoryFakeAdapter } from "../../adapters/__test__/fake.js";

const gh = createInMemoryFakeGitHubClient();
gh.seedIssue({ number: 1 });
gh.seedItem({ itemId: "PVTI_1", issueNumber: 1, status: "Backlog" });

const cli = createFakeOpenSpecCli();
cli.script([{ ok: true }]);

const agent = new InMemoryFakeAdapter({
  script: [{ events: [], finalText: JSON.stringify(/* SpecifierResponse */), usage: /* … */ }],
});

await runSpecifyPhase(
  { github: gh, git: createInMemoryFakeGitOps(), fs: { readPriorDraft: async () => [] },
    agent, openspecCli: cli, runId: "r", profileId: "p", model: "m" },
  { itemId: "PVTI_1", changeName: "my-change" },
);
```
