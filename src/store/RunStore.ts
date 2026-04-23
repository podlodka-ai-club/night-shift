import * as fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { RunState, RunEvent, UsageRecord, TERMINAL_STAGES } from '../types.js';

/**
 * Disk-backed store for per-ticket run state, events, and usage.
 *
 * Directory layout: <dataDir>/<ticketId>/
 *   state.json    – current RunState
 *   events.jsonl  – append-only RunEvent log
 *   usage.json    – UsageRecord array (rewritten on each append)
 *   lock          – PID of the process that owns this run
 *   openspec/     – generated OpenSpec artifacts
 */
export class RunStore {
  constructor(private readonly dataDir: string) {}

  runDir(ticketId: string): string {
    return path.join(this.dataDir, ticketId);
  }

  async create(state: RunState): Promise<void> {
    const dir = this.runDir(state.ticketId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), { flag: 'wx' });
    await fs.writeFile(path.join(dir, 'events.jsonl'), '', { flag: 'wx' });
    await fs.writeFile(path.join(dir, 'usage.json'), '[]', { flag: 'wx' });
  }

  exists(ticketId: string): boolean {
    return existsSync(path.join(this.runDir(ticketId), 'state.json'));
  }

  async load(ticketId: string): Promise<RunState> {
    const file = path.join(this.runDir(ticketId), 'state.json');
    const content = await fs.readFile(file, 'utf-8');
    return JSON.parse(content) as RunState;
  }

  async update(ticketId: string, partial: Partial<RunState>): Promise<void> {
    const current = await this.load(ticketId);
    const updated: RunState = { ...current, ...partial, updatedAt: new Date().toISOString() };
    await fs.writeFile(path.join(this.runDir(ticketId), 'state.json'), JSON.stringify(updated, null, 2));
  }

  async appendEvent(ticketId: string, event: RunEvent): Promise<void> {
    const file = path.join(this.runDir(ticketId), 'events.jsonl');
    await fs.appendFile(file, JSON.stringify(event) + '\n');
  }

  async appendUsage(ticketId: string, record: UsageRecord): Promise<void> {
    const existing = await this.loadUsage(ticketId);
    existing.push(record);
    await fs.writeFile(path.join(this.runDir(ticketId), 'usage.json'), JSON.stringify(existing, null, 2));
  }

  async loadUsage(ticketId: string): Promise<UsageRecord[]> {
    const file = path.join(this.runDir(ticketId), 'usage.json');
    if (!existsSync(file)) return [];
    const content = await fs.readFile(file, 'utf-8');
    return JSON.parse(content) as UsageRecord[];
  }

  /**
   * Reads all events from the append-only JSONL event log for a run.
   * Returns an empty array when the file does not exist.
   */
  async loadEvents(ticketId: string): Promise<RunEvent[]> {
    const file = path.join(this.runDir(ticketId), 'events.jsonl');
    if (!existsSync(file)) return [];
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
  }

  async lock(ticketId: string): Promise<void> {
    const file = path.join(this.runDir(ticketId), 'lock');
    try {
      await fs.writeFile(file, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'EEXIST') throw err;
    }

    const locked = await this.isLocked(ticketId);
    if (locked) {
      throw new Error(`Run ${ticketId} is already locked by another process`);
    }

    await fs.writeFile(file, String(process.pid), { flag: 'wx' });
  }

  async unlock(ticketId: string): Promise<void> {
    const file = path.join(this.runDir(ticketId), 'lock');
    if (existsSync(file)) await fs.unlink(file);
  }

  async isLocked(ticketId: string): Promise<boolean> {
    const file = path.join(this.runDir(ticketId), 'lock');
    if (!existsSync(file)) return false;
    const content = await fs.readFile(file, 'utf-8');
    const pid = Number(content.trim());
    if (pid === process.pid) return true;
    // Check whether the owning process is still alive.
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // Stale lock – clean it up.
      await fs.unlink(file);
      return false;
    }
  }

  /** Lists all non-terminal runs. Uses sync reads for directory scanning. */
  async listActive(): Promise<RunState[]> {
    if (!existsSync(this.dataDir)) return [];
    const entries = readdirSync(this.dataDir, { withFileTypes: true });
    const active: RunState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateFile = path.join(this.dataDir, entry.name, 'state.json');
      if (!existsSync(stateFile)) continue;
      const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as RunState;
      if (!TERMINAL_STAGES.has(state.stage)) active.push(state);
    }
    return active;
  }
}
