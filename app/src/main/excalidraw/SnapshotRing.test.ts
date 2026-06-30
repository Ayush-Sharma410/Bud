/**
 * Plain-node unit tests for the Excalidraw snapshot ring.
 *
 * Run with: npx ts-node app/src/main/excalidraw/SnapshotRing.test.ts
 */

import { SnapshotRing } from './SnapshotRing';
import type { FullSceneSnapshot } from './excalidrawTypes';

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err: any) {
    console.error(`❌ ${name}:`, err?.message || err);
    process.exitCode = 1;
  }
}

function makeSnapshot(sceneVersion: number, timestamp: number): FullSceneSnapshot {
  return {
    sceneVersion,
    elements: [{ id: `el-${sceneVersion}`, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
    timestamp,
  };
}

(async () => {
  await test('push/pop/peek work in LIFO order', () => {
    const ring = new SnapshotRing();
    const a = makeSnapshot(1, Date.now());
    const b = makeSnapshot(2, Date.now());
    ring.push(a);
    ring.push(b);
    if (ring.size() !== 2) throw new Error(`expected size 2, got ${ring.size()}`);
    if (ring.peek()?.sceneVersion !== 2) throw new Error('peek should return newest');
    if (ring.pop()?.sceneVersion !== 2) throw new Error('pop should return newest');
    if (ring.pop()?.sceneVersion !== 1) throw new Error('second pop should return oldest');
    if (!ring.isEmpty()) throw new Error('ring should be empty');
  });

  await test('evicts oldest snapshots when count exceeds maxOperations', () => {
    const ring = new SnapshotRing();
    const now = Date.now();
    ring.push(makeSnapshot(1, now), { maxOperations: 3, maxAgeMs: 60_000 });
    ring.push(makeSnapshot(2, now + 1), { maxOperations: 3, maxAgeMs: 60_000 });
    ring.push(makeSnapshot(3, now + 2), { maxOperations: 3, maxAgeMs: 60_000 });
    ring.push(makeSnapshot(4, now + 3), { maxOperations: 3, maxAgeMs: 60_000 });

    if (ring.size() !== 3) throw new Error(`expected size 3, got ${ring.size()}`);
    if (ring.peek()?.sceneVersion !== 4) throw new Error('newest should be 4');
    const versions = ring as any;
    // Access internal array for verification
    const internal = versions.ring as FullSceneSnapshot[];
    if (internal[0].sceneVersion !== 2) throw new Error('oldest retained should be 2');
  });

  await test('evicts snapshots older than maxAgeMs', () => {
    const ring = new SnapshotRing();
    const now = Date.now();
    ring.push(makeSnapshot(1, now - 100_000), { maxOperations: 10, maxAgeMs: 60_000 });
    ring.push(makeSnapshot(2, now - 30_000), { maxOperations: 10, maxAgeMs: 60_000 });
    ring.push(makeSnapshot(3, now), { maxOperations: 10, maxAgeMs: 60_000 });

    if (ring.size() !== 2) throw new Error(`expected size 2 after age eviction, got ${ring.size()}`);
    if (ring.peek()?.sceneVersion !== 3) throw new Error('newest should be 3');
    if (ring.pop()?.sceneVersion !== 3) throw new Error('pop should return 3');
    if (ring.pop()?.sceneVersion !== 2) throw new Error('pop should return 2');
  });

  await test('clear removes all snapshots', () => {
    const ring = new SnapshotRing();
    ring.push(makeSnapshot(1, Date.now()));
    ring.push(makeSnapshot(2, Date.now()));
    ring.clear();
    if (!ring.isEmpty()) throw new Error('ring should be empty after clear');
  });

  await test('evict respects both age and count together', () => {
    const ring = new SnapshotRing();
    const now = Date.now();
    ring.push(makeSnapshot(1, now - 100_000), { maxOperations: 1, maxAgeMs: 60_000 });
    ring.push(makeSnapshot(2, now - 50_000), { maxOperations: 1, maxAgeMs: 60_000 });
    ring.push(makeSnapshot(3, now), { maxOperations: 1, maxAgeMs: 60_000 });

    if (ring.size() !== 1) throw new Error(`expected size 1, got ${ring.size()}`);
    if (ring.peek()?.sceneVersion !== 3) throw new Error('only newest should remain');
  });

  console.log('\n🎉 SnapshotRing tests passed');
})();
