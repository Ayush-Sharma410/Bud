/**
 * Plain-node unit tests for the Excalidraw deterministic safety gate.
 *
 * Run with: npx ts-node app/src/main/excalidraw/safetyGate.test.ts
 */

import { classifyOperation } from './safetyGate';
import type { ExcalidrawOperation, SceneSummary } from './excalidrawTypes';
import type { ExcalidrawSettings } from '../settings';

const DEFAULT_SETTINGS: ExcalidrawSettings = {
  toggleHotkey: 'CommandOrControl+Shift+Space',
  saveDirectory: '/tmp/bud-test/sessions',
  autosaveIntervalMs: 5000,
  maxRecentSessions: 20,
  theme: 'auto',
  safetyThresholds: { maxElementsPerImmediateApply: 5, maxElementsPerDelete: 3 },
  snapshotRing: { maxOperations: 50, maxAgeMs: 1_800_000 },
};

function makeScene(overrides?: Partial<SceneSummary>): SceneSummary {
  return {
    sceneVersion: 1,
    elementCount: 3,
    canvasSize: { width: 1000, height: 800 },
    selection: [],
    deletedCount: 0,
    elements: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'hi' },
      { id: 'c', type: 'ellipse', x: 200, y: 200, width: 50, height: 50 },
    ],
    ...overrides,
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err: any) {
    console.error(`❌ ${name}:`, err?.message || err);
    process.exitCode = 1;
  }
}

(async () => {
  await test('create rectangle is immediate', () => {
    const result = classifyOperation(
      { kind: 'create', elementType: 'rectangle', x: 0, y: 0, width: 100, height: 100, id: 'r1' },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'immediate') throw new Error(`expected immediate, got ${result.decision}`);
    if (result.affectedIds?.[0] !== 'r1') throw new Error('expected affected id r1');
  });

  await test('create text is immediate', () => {
    const result = classifyOperation(
      { kind: 'create', elementType: 'text', x: 0, y: 0, width: 100, height: 20, text: 'hello', id: 't1' },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'immediate') throw new Error(`expected immediate, got ${result.decision}`);
  });

  await test('update explicit small ids is immediate', () => {
    const result = classifyOperation(
      { kind: 'update', ids: ['a'], changes: { strokeColor: '#ff0000' } },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'immediate') throw new Error(`expected immediate, got ${result.decision}`);
  });

  await test('update with unknown fields requires confirmation', () => {
    const result = classifyOperation(
      { kind: 'update', ids: ['a'], changes: { seed: 12345 } as any },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('update missing ids returns not_found', () => {
    const result = classifyOperation(
      { kind: 'update', ids: ['missing'], changes: { strokeColor: '#ff0000' } },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'not_found') throw new Error(`expected not_found, got ${result.decision}`);
    if (!result.notFoundIds?.includes('missing')) throw new Error('missing id not reported');
  });

  await test('update without ids falls back to selection', () => {
    const result = classifyOperation(
      { kind: 'update', changes: { strokeColor: '#ff0000' } },
      { scene: makeScene({ selection: ['a', 'c'] }), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'immediate') throw new Error(`expected immediate, got ${result.decision}`);
    if (result.affectedCount !== 2) throw new Error(`expected 2 affected, got ${result.affectedCount}`);
  });

  await test('update without ids and empty selection is not_found', () => {
    const result = classifyOperation(
      { kind: 'update', changes: { strokeColor: '#ff0000' } },
      { scene: makeScene({ selection: [] }), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'not_found') throw new Error(`expected not_found, got ${result.decision}`);
  });

  await test('bulk update exceeds threshold and requires confirmation', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const elements = ids.map((id, i) => ({
      id,
      type: 'rectangle' as const,
      x: i * 10,
      y: 0,
      width: 10,
      height: 10,
    }));
    const result = classifyOperation(
      { kind: 'update', ids, changes: { strokeColor: '#ff0000' } },
      { scene: makeScene({ elements, elementCount: elements.length }), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('delete always requires confirmation in S3', () => {
    const result = classifyOperation(
      { kind: 'delete', ids: ['a'] },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('clearCanvas requires confirmation', () => {
    const result = classifyOperation(
      { kind: 'clearCanvas' },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('replaceScene requires confirmation', () => {
    const result = classifyOperation(
      { kind: 'replaceScene', elements: [{ id: 'x', type: 'rectangle' }] },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('reorganizeLayout requires confirmation', () => {
    const result = classifyOperation(
      { kind: 'reorganizeLayout', ids: ['a', 'b'], layout: 'grid' },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('importScene is unsupported', () => {
    const result = classifyOperation(
      { kind: 'importScene', source: { type: 'file', path: '/tmp/foo.excalidraw' } },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'unsupported') throw new Error(`expected unsupported, got ${result.decision}`);
  });

  await test('align small explicit group is deferred to confirmation in S3', () => {
    const result = classifyOperation(
      { kind: 'align', ids: ['a', 'b'], alignment: 'left' },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('distribute is deferred to confirmation in S3', () => {
    const result = classifyOperation(
      { kind: 'distribute', ids: ['a', 'b'], direction: 'horizontal' },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('group small explicit group is deferred to confirmation in S3', () => {
    const result = classifyOperation(
      { kind: 'group', ids: ['a', 'b'] },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  await test('ungroup is deferred to confirmation in S3', () => {
    const result = classifyOperation(
      { kind: 'ungroup', ids: ['a'] },
      { scene: makeScene(), settings: DEFAULT_SETTINGS },
    );
    if (result.decision !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.decision}`);
    }
  });

  console.log('\n🎉 Safety gate tests passed');
})();
