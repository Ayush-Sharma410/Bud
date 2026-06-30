/**
 * Plain-node unit tests for ExcalidrawController S5 undo + snapshot ring.
 *
 * Run with: npx ts-node app/src/main/excalidraw/ExcalidrawController.undo.test.ts
 */

import { Module } from 'module';

// ── Minimal Electron mock so the window manager/controller can import ─────────
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
  return { ExcalidrawController, ExcalidrawWindowManager };
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

function makeScene(): import('./excalidrawTypes').SceneSummary {
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

(async () => {
  const { ExcalidrawController, ExcalidrawWindowManager } = await importFresh();

  function createController(timeoutMs: number = 500) {
    const wm = new ExcalidrawWindowManager();
    const controller = new ExcalidrawController({ windowManager: wm, timeoutMs });
    controller.onSceneChange(makeScene());
    return { controller, wm };
  }

  function captureSend(wm: any, controller: any) {
    const sent: Array<{ channel: string; data: any }> = [];
    wm.openOrFocus = async () => wm.getWindow() as any;
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      sent.push({ channel, data });
      if (channel === 'canvas:request-snapshot') {
        controller.handleSnapshotResponse({
          requestId: data.requestId,
          snapshot: { sceneVersion: 1, elements: [{ id: 'snap', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }], timestamp: Date.now() },
        });
      }
    };
    return sent;
  }

  function findLast(sent: Array<{ channel: string; data: any }>, channel: string) {
    return sent.filter((s) => s.channel === channel).pop();
  }

  await test('snapshot is captured before an applied operation', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm, controller);

    const pending = controller.applyOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r1',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshotIdx = sent.findIndex((s) => s.channel === 'canvas:request-snapshot');
    const applyIdx = sent.findIndex((s) => s.channel === 'canvas:apply-scene');
    if (snapshotIdx === -1) throw new Error('canvas:request-snapshot was not sent');
    if (applyIdx === -1) throw new Error('canvas:apply-scene was not sent');
    if (snapshotIdx > applyIdx) throw new Error('snapshot must be captured before apply');

    const apply = sent[applyIdx];
    controller.handleApplyResponse({
      requestId: apply.data.requestId,
      result: { status: 'applied', sceneVersion: 2, affectedIds: ['r1'], affectedCount: 1 },
    });

    const result = await pending;
    if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
  });

  await test('undo with empty ring returns nothingToUndo without IPC', async () => {
    const { controller, wm } = createController();
    const sent: Array<{ channel: string; data: any }> = [];
    wm.openOrFocus = async () => wm.getWindow() as any;
    (wm as any).sendToCanvas = (channel: string, data: any) => sent.push({ channel, data });

    const result = await controller.undo();
    if (result.status !== 'nothingToUndo') throw new Error(`expected nothingToUndo, got ${result.status}`);
    const undo = sent.find((s) => s.channel === 'canvas:undo-native');
    if (undo) throw new Error('canvas:undo-native should not be sent when ring is empty');
  });

  await test('native undo success returns undone via native and consumes snapshot', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm, controller);

    // Apply an operation so a snapshot is pushed.
    const applyPending = controller.applyOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r2',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const applyReq = findLast(sent, 'canvas:apply-scene');
    if (!applyReq) throw new Error('apply request not sent');
    controller.handleApplyResponse({
      requestId: applyReq.data.requestId,
      result: { status: 'applied', sceneVersion: 2, affectedIds: ['r2'], affectedCount: 1 },
    });
    await applyPending;

    // Start undo; baseline is the post-apply scene version.
    controller.onSceneChange({ ...makeScene(), sceneVersion: 2 });
    const undoPending = controller.undo();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const undoReq = findLast(sent, 'canvas:undo-native');
    if (!undoReq) throw new Error('canvas:undo-native was not sent');

    // Simulate a scene-change event that proves native undo worked.
    controller.onSceneChange({ ...makeScene(), sceneVersion: 1 });

    const result = await undoPending;
    if (result.status !== 'undone') throw new Error(`expected undone, got ${result.status}`);
    if ((result as any).via !== 'native') throw new Error(`expected native undo, got ${(result as any).via}`);

    const restore = sent.find((s) => s.channel === 'canvas:restore-snapshot');
    if (restore) throw new Error('snapshot fallback should not run on native success');
  });

  await test('native undo no-change falls back to snapshot restore', async () => {
    const { controller, wm } = createController(50);
    const sent = captureSend(wm, controller);

    const applyPending = controller.applyOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r3',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const applyReq = findLast(sent, 'canvas:apply-scene');
    if (!applyReq) throw new Error('apply request not sent');
    controller.handleApplyResponse({
      requestId: applyReq.data.requestId,
      result: { status: 'applied', sceneVersion: 2, affectedIds: ['r3'], affectedCount: 1 },
    });
    await applyPending;

    controller.onSceneChange({ ...makeScene(), sceneVersion: 2 });
    const undoPending = controller.undo();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const undoReq = findLast(sent, 'canvas:undo-native');
    if (!undoReq) throw new Error('canvas:undo-native was not sent');

    // Renderer reports no scene change.
    controller.handleUndoNativeResponse({
      requestId: undoReq.data.requestId,
      sceneVersion: 2,
      changed: false,
    });

    // Wait for the controller timeout fallback.
    await new Promise((resolve) => setTimeout(resolve, 70));

    const restoreReq = findLast(sent, 'canvas:restore-snapshot');
    if (!restoreReq) throw new Error('canvas:restore-snapshot should be sent as fallback');

    controller.handleRestoreSnapshotResponse({
      requestId: restoreReq.data.requestId,
      result: { status: 'restored', sceneVersion: 1 },
    });

    const result = await undoPending;
    if (result.status !== 'undone') throw new Error(`expected undone, got ${result.status}`);
    if ((result as any).via !== 'snapshot') throw new Error(`expected snapshot fallback, got ${(result as any).via}`);
  });

  await test('confirmed proposal captures snapshot and can be undone', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm, controller);

    const proposed = await controller.proposeOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r4',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    if (proposed.status !== 'pending') throw new Error(`expected pending, got ${proposed.status}`);

    const confirmPending = controller.confirmProposal(proposed.proposalId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshotReq = sent.find((s) => s.channel === 'canvas:request-snapshot');
    if (!snapshotReq) throw new Error('snapshot should be requested before confirming proposal');

    const applyReq = findLast(sent, 'canvas:apply-scene');
    if (!applyReq) throw new Error('apply request not sent on confirm');
    controller.handleApplyResponse({
      requestId: applyReq.data.requestId,
      result: { status: 'applied', sceneVersion: 2, affectedIds: ['r4'], affectedCount: 1 },
    });
    await confirmPending;

    controller.onSceneChange({ ...makeScene(), sceneVersion: 2 });
    const undoPending = controller.undo();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const undoReq = findLast(sent, 'canvas:undo-native');
    if (!undoReq) throw new Error('canvas:undo-native not sent for confirmed proposal undo');

    controller.onSceneChange({ ...makeScene(), sceneVersion: 1 });
    const undoResult = await undoPending;
    if (undoResult.status !== 'undone') throw new Error(`expected undone, got ${undoResult.status}`);
  });

  console.log('\n🎉 ExcalidrawController S5 undo tests passed');
})();
