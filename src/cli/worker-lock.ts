import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface WorkerLockHandle {
  lockPath: string;
  release(): Promise<void>;
}

interface WorkerLockRecord {
  lockId: string;
  pid: number;
  taskQueue: string;
  repoRoot: string;
  acquiredAt: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function lockFileName(taskQueue: string): string {
  const safeQueue = taskQueue.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const digest = crypto.createHash("sha1").update(taskQueue).digest("hex").slice(0, 10);
  return `${safeQueue}-${digest}.json`;
}

async function readLockRecord(lockPath: string): Promise<WorkerLockRecord | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return JSON.parse(raw) as WorkerLockRecord;
  } catch {
    return undefined;
  }
}

export async function acquireWorkerLock(repoRoot: string, taskQueue: string): Promise<WorkerLockHandle> {
  const lockDir = path.join(repoRoot, ".night-shift", "locks");
  const lockPath = path.join(lockDir, lockFileName(taskQueue));
  const lockId = crypto.randomUUID();
  const payload: WorkerLockRecord = {
    lockId,
    pid: process.pid,
    taskQueue,
    repoRoot,
    acquiredAt: new Date().toISOString(),
  };

  await mkdir(lockDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(lockPath, "wx");
      await file.writeFile(JSON.stringify(payload, null, 2), "utf8");
      await file.close();

      return {
        lockPath,
        async release() {
          const current = await readLockRecord(lockPath);
          if (current?.lockId !== lockId) {
            return;
          }
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      const current = await readLockRecord(lockPath);
      if (current && isAlive(current.pid)) {
        throw new Error(
          `worker lock already held for task queue \"${taskQueue}\" by pid ${current.pid} (${lockPath})`,
        );
      }

      await rm(lockPath, { force: true });
    }
  }

  throw new Error(`failed to acquire worker lock for task queue \"${taskQueue}\" (${lockPath})`);
}