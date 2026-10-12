import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Tiny JSON-file-backed store, one file per concern (mods.json, profiles.json, saves.json,
 * settings.json) - no database engine needed for data this small. Writes go to a temp file then
 * rename() over the real one, so a crash mid-write can never leave a half-written, corrupt file.
 */
export class JsonStore {
  constructor(dataDir, filename, defaultValue) {
    this.filePath = path.join(dataDir, filename);
    this.defaultValue = defaultValue;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  }

  read() {
    if (!existsSync(this.filePath)) return structuredClone(this.defaultValue);
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return structuredClone(this.defaultValue);
    }
  }

  write(value) {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tempPath, this.filePath);
  }

  /** Reads, hands the value to `mutate` (which may return a new value or mutate in place and
   * return it), then writes the result back. Returns whatever `mutate` returned. */
  update(mutate) {
    const next = mutate(this.read());
    this.write(next);
    return next;
  }
}
