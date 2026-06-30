/**
 * Unit tests for Excalidraw tool registration.
 *
 * Run with: npx ts-node app/src/main/excalidraw/createExcalidrawTools.test.ts
 */

import { Module } from 'module';
import type { SceneSummary, ApplyResult, ProposalResult, UndoResult } from './excalidrawTypes';

// ── Minimal Electron mock so the controller can import ─────────────────────────
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => '/tmp/bud-test',
      },
      BrowserWindow: class MockBrowserWindow {
        isDestroyed() {
          return false;
        }
        isMinimized() {
          return false;
        }
        show() {}
        focus() {}
        restore() {}
        get webContents() {
          return {
            send: () => {},
            once: () => {},
          };
        }
        once(_event: string, _cb: () => void) {}
        loadFile(_path: string) {
          return Promise.resolve();
        }
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

async function importFresh() {
  const { ExcalidrawController } = await import('./ExcalidrawController');
  const { ExcalidrawWindowManager } = await import('./ExcalidrawWindowManager');
  const { createExcalidrawTools } = await import('./createExcalidrawTools');
  return { ExcalidrawController, ExcalidrawWindowManager, createExcalidrawTools };
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

function makeScene(): SceneSummary {
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
  };
}

const REQUIRED_TOOLS = [
  'excalidraw_readScene',
  'excalidraw_applyOperation',
  'excalidraw_applyOperations',
  'excalidraw_proposeOperation',
  'excalidraw_confirmProposal',
  'excalidraw_cancelProposal',
  'excalidraw_undo',
];

(async () => {
  const { ExcalidrawController, ExcalidrawWindowManager, createExcalidrawTools } = await importFresh();

  function makeController(overrides?: Partial<ConstructorParameters<typeof ExcalidrawController>[0]>) {
    const wm = new ExcalidrawWindowManager();
    wm.openOrFocus = async () => wm.getWindow() as any;
    const controller = new ExcalidrawController({ windowManager: wm, ...overrides });
    return { controller, wm };
  }

  await test('registers all seven exact tool names on both Vercel and Realtime sides', () => {
    const { controller } = makeController();
    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);

    const vercelNames = Object.keys(vercelTools).sort();
    const realtimeNames = realtimeExecutors.map((e) => e.name).sort();
    const expected = [...REQUIRED_TOOLS].sort();

    if (JSON.stringify(vercelNames) !== JSON.stringify(expected)) {
      throw new Error(`Vercel tool names mismatch: ${JSON.stringify(vercelNames)}`);
    }
    if (JSON.stringify(realtimeNames) !== JSON.stringify(expected)) {
      throw new Error(`Realtime tool names mismatch: ${JSON.stringify(realtimeNames)}`);
    }
  });

  await test('excalidraw_readScene routes to controller.readScene and returns compact summary', async () => {
    const { controller } = makeController();
    const scene = makeScene();
    controller.readScene = async () => scene;

    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);

    const vercelResult = await vercelTools.excalidraw_readScene.execute({}, { toolCallId: 't1', messages: [] });
    if (vercelResult !== scene) throw new Error('Vercel readScene did not return controller result');

    const rtExecutor = realtimeExecutors.find((e) => e.name === 'excalidraw_readScene')!;
    const rtResult = await rtExecutor.execute({});
    if (rtResult !== scene) throw new Error('Realtime readScene did not return controller result');

    const summary = vercelResult as SceneSummary;
    if (!('elementCount' in summary)) throw new Error('readScene did not return elementCount');
    if (!('selection' in summary)) throw new Error('readScene did not return selection');
    if ('elements' in summary && Array.isArray(summary.elements)) {
      for (const el of summary.elements) {
        if ('customData' in el || ('id' in el && typeof (el as any).version === 'object')) {
          throw new Error('readScene appears to expose raw element JSON');
        }
      }
    }
    if ('snapshotPath' in summary || ('sceneVersion' in summary && typeof summary.sceneVersion !== 'number')) {
      throw new Error('readScene exposes unexpected full-scene/snapshot data');
    }
  });

  await test('excalidraw_applyOperation routes to controller.applyOperation', async () => {
    const { controller } = makeController();
    const applied: ApplyResult = { status: 'applied', sceneVersion: 2, affectedIds: ['r1'], affectedCount: 1 };
    let receivedOp: any = null;
    controller.applyOperation = async (op) => {
      receivedOp = op;
      return applied;
    };

    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);
    const op = { kind: 'create', elementType: 'rectangle', x: 0, y: 0, width: 100, height: 100 };

    const vercelResult = await vercelTools.excalidraw_applyOperation.execute(
      { operation: op },
      { toolCallId: 't2', messages: [] }
    );
    if (vercelResult !== applied) throw new Error('Vercel applyOperation result mismatch');

    const rtExecutor = realtimeExecutors.find((e) => e.name === 'excalidraw_applyOperation')!;
    const rtResult = await rtExecutor.execute({ operation: op });
    if (rtResult !== applied) throw new Error('Realtime applyOperation result mismatch');
    if (JSON.stringify(receivedOp) !== JSON.stringify(op)) throw new Error('applyOperation received wrong operation');
  });

  await test('excalidraw_applyOperations routes to controller.applyOperations with a batch', async () => {
    const { controller } = makeController();
    const applied: ApplyResult = { status: 'applied', sceneVersion: 5, affectedIds: ['b1', 'b2', 'a1'], affectedCount: 3 };
    let receivedOps: any = null;
    controller.applyOperations = async (ops) => {
      receivedOps = ops;
      return applied;
    };

    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);
    const ops = [
      { kind: 'create', elementType: 'rectangle', id: 'b1', x: 0, y: 0, width: 100, height: 60 },
      { kind: 'create', elementType: 'rectangle', id: 'b2', x: 0, y: 120, width: 100, height: 60 },
      { kind: 'create', elementType: 'arrow', x: 0, y: 0, width: 0, height: 0, startElementId: 'b1', endElementId: 'b2' },
    ];

    const vercelResult = await vercelTools.excalidraw_applyOperations.execute(
      { operations: ops },
      { toolCallId: 't-batch', messages: [] },
    );
    if (vercelResult !== applied) throw new Error('Vercel applyOperations result mismatch');

    const rtExecutor = realtimeExecutors.find((e) => e.name === 'excalidraw_applyOperations')!;
    const rtResult = await rtExecutor.execute({ operations: ops });
    if (rtResult !== applied) throw new Error('Realtime applyOperations result mismatch');
    if (JSON.stringify(receivedOps) !== JSON.stringify(ops)) throw new Error('applyOperations received wrong operations');
  });

  await test('excalidraw_proposeOperation routes to controller.proposeOperation', async () => {
    const { controller } = makeController();
    const pending: ProposalResult = { status: 'pending', proposalId: 'p1', expiresAt: Date.now() + 600_000 };
    let receivedArgs: { op: any; opts: any } = { op: null, opts: null };
    controller.proposeOperation = async (op, opts) => {
      receivedArgs = { op, opts };
      return pending;
    };

    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);
    const op = { kind: 'delete', ids: ['a'] };
    const opts = { summary: 'remove a' };

    const vercelResult = await vercelTools.excalidraw_proposeOperation.execute(
      { operation: op, options: opts },
      { toolCallId: 't3', messages: [] }
    );
    if (vercelResult !== pending) throw new Error('Vercel proposeOperation result mismatch');

    const rtExecutor = realtimeExecutors.find((e) => e.name === 'excalidraw_proposeOperation')!;
    const rtResult = await rtExecutor.execute({ operation: op, options: opts });
    if (rtResult !== pending) throw new Error('Realtime proposeOperation result mismatch');
    if (receivedArgs?.op !== op) throw new Error('proposeOperation received wrong operation');
    if (receivedArgs?.opts !== opts) throw new Error('proposeOperation received wrong options');
  });

  await test('excalidraw_confirmProposal routes to controller.confirmProposal', async () => {
    const { controller } = makeController();
    const applied: ApplyResult = { status: 'applied', sceneVersion: 3, affectedIds: ['a'], affectedCount: 1 };
    let receivedArgs: { proposalId: string; optionId?: string } = { proposalId: '', optionId: undefined };
    controller.confirmProposal = async (proposalId, optionId) => {
      receivedArgs = { proposalId, optionId };
      return applied;
    };

    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);

    const vercelResult = await vercelTools.excalidraw_confirmProposal.execute(
      { proposalId: 'p1' },
      { toolCallId: 't4', messages: [] }
    );
    if (vercelResult !== applied) throw new Error('Vercel confirmProposal result mismatch');

    const rtExecutor = realtimeExecutors.find((e) => e.name === 'excalidraw_confirmProposal')!;
    const rtResult = await rtExecutor.execute({ proposalId: 'p1', optionId: 'o1' });
    if (rtResult !== applied) throw new Error('Realtime confirmProposal result mismatch');
    if (receivedArgs?.proposalId !== 'p1') throw new Error('confirmProposal received wrong proposalId');
    if (receivedArgs?.optionId !== 'o1') throw new Error('confirmProposal received wrong optionId');
  });

  await test('excalidraw_cancelProposal routes to controller.cancelProposal', async () => {
    const { controller } = makeController();
    const cancelled: ProposalResult = { status: 'cancelled', proposalId: 'p1' };
    let receivedId: string | null = null;
    controller.cancelProposal = async (proposalId) => {
      receivedId = proposalId;
      return cancelled;
    };

    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);

    const vercelResult = await vercelTools.excalidraw_cancelProposal.execute(
      { proposalId: 'p1' },
      { toolCallId: 't5', messages: [] }
    );
    if (vercelResult !== cancelled) throw new Error('Vercel cancelProposal result mismatch');

    const rtExecutor = realtimeExecutors.find((e) => e.name === 'excalidraw_cancelProposal')!;
    const rtResult = await rtExecutor.execute({ proposalId: 'p1' });
    if (rtResult !== cancelled) throw new Error('Realtime cancelProposal result mismatch');
    if (receivedId !== 'p1') throw new Error('cancelProposal received wrong proposalId');
  });

  await test('excalidraw_undo routes to controller.undo', async () => {
    const { controller } = makeController();
    const undone: UndoResult = { status: 'undone', via: 'native', sceneVersion: 1 };
    let called = false;
    controller.undo = async () => {
      called = true;
      return undone;
    };

    const { vercelTools, realtimeExecutors } = createExcalidrawTools(controller);

    const vercelResult = await vercelTools.excalidraw_undo.execute({}, { toolCallId: 't6', messages: [] });
    if (vercelResult !== undone) throw new Error('Vercel undo result mismatch');

    const rtExecutor = realtimeExecutors.find((e) => e.name === 'excalidraw_undo')!;
    const rtResult = await rtExecutor.execute({});
    if (rtResult !== undone) throw new Error('Realtime undo result mismatch');
    if (!called) throw new Error('controller.undo was not called');
  });

  await test('tool schemas are defined and non-empty for Realtime', () => {
    const { controller } = makeController();
    const { realtimeExecutors } = createExcalidrawTools(controller);

    for (const executor of realtimeExecutors) {
      if (!executor.parameters || typeof executor.parameters !== 'object') {
        throw new Error(`${executor.name} missing parameters schema`);
      }
      if (!executor.description || executor.description.length === 0) {
        throw new Error(`${executor.name} missing description`);
      }
    }
  });
})();
