## 1. Adapter registry and config contract

- [x] 1.1 Add `AgentAdapterFactory` types and registry helpers so built-in and custom adapters resolve through one path
- [x] 1.2 Extend the Night Shift config types/loader to accept `adapterFactories`, allow custom adapter config slices, auto-load adjacent `.env` files before config import, and reject reserved-id collisions
- [x] 1.3 Export `defineNightShiftConfig(...)` from the config surface for typed TypeScript config authoring
- [x] 1.4 Add tests for defaults, adjacent `.env` loading, process-env precedence, custom adapter registration, reserved built-in ids, and unknown provider validation

## 2. Repo-local CLI experience

- [x] 2.1 Expose a real `night-shift` package binary and document the private Git dependency installation model for target repositories
- [x] 2.2 Add `night-shift init` to scaffold `night-shift.config.ts` in the selected repo root and protect existing files unless `--force` is passed
- [x] 2.3 Standardize repo-root selection across CLI entry points so local-repo config discovery works consistently from `process.cwd()` and `--repo-root`
- [x] 2.4 Generate the init template with `defineNightShiftConfig(...)`, built-in role defaults, env-var-based secret fields, a `.env` setup comment, and a commented custom-adapter example
- [x] 2.5 Add CLI tests covering repo-local discovery, explicit repo-root overrides, `npm exec` invocation expectations, init creation, env-based template output, and no-overwrite behavior

## 3. Documentation and examples

- [x] 3.1 Update `night-shift.config.example.ts` to show the repo-local workflow, env-based secrets, and a custom adapter registration example
- [x] 3.2 Update the root README and config README to document Night Shift as a CLI installed in the target repository and explain that `.env` is auto-loaded next to `night-shift.config.ts`
- [x] 3.3 Update `src/adapters/README.md` with adapter-authoring guidance and the custom registry contract

## 4. Integration validation

- [x] 4.1 Run the targeted adapter, config, and CLI test suites for the new registry and init flows
- [x] 4.2 Run `npm run typecheck`, `npm test`, `npm run lint:boundaries`, and `openspec validate --strict --changes local-cli-custom-adapters`