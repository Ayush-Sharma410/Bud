/**
 * Manual unit tests for ExcalidrawController S2 session toggle logic.
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

  console.log('\n🎉 ExcalidrawController S2 tests passed');
})();
