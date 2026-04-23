import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages the per-run OpenSpec artifact directory.
 *
 * Rather than calling the openspec CLI (which requires correct cwd setup
 * for every run), this service creates the canonical directory structure
 * and exposes paths so the specify stage can write AI-generated content
 * directly.
 *
 * Layout under runDir/openspec/changes/<changeId>/:
 *   proposal.md
 *   design.md
 *   tasks.md
 *   specs/main/spec.md
 */
export class OpenSpecService {
  readonly changeDir: string;

  constructor(runDir: string, changeId: string) {
    this.changeDir = path.join(runDir, 'openspec', 'changes', changeId);
  }

  /** Creates the directory scaffold. Call once when the run is claimed. */
  scaffold(): void {
    fs.mkdirSync(path.join(this.changeDir, 'specs', 'main'), { recursive: true });
  }

  /** Writes an artifact file. path is relative to changeDir. */
  write(relativePath: string, content: string): void {
    const abs = path.join(this.changeDir, relativePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  /** Reads an artifact file. */
  read(relativePath: string): string {
    return fs.readFileSync(path.join(this.changeDir, relativePath), 'utf-8');
  }

  /** Returns true when all four core artifacts exist. */
  isComplete(): boolean {
    return (
      fs.existsSync(path.join(this.changeDir, 'proposal.md')) &&
      fs.existsSync(path.join(this.changeDir, 'design.md')) &&
      fs.existsSync(path.join(this.changeDir, 'specs', 'main', 'spec.md')) &&
      fs.existsSync(path.join(this.changeDir, 'tasks.md'))
    );
  }
}
