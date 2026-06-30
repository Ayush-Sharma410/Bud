import type { FullSceneSnapshot } from './excalidrawTypes';

/**
 * Bounded ring buffer of full-scene snapshots captured before Bud-controlled
 * mutations. Used as the fallback for `ExcalidrawController.undo()` when native
 * Excalidraw undo does not change the scene.
 *
 * Only Bud-applied operations push snapshots. Manual drawing changes are never
 * captured here, so the ring represents the controller's own undo history.
 */
export class SnapshotRing {
  private ring: FullSceneSnapshot[] = [];

  /** Store a pre-mutation snapshot and enforce retention limits. */
  push(snapshot: FullSceneSnapshot, limits?: { maxOperations: number; maxAgeMs: number }): void {
    this.ring.push(snapshot);
    if (limits) {
      this.evict(limits.maxOperations, limits.maxAgeMs);
    }
  }

  /** Remove and return the most recent snapshot. */
  pop(): FullSceneSnapshot | undefined {
    return this.ring.pop();
  }

  /** Inspect the most recent snapshot without removing it. */
  peek(): FullSceneSnapshot | undefined {
    return this.ring[this.ring.length - 1];
  }

  /** Number of retained snapshots. */
  size(): number {
    return this.ring.length;
  }

  /** True when no Bud-controlled snapshots are available. */
  isEmpty(): boolean {
    return this.ring.length === 0;
  }

  /** Drop all snapshots. */
  clear(): void {
    this.ring.length = 0;
  }

  /**
   * Prune snapshots older than `maxAgeMs`, then drop oldest entries if the
   * count still exceeds `maxOperations`. Most recent snapshots are kept.
   */
  evict(maxOperations: number, maxAgeMs: number): void {
    const now = Date.now();
    this.ring = this.ring.filter((s) => now - s.timestamp <= maxAgeMs);
    while (this.ring.length > maxOperations) {
      this.ring.shift();
    }
  }
}
