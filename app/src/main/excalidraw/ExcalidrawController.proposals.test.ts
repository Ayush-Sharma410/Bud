/**
 * Plain-node unit tests for ExcalidrawController S4 proposal lifecycle.
 *
 * Run with: npx ts-node app/src/main/excalidraw/ExcalidrawController.proposals.test.ts
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

  function createController() {
    const wm = new ExcalidrawWindowManager();
    const controller = new ExcalidrawController({ windowManager: wm, timeoutMs: 500 });
    controller.onSceneChange(makeScene());
    return { controller, wm };
  }

  function captureSend(wm: any) {
    const sent: Array<{ channel: string; data: any }> = [];
    wm.openOrFocus = async () => wm.getWindow() as any;
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      sent.push({ channel, data });
    };
    return sent;
  }

  await test('proposeOperation creates a pending proposal and sends ghost IPC', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const result = await controller.proposeOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r-ghost',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    });

    if (result.status !== 'pending') {
      throw new Error(`expected pending, got ${result.status}`);
    }

    const render = sent.find((s) => s.channel === 'canvas:render-ghosts');
    if (!render) throw new Error('canvas:render-ghosts was not sent');
    if (render.data.proposalId !== result.proposalId) throw new Error('proposal id mismatch');
    if (render.data.operations[0].kind !== 'create') throw new Error('expected create operation in ghost payload');

    const hud = sent.find((s) => s.channel === 'canvas:hud');
    if (hud?.data.state !== 'proposalPending') throw new Error('expected proposalPending HUD');
  });

  await test('confirmProposal applies the stored operation and clears ghosts', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const proposed = await controller.proposeOperation({
      kind: 'create',
      elementType: 'text',
      id: 't-proposed',
      x: 5,
      y: 5,
      width: 50,
      height: 20,
      text: 'proposed',
    });
    if (proposed.status !== 'pending') {
      throw new Error(`expected pending, got ${proposed.status}`);
    }

    const confirmPromise = controller.confirmProposal(proposed.proposalId);

    // Wait for the confirmed apply IPC to be emitted.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const apply = sent.find((s) => s.channel === 'canvas:apply-scene');
    if (!apply) throw new Error('canvas:apply-scene was not sent on confirm');
    if (apply.data.operations[0].kind !== 'create') throw new Error('expected create operation on confirm');

    controller.handleApplyResponse({
      requestId: apply.data.requestId,
      result: { status: 'applied', sceneVersion: 2, affectedIds: ['t-proposed'], affectedCount: 1 },
    });

    const result = await confirmPromise;
    if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);

    const clear = sent.filter((s) => s.channel === 'canvas:clear-ghosts').pop();
    if (!clear) throw new Error('canvas:clear-ghosts was not sent after confirm');
    if (clear.data.proposalId !== proposed.proposalId) throw new Error('clear ghosts proposal id mismatch');

    const proposals = controller.getProposals();
    if (proposals.get(proposed.proposalId)?.status !== 'confirmed') {
      throw new Error('proposal status should be confirmed');
    }
  });

  await test('cancelProposal clears ghosts and does not apply', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const proposed = await controller.proposeOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r-cancel',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    if (proposed.status !== 'pending') {
      throw new Error(`expected pending, got ${proposed.status}`);
    }

    const cancelResult = await controller.cancelProposal(proposed.proposalId);
    if (cancelResult.status !== 'cancelled') throw new Error(`expected cancelled, got ${cancelResult.status}`);

    const apply = sent.find((s) => s.channel === 'canvas:apply-scene');
    if (apply) throw new Error('canvas:apply-scene should not be sent on cancel');

    const clear = sent.filter((s) => s.channel === 'canvas:clear-ghosts').pop();
    if (!clear) throw new Error('canvas:clear-ghosts was not sent on cancel');
    if (clear.data.proposalId !== proposed.proposalId) throw new Error('clear ghosts id mismatch');
  });

  await test('expired proposal cannot be confirmed and clears ghosts', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const proposed = await controller.proposeOperation(
      {
        kind: 'create',
        elementType: 'rectangle',
        id: 'r-expire',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      },
      { ttlMs: -1 },
    );
    if (proposed.status !== 'pending') {
      throw new Error(`expected pending, got ${proposed.status}`);
    }

    const result = await controller.confirmProposal(proposed.proposalId);
    if (result.status !== 'not_found') throw new Error(`expected not_found, got ${result.status}`);

    const clear = sent.find((s) => s.channel === 'canvas:clear-ghosts');
    if (!clear) throw new Error('canvas:clear-ghosts should be sent when expiring on confirm');
  });

  await test('unsupported/import proposal does not create ghosts', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const result = await controller.proposeOperation({
      kind: 'importScene',
      source: { type: 'file', path: '/tmp/foo.excalidraw' },
    });
    if (result.status !== 'unsupported') throw new Error(`expected unsupported, got ${result.status}`);

    const render = sent.find((s) => s.channel === 'canvas:render-ghosts');
    if (render) throw new Error('canvas:render-ghosts should not be sent for unsupported proposal');
  });

  await test('reviseProposal supersedes the old proposal and creates a new one', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const first = await controller.proposeOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r-first',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    if (first.status !== 'pending') {
      throw new Error(`expected pending, got ${first.status}`);
    }

    const revised = await controller.reviseProposal(first.proposalId, {
      kind: 'create',
      elementType: 'text',
      id: 't-revised',
      x: 20,
      y: 20,
      width: 60,
      height: 20,
      text: 'revised',
    });

    if (revised.status !== 'pending') {
      throw new Error(`expected pending, got ${revised.status}`);
    }
    if (revised.proposalId === first.proposalId) throw new Error('revise should create a new proposal id');

    const clears = sent.filter((s) => s.channel === 'canvas:clear-ghosts');
    const renders = sent.filter((s) => s.channel === 'canvas:render-ghosts');
    if (clears.length < 1) throw new Error('expected at least one clear-ghosts for superseded proposal');
    if (renders.length !== 2) throw new Error(`expected 2 render-ghosts, got ${renders.length}`);

    const proposals = controller.getProposals();
    if (proposals.get(first.proposalId)?.status !== 'cancelled') {
      throw new Error('original proposal should be cancelled');
    }
  });

  await test('confirmProposal can commit a proposed delete operation', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const proposed = await controller.proposeOperation({
      kind: 'delete',
      ids: ['a'],
    });
    if (proposed.status !== 'pending') {
      throw new Error(`expected pending for delete proposal, got ${proposed.status}`);
    }

    const confirmPromise = controller.confirmProposal(proposed.proposalId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const apply = sent.find((s) => s.channel === 'canvas:apply-scene');
    if (!apply) throw new Error('canvas:apply-scene was not sent on delete confirm');
    if (apply.data.operations[0].kind !== 'delete') throw new Error('expected delete operation');

    controller.handleApplyResponse({
      requestId: apply.data.requestId,
      result: { status: 'applied', sceneVersion: 2, affectedIds: ['a'], affectedCount: 1 },
    });

    const result = await confirmPromise;
    if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
  });

  await test('proposeOperation supersedes an existing active proposal', async () => {
    const { controller, wm } = createController();
    const sent = captureSend(wm);

    const first = await controller.proposeOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r-first2',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    if (first.status !== 'pending') {
      throw new Error(`expected pending, got ${first.status}`);
    }

    await controller.proposeOperation({
      kind: 'create',
      elementType: 'text',
      id: 't-second',
      x: 30,
      y: 30,
      width: 50,
      height: 20,
      text: 'second',
    });

    const clears = sent.filter((s) => s.channel === 'canvas:clear-ghosts');
    if (clears.length < 1) throw new Error('expected clear-ghosts for superseded proposal');
    if (clears[0].data.proposalId !== first.proposalId) throw new Error('superseded clear id mismatch');
  });

  console.log('\n🎉 ExcalidrawController S4 proposal tests passed');
})();
