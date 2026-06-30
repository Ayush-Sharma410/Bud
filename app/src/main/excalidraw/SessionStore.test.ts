/**
 * Plain-node unit tests for Excalidraw SessionStore.
 *
 * Run with: npx ts-node app/src/main/excalidraw/SessionStore.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { SessionStore, type RecentSessionEntry } from './SessionStore';

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err: any) {
    console.error(`❌ ${name}:`, err?.message || err);
    process.exitCode = 1;
  }
}

function makeEntry(name: string, dir: string): RecentSessionEntry {
  const sessionId = randomUUID();
  return {
    sessionId,
    name,
    updatedAt: Date.now(),
    filePath: path.join(dir, `${sessionId}.excalidraw`),
  };
}

function makeTempDir(): string {
  return path.join(os.tmpdir(), `bud-sessionstore-test-${randomUUID()}`);
}

(async () => {
  await test('load missing index returns empty sessions', () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir);
    const index = store.loadIndex();
    if (index.sessions.length !== 0) {
      throw new Error(`expected empty sessions, got ${index.sessions.length}`);
    }
  });

  await test('addOrUpdateSession persists and returns session', () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir);
    const entry = makeEntry('First sketch', dir);

    store.addOrUpdateSession(entry);
    const recent = store.getRecentSessions();
    if (recent.length !== 1) throw new Error(`expected 1 session, got ${recent.length}`);
    if (recent[0].sessionId !== entry.sessionId) throw new Error('session id mismatch');
    if (recent[0].name !== 'First sketch') throw new Error('name mismatch');
  });

  await test('addOrUpdateSession bumps existing session to front', () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir);
    const a = makeEntry('A', dir);
    const b = makeEntry('B', dir);

    store.addOrUpdateSession(a);
    store.addOrUpdateSession(b);

    // Wait briefly so timestamps differ.
    const start = Date.now();
    while (Date.now() <= start) {} // tiny busy-wait to ensure > 0 ms
    a.name = 'A updated';
    a.updatedAt = Date.now();
    store.addOrUpdateSession(a);

    const recent = store.getRecentSessions();
    if (recent.length !== 2) throw new Error(`expected 2 sessions, got ${recent.length}`);
    if (recent[0].sessionId !== a.sessionId) throw new Error('updated session should be first');
    if (recent[0].name !== 'A updated') throw new Error('updated name not persisted');
  });

  await test('maxRecentSessions evicts oldest entries', () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 3);
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`Session ${i}`, dir));

    for (const e of entries) {
      store.addOrUpdateSession(e);
    }

    const recent = store.getRecentSessions();
    if (recent.length !== 3) throw new Error(`expected 3 sessions after eviction, got ${recent.length}`);
    if (recent[0].name !== 'Session 4') throw new Error('newest should be Session 4');
    if (recent[2].name !== 'Session 2') throw new Error('oldest retained should be Session 2');
  });

  await test('getRecentSessions respects limit', () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 10);
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`Session ${i}`, dir));

    for (const e of entries) store.addOrUpdateSession(e);
    const recent = store.getRecentSessions(2);
    if (recent.length !== 2) throw new Error(`expected 2 sessions, got ${recent.length}`);
    if (recent[0].name !== 'Session 4') throw new Error('first should be Session 4');
  });

  await test('corrupt index file is tolerated and overwritten', () => {
    const dir = makeTempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'excalidraw-sessions.json'), 'not-json', 'utf-8');

    const store = new SessionStore(dir);
    const index = store.loadIndex();
    if (index.sessions.length !== 0) {
      throw new Error('corrupt index should return empty sessions');
    }

    const entry = makeEntry('Recovered', dir);
    store.addOrUpdateSession(entry);
    if (store.getRecentSessions().length !== 1) {
      throw new Error('store should recover after corrupt load');
    }
  });

  await test('index file stores stable shape without scene contents', () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir);
    const entry = makeEntry('No secrets', dir);
    store.addOrUpdateSession(entry);

    const raw = fs.readFileSync(store.getIndexPath(), 'utf-8');
    if (raw.includes('elements')) throw new Error('index should not contain scene elements');
    if (!raw.includes('No secrets')) throw new Error('index should contain session name');
    const parsed = JSON.parse(raw);
    if (!parsed.sessions || parsed.sessions.length !== 1) throw new Error('parsed index shape invalid');
  });

  console.log('\n🎉 SessionStore tests passed');
})();
