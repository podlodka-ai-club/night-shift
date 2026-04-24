## 1. Project bootstrap

- [x] 1.1 Initialize `package.json` with `name: "night-shift"`, `type: "module"`, `private: true`, Node 20+ engine
- [x] 1.2 Add TypeScript 5.x, `@types/node`, `zod`, `vitest` as dev/runtime deps; install
- [x] 1.3 Add `tsconfig.json` (strict, ES2022, module NodeNext, `src/**` root, no emit for now)
- [x] 1.4 Add `vitest.config.ts` pointing at `src/**/*.test.ts`
- [x] 1.5 Add `.gitignore` (node_modules, dist, .env, .night-shift/)
- [x] 1.6 Add npm scripts: `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch`

## 2. Contracts module scaffold

- [x] 2.1 Create `src/contracts/index.ts` as public barrel
- [x] 2.2 Create subfiles: `ticket.ts`, `status.ts`, `specify.ts`, `implement.ts`, `review.ts`, `events.ts`, `helpers.ts`
- [x] 2.3 Add a lint/grep check (CI-style script) that fails if `src/contracts/**` imports anything outside `zod` or `src/contracts/**`

## 3. Ticket model

- [x] 3.1 Define `GitHubSourceRefSchema` (`projectNodeId`, `projectItemId`, `repoOwner`, `repoName`, `issueNumber`)
- [x] 3.2 Define `TicketSchema` with discriminated union on `source` (M1: only `"github"`)
- [x] 3.3 Export `type Ticket = z.infer<typeof TicketSchema>`
- [x] 3.4 Tests: round-trip JSON, reject missing required fields, reject unknown source

## 4. TicketStatus and transitions

- [x] 4.1 Define `TicketStatusSchema` (closed enum of the 7 status values)
- [x] 4.2 Export `TICKET_STATUS_TRANSITIONS` as a `readonly` array of `[from, to]` tuples covering the forward path and the two escalation edges
- [x] 4.3 Implement `canTransition(from, to): boolean`
- [x] 4.4 Tests: all happy-path edges, both escalation edges, a sample of rejected pairs, exhaustive match fails for invalid status literal

## 5. Branch naming helper

- [x] 5.1 Implement `slugify(title): string` per spec rules (lowercase, `[^a-z0-9]+` → `-`, trim `-`, truncate to 50)
- [x] 5.2 Implement `branchNameFor(ticket): string` composing `night-shift/<id>-<slug>`
- [x] 5.3 Tests: simple title, special chars/whitespace, 200-char title truncation, determinism (two calls equal), empty title edge case (decide: reject or produce `night-shift/<id>-`), document choice in code comment

## 6. Specify contract

- [x] 6.1 Define `SpecifyInputSchema = z.object({ ticket: TicketSchema })`
- [x] 6.2 Define `SpecBundleSchema` with all required fields from spec
- [x] 6.3 Implement `validateSpecBundle(ticket, bundle)` that returns `{ ok: true } | { ok: false, error: string }` and verifies `bundle.branch === branchNameFor(ticket)`
- [x] 6.4 Tests: valid bundle, empty arrays allowed, branch mismatch detected

## 7. Implement contract

- [x] 7.1 Define `QualityGateResultSchema` with `logsTail` max length 4096
- [x] 7.2 Define `PRRefSchema` and `ImplementationResultSchema`
- [x] 7.3 Define `ImplementInputSchema`
- [x] 7.4 Tests: valid result parses, oversized `logsTail` rejected, empty `qualityGates` allowed

## 8. Review contract and verdict helper

- [x] 8.1 Define `FindingSchema` with `severity: "error" | "warning"` (no `info`)
- [x] 8.2 Define `ReviewInputSchema` and `ReviewResultSchema`
- [x] 8.3 Implement pure `decideVerdict(findings, iteration): Verdict` per rules
- [x] 8.4 Tests: all 5 scenarios from spec (no errors ⇒ ready; errors iter 0/1 ⇒ needs-fix; errors iter 2 ⇒ escalate; severity "info" rejected)

## 9. Observability events

- [x] 9.1 Define common-fields schema (`ticketId`, `phase`, `profileId`, `ts` ISO-8601 string, `runId`)
- [x] 9.2 Define the 5 variants (`PhaseStarted`, `PhaseCompleted`, `PhaseFailed`, `AgentInvoked`, `QualityGateEvaluated`) as a discriminated union on `kind`
- [x] 9.3 Enforce `cost` as non-negative integer (micro-USD); export `usdToMicro(x)` and `microToUsd(x)` helpers
- [x] 9.4 Define `EventSink` interface with `emit(event): void | Promise<void>`
- [x] 9.5 Tests: each variant parses; missing `profileId` rejected; `Date` in `ts` rejected; float `cost` rejected; EventSink test double records emits

## 10. JSON-safety guardrail

- [x] 10.1 Write a test that takes one fixture per contract type, runs `JSON.parse(JSON.stringify(x))`, then `.parse()`s it, and asserts structural equality

## 11. Documentation

- [x] 11.1 Add `src/contracts/README.md` listing the exported types, helpers, and a "what NOT to import here" note
- [x] 11.2 Update root `README.md` with a short section describing `src/contracts/` and linking to the spec

## 12. Validation

- [x] 12.1 Run `npm run typecheck` — passes
- [x] 12.2 Run `npm run test` — all contract tests pass
- [x] 12.3 Run `openspec validate phase-contracts --strict` — passes
