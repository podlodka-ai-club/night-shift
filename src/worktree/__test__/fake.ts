import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorktreeOps } from "../index.js";

export interface FakeWorktreeOps extends WorktreeOps {
  readonly events: ReadonlyArray<{
    kind: "create" | "remove";
    args: Record<string, unknown>;
  }>;
}

/**
 * File-system backed fake: materialises a temp directory per ticket so
 * tests that expect real paths continue to work, without requiring a git
 * repository.
 */
export function createInMemoryFakeWorktreeOps(config?: {
  rootDir?: string;
}): FakeWorktreeOps {
  const root =
    config?.rootDir ?? path.join(tmpdir(), `night-shift-fake-worktrees-${process.pid}`);
  const events: Array<{
    kind: "create" | "remove";
    args: Record<string, unknown>;
  }> = [];
  return {
    get events() {
      return events;
    },
    async create({ ticketId, branch, fromRef }) {
      const p = path.join(root, ticketId);
      await mkdir(p, { recursive: true });
      events.push({
        kind: "create",
        args: { ticketId, branch, ...(fromRef !== undefined ? { fromRef } : {}) },
      });
      return { path: p, branch };
    },
    async remove(worktreePath) {
      events.push({ kind: "remove", args: { path: worktreePath } });
      await rm(worktreePath, { recursive: true, force: true });
    },
  };
}
