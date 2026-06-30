/**
 * Manual unit tests for ExcalidrawController S2/S3 behavior.
 *
 * Run with: npx ts-node app/src/main/excalidraw/ExcalidrawController.test.ts
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

  await test('startSession opens canvas and shows listening HUD', async () => {
    const wm = new ExcalidrawWindowManager();
    let opened = false;
    let sentHUD: any = null;
    wm.openOrFocus = async () => {
      opened = true;
      return wm.getWindow() as any;
    };
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      if (channel === 'canvas:hud') sentHUD = data;
    };

    const controller = new ExcalidrawController({ windowManager: wm });
    await controller.startSession();

    if (!opened) throw new Error('canvas was not opened');
    if (!controller.getSessionState().isActive) throw new Error('session not active');
    if (controller.getSessionState().hudState !== 'listening') throw new Error('HUD not listening');
    if (sentHUD?.state !== 'listening') throw new Error('HUD payload not sent');
  });

  await test('startSession unmutes when muted and restores mute on end', async () => {
    const wm = new ExcalidrawWindowManager();
    wm.openOrFocus = async () => wm.getWindow() as any;
    let muted = true;
    const controller = new ExcalidrawController({
      windowManager: wm,
      getMuted: () => muted,
      toggleMute: () => {
        muted = !muted;
        return muted;
      },
    });

    await controller.startSession();
    if (muted) throw new Error('did not unmute on start');
    if (!controller.getSessionState().isActive) throw new Error('session not active');

    await controller.endSession();
    if (!muted) throw new Error('did not restore mute on end');
    if (controller.getSessionState().isActive) throw new Error('session still active');
    if (controller.getSessionState().hudState !== 'idle') throw new Error('HUD not idle');
  });

  await test('toggleSession toggles on/off and keeps canvas open', async () => {
    const wm = new ExcalidrawWindowManager();
    let openCount = 0;
    let destroyCount = 0;
    wm.openOrFocus = async () => {
      openCount++;
      return wm.getWindow() as any;
    };
    (wm as any).destroy = () => {
      destroyCount++;
    };

    const controller = new ExcalidrawController({ windowManager: wm });
    const afterStart = await controller.toggleSession();
    if (!afterStart) throw new Error('did not start');

    const afterEnd = await controller.toggleSession();
    if (afterEnd) throw new Error('did not end');

    if (openCount !== 1) throw new Error(`expected 1 open, got ${openCount}`);
    if (destroyCount !== 0) throw new Error('canvas destroyed on session end');
  });

  await test('startSession without callbacks warns but stays active', async () => {
    const wm = new ExcalidrawWindowManager();
    wm.openOrFocus = async () => wm.getWindow() as any;
    const controller = new ExcalidrawController({ windowManager: wm });
    await controller.startSession();
    if (!controller.getSessionState().isActive) throw new Error('session should be active');
  });

  // ── S3 applyOperation tests ────────────────────────────────────────────────

  await test('applyOperation create sends canvas:apply-scene and resolves', async () => {
    const wm = new ExcalidrawWindowManager();
    let opened = false;
    let applyRequest: any = null;
    wm.openOrFocus = async () => {
      opened = true;
      return wm.getWindow() as any;
    };
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      if (channel === 'canvas:apply-scene') applyRequest = data;
    };

    const controller = new ExcalidrawController({ windowManager: wm, timeoutMs: 500 });
    controller.onSceneChange(makeScene());

    const pending = controller.applyOperation({
      kind: 'create',
      elementType: 'rectangle',
      id: 'r-new',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    });

    // Wait for the async openOrFocus + sendToCanvas to run.
    await new Promise((resolve) => setTimeout(resolve, 10));

    if (!opened) throw new Error('canvas was not opened before apply');
    if (!applyRequest) throw new Error('canvas:apply-scene was not sent');
    if (applyRequest.operations[0].kind !== 'create') throw new Error('expected create operation');

    controller.handleApplyResponse({
      requestId: applyRequest.requestId,
      result: { status: 'applied', sceneVersion: 2, affectedIds: ['r-new'], affectedCount: 1 },
    });

    const result = await pending;
    if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
    if (result.affectedCount !== 1) throw new Error(`expected affectedCount 1, got ${result.affectedCount}`);
  });

  await test('applyOperation delete is blocked without sending IPC', async () => {
    const wm = new ExcalidrawWindowManager();
    let applyRequest: any = null;
    wm.openOrFocus = async () => wm.getWindow() as any;
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      if (channel === 'canvas:apply-scene') applyRequest = data;
    };

    const controller = new ExcalidrawController({ windowManager: wm });
    controller.onSceneChange(makeScene());

    const result = await controller.applyOperation({ kind: 'delete', ids: ['a'] });
    if (result.status !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.status}`);
    }
    if (applyRequest) throw new Error('canvas:apply-scene should not be sent for delete');
  });

  await test('applyOperation update missing id returns not_found without IPC', async () => {
    const wm = new ExcalidrawWindowManager();
    let applyRequest: any = null;
    wm.openOrFocus = async () => wm.getWindow() as any;
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      if (channel === 'canvas:apply-scene') applyRequest = data;
    };

    const controller = new ExcalidrawController({ windowManager: wm });
    controller.onSceneChange(makeScene());

    const result = await controller.applyOperation({
      kind: 'update',
      ids: ['missing'],
      changes: { strokeColor: '#ff0000' },
    });
    if (result.status !== 'not_found') throw new Error(`expected not_found, got ${result.status}`);
    if (applyRequest) throw new Error('canvas:apply-scene should not be sent for not_found');
  });

  await test('applyOperation importScene returns unsupported without IPC', async () => {
    const wm = new ExcalidrawWindowManager();
    let applyRequest: any = null;
    wm.openOrFocus = async () => wm.getWindow() as any;
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      if (channel === 'canvas:apply-scene') applyRequest = data;
    };

    const controller = new ExcalidrawController({ windowManager: wm });
    controller.onSceneChange(makeScene());

    const result = await controller.applyOperation({
      kind: 'importScene',
      source: { type: 'file', path: '/tmp/foo.excalidraw' },
    });
    if (result.status !== 'unsupported') throw new Error(`expected unsupported, got ${result.status}`);
    if (applyRequest) throw new Error('canvas:apply-scene should not be sent for importScene');
  });

  await test('applyOperation clearCanvas returns requires_confirmation without IPC', async () => {
    const wm = new ExcalidrawWindowManager();
    let applyRequest: any = null;
    wm.openOrFocus = async () => wm.getWindow() as any;
    (wm as any).sendToCanvas = (channel: string, data: any) => {
      if (channel === 'canvas:apply-scene') applyRequest = data;
    };

    const controller = new ExcalidrawController({ windowManager: wm });
    controller.onSceneChange(makeScene());

    const result = await controller.applyOperation({ kind: 'clearCanvas' });
    if (result.status !== 'requires_confirmation') {
      throw new Error(`expected requires_confirmation, got ${result.status}`);
    }
    if (applyRequest) throw new Error('canvas:apply-scene should not be sent for clearCanvas');
  });

  console.log('\n🎉 ExcalidrawController S2/S3 tests passed');
})();
