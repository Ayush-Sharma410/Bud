import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';

const db = new Database(path.join(app.getPath('userData'), 'bud-bus.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id         TEXT PRIMARY KEY,
    status     TEXT    DEFAULT 'pending',
    type       TEXT,
    payload    TEXT,
    result     TEXT,
    progress   TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);

export const bus = {
  post(id: string, type: string, payload: object) {
    db.prepare(
      `INSERT INTO agent_tasks (id, type, payload) VALUES (?, ?, ?)`
    ).run(id, type, JSON.stringify(payload));
  },

  claim(id: string) {
    db.prepare(
      `UPDATE agent_tasks SET status='running', updated_at=unixepoch() WHERE id=?`
    ).run(id);
    return db.prepare(`SELECT * FROM agent_tasks WHERE id=?`).get(id) as any;
  },

  progress(id: string, note: string) {
    db.prepare(
      `UPDATE agent_tasks SET progress=?, updated_at=unixepoch() WHERE id=?`
    ).run(note, id);
  },

  complete(id: string, result: object) {
    db.prepare(
      `UPDATE agent_tasks SET status='done', result=?, updated_at=unixepoch() WHERE id=?`
    ).run(JSON.stringify(result), id);
  },

  fail(id: string, error: string) {
    db.prepare(
      `UPDATE agent_tasks SET status='failed', result=?, updated_at=unixepoch() WHERE id=?`
    ).run(JSON.stringify({ error }), id);
  },

  getAll() {
    return db.prepare(
      `SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT 50`
    ).all() as any[];
  },

  get(id: string) {
    return db.prepare(`SELECT * FROM agent_tasks WHERE id=?`).get(id) as any;
  },

  cancelPending() {
    db.prepare(
      `UPDATE agent_tasks SET status='cancelled' WHERE status IN ('pending','running')`
    ).run();
  }
};