# Feature Factory CLI Reference

## `npm start` / `tsx src/index.ts`

Starts the orchestrator worker. Picks up the next `Ready` GitHub Project item,
runs the full pipeline (specify → implement → validate → PR → review), and exits.

### Flags

#### `--summary-format {pretty,json,none}`

Controls the format of the run summary printed to stdout when a run reaches a
terminal state (`completed` or `blocked`).

| Value    | Description |
|----------|-------------|
| `pretty` | Human-friendly ANSI-coloured table (default on interactive TTY). |
| `json`   | Stable JSON object for machine parsing — CI, tooling, log capture. |
| `none`   | Suppress the summary entirely. |

**Example usage:**

```bash
# Force JSON output regardless of TTY
npm start -- --summary-format json

# Force pretty output even in CI
npm start -- --summary-format pretty

# Suppress summary
npm start -- --summary-format none
```

### Format precedence rules

The effective format is resolved in the following order (highest priority first):

1. **`--summary-format` CLI flag** — overrides everything.
2. **`output.runSummary.format` config key** (loaded from `SUMMARY_FORMAT` env var).
3. **`CI=true` or `CI=1` environment variable** → defaults to `json`.
4. **Stdout is a TTY** → defaults to `pretty`.
5. **Fallback** → `json` (safe default for non-interactive / piped use).

### Environment variable shortcut

```bash
# Equivalent to --summary-format json
SUMMARY_FORMAT=json npm start
```

### Config file key

Add to your environment (`.env`) to set a persistent default:

```
SUMMARY_FORMAT=pretty   # pretty | json | none
```

---

## Run Summary output

### Pretty format

```
+---------------------------------------------------------------------------------+
| Ticket               | Stages                   | Duration | Cost (used/budget) |
+---------------------------------------------------------------------------------+
| FFH-123: Add widget  | validate → build → deploy| 00:07:13 | $12.40 / $20.00    |
| Status: completed                                                               |
+---------------------------------------------------------------------------------+
```

- **Ticket** — truncated to available column width.
- **Stages** — arrow-separated ordered list; trimmed with `…` when too long for the terminal.
- **Duration** — wall-clock time in `HH:MM:SS`.
- **Cost (used/budget)** — `$used / $budget`; budget omitted when not configured; cost highlighted red when over budget.
- **Status row** — coloured green (`completed`), red (`blocked`), or yellow (other).

### JSON format

```json
{
  "ticket_title": "FFH-123: Add widget",
  "stages_completed": ["validate", "build", "deploy"],
  "elapsed_seconds": 433,
  "cost_used": 12.4,
  "budget": 20.0,
  "status": "completed"
}
```

`budget` is omitted from the object when no budget is configured.

---

## Single-emission guarantee

The summary is printed **exactly once** per run regardless of the code path that
reaches the terminal state. An internal `summaryEmitted` guard on the `Worker`
prevents duplicate output even in error/cleanup edge cases.

The summary is written directly to `process.stdout` (not through the standard
log path) to avoid duplication in environments that capture both streams.
