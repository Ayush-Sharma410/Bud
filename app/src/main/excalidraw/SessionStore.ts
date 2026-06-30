import fs from 'fs';
import path from 'path';

/**
 * Lightweight recent-session index entry.
 *
 * Keeps only metadata — no full scene JSON — so the index stays small and
 * safe to expose in status/settings surfaces.
 */
export interface RecentSessionEntry {
  sessionId: string;
  name: string;
  updatedAt: number;
  filePath: string;
}

/**
 * On-disk shape of `excalidraw-sessions.json`.
 */
export interface RecentSessionsIndex {
  sessions: RecentSessionEntry[];
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Persists a small, most-recent-first index of saved Excalidraw sessions.
 *
 * The index file (`excalidraw-sessions.json`) lives inside the configured
 * `saveDirectory` alongside the `.excalidraw` session files. Loads tolerate
 * missing or corrupt files by returning an empty index rather than crashing.
 */
export class SessionStore {
  private indexPath: string;
  private maxRecentSessions: number;

  constructor(saveDirectory: string, maxRecentSessions = 20) {
    this.indexPath = path.join(saveDirectory, 'excalidraw-sessions.json');
    this.maxRecentSessions = maxRecentSessions;
  }

  getSaveDirectory(): string {
    return path.dirname(this.indexPath);
  }

  getIndexPath(): string {
    return this.indexPath;
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.indexPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Load the persisted index. Returns an empty index if the file is missing
   * or cannot be parsed.
   */
  loadIndex(): RecentSessionsIndex {
    try {
      if (!fs.existsSync(this.indexPath)) {
        return { sessions: [] };
      }
      const raw = fs.readFileSync(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
        throw new Error('Invalid index shape');
      }
      const sessions: RecentSessionEntry[] = parsed.sessions
        .filter(
          (s: any) =>
            s &&
            typeof s.sessionId === 'string' &&
            typeof s.name === 'string' &&
            typeof s.updatedAt === 'number' &&
            typeof s.filePath === 'string',
        )
        .sort((a: RecentSessionEntry, b: RecentSessionEntry) => b.updatedAt - a.updatedAt);
      return { sessions };
    } catch (err: any) {
      console.warn('⚠️ Excalidraw SessionStore: failed to load index, returning empty:', err?.message || err);
      return { sessions: [] };
    }
  }

  /**
   * Persist the index atomically (write temp + rename).
   */
  saveIndex(index: RecentSessionsIndex): void {
    try {
      this.ensureDirectory();
      atomicWriteJson(this.indexPath, index);
    } catch (err: any) {
      console.error('⚠️ Excalidraw SessionStore: failed to save index:', err?.message || err);
    }
  }

  /**
   * Add a new session or bump an existing one to the front of the recent list.
   * Evicts the oldest entries when the max count is exceeded.
   */
  addOrUpdateSession(entry: RecentSessionEntry): void {
    const index = this.loadIndex();
    const existingIndex = index.sessions.findIndex((s) => s.sessionId === entry.sessionId);
    if (existingIndex >= 0) {
      index.sessions.splice(existingIndex, 1);
    }
    index.sessions.unshift(entry);
    while (index.sessions.length > this.maxRecentSessions) {
      index.sessions.pop();
    }
    this.saveIndex(index);
  }

  /**
   * Return recent sessions, most-recent first. Optionally cap the count.
   */
  getRecentSessions(limit?: number): RecentSessionEntry[] {
    const index = this.loadIndex();
    return index.sessions.slice(0, limit ?? index.sessions.length);
  }

  /**
   * Remove a session from the index. Does not delete the backing `.excalidraw`
   * file; callers that want full cleanup should remove the file separately.
   */
  removeSession(sessionId: string): void {
    const index = this.loadIndex();
    const filtered = index.sessions.filter((s) => s.sessionId !== sessionId);
    if (filtered.length !== index.sessions.length) {
      this.saveIndex({ sessions: filtered });
    }
  }
}
