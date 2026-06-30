/**
 * Plain-node unit tests for ExcalidrawController S6 autosave + recent sessions.
 *
 * Run with: npx ts-node app/src/main/excalidraw/ExcalidrawController.autosave.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
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
        webContents = {
          send: (_channel: string, _data: any) => {},
          once: () => {},
        };
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
  const { SessionStore } = await import('./SessionStore');
  return { ExcalidrawController, ExcalidrawWindowManager, SessionStore };
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

function makeTempDir(): string {
  return path.join(os.tmpdir(), `bud-autosave-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeSnapshot(elements: any[] = []): import('./excalidrawTypes').FullSceneSnapshot {
  return {
    sceneVersion: 1,
    elements,
    appState: { theme: 'light' },
    timestamp: Date.now(),
  };
}

function makeScene(): import('./excalidrawTypes').SceneSummary {
  return {
    sceneVersion: 1,
    elementCount: 2,
    canvasSize: { width: 1000, height: 800 },
    selection: [],
    deletedCount: 0,
    elements: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      { id: 't1', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'hello world' },
    ],
  };
}

function attachFakeWindow(wm: any, controller: any) {
  const BrowserWindow = require('electron').BrowserWindow;
  const win = new BrowserWindow();
  win.webContents.send = (channel: string, data: any) => {
    if (channel === 'canvas:request-snapshot') {
      controller.handleSnapshotResponse({
        requestId: data.requestId,
        snapshot: makeSnapshot([
          { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
          { id: 't1', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'hello world' },
        ]),
      });
    }
  };
  (wm as any).window = win;
}

(async () => {
  const { ExcalidrawController, ExcalidrawWindowManager, SessionStore } = await importFresh();

  await test('autosave writes .excalidraw file and index entry', async () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 20);
    const wm = new ExcalidrawWindowManager();
    const controller = new ExcalidrawController({
      windowManager: wm,
      sessionStore: store,
      autosaveIntervalMs: 50,
      timeoutMs: 500,
    });

    attachFakeWindow(wm, controller);
    controller.onSceneChange(makeScene());

    await controller.saveNow();

    const sessions = store.getRecentSessions();
    if (sessions.length !== 1) throw new Error(`expected 1 session, got ${sessions.length}`);
    const filePath = sessions[0].filePath;
    if (!fs.existsSync(filePath)) throw new Error('.excalidraw file was not written');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const scene = JSON.parse(raw);
    if (!scene.elements || scene.elements.length !== 2) {
      throw new Error(`expected 2 elements in saved scene, got ${scene.elements?.length}`);
    }

    if (sessions[0].name !== 'hello world') {
      throw new Error(`expected name 'hello world', got '${sessions[0].name}'`);
    }

    controller.dispose();
  });

  await test('autosave skips when canvas window is closed', async () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 20);
    const wm = new ExcalidrawWindowManager();
    const controller = new ExcalidrawController({
      windowManager: wm,
      sessionStore: store,
      autosaveIntervalMs: 50,
      timeoutMs: 500,
    });

    controller.onSceneChange(makeScene());
    await controller.saveNow();

    const sessions = store.getRecentSessions();
    if (sessions.length !== 0) throw new Error(`expected no sessions when window closed, got ${sessions.length}`);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.excalidraw'));
      if (files.length !== 0) throw new Error('expected no .excalidraw files when window closed');
    }

    controller.dispose();
  });

  await test('autosave excludes ghost proposal elements', async () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 20);
    const wm = new ExcalidrawWindowManager();
    const controller = new ExcalidrawController({
      windowManager: wm,
      sessionStore: store,
      autosaveIntervalMs: 50,
      timeoutMs: 500,
    });

    const BrowserWindow = require('electron').BrowserWindow;
    const win = new BrowserWindow();
    win.webContents.send = (channel: string, data: any) => {
      if (channel === 'canvas:request-snapshot') {
        controller.handleSnapshotResponse({
          requestId: data.requestId,
          snapshot: makeSnapshot([
            { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
            {
              id: 'ghost-1',
              type: 'rectangle',
              x: 200,
              y: 200,
              width: 50,
              height: 50,
              customData: { proposalId: 'p1', ghost: true },
            },
            { id: 't1', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'kept' },
          ]),
        });
      }
    };
    (wm as any).window = win;

    controller.onSceneChange(makeScene());
    await controller.saveNow();

    const sessions = store.getRecentSessions();
    if (sessions.length !== 1) throw new Error(`expected 1 session, got ${sessions.length}`);

    const raw = fs.readFileSync(sessions[0].filePath, 'utf-8');
    const scene = JSON.parse(raw);
    const ghostIds = scene.elements.map((el: any) => el.id);
    if (ghostIds.includes('ghost-1')) throw new Error('ghost element was persisted');
    if (scene.elements.length !== 2) throw new Error(`expected 2 real elements, got ${scene.elements.length}`);
    if (sessions[0].name !== 'kept') throw new Error(`expected name 'kept', got '${sessions[0].name}'`);

    controller.dispose();
  });

  await test('getRecentSessions returns SessionStore entries without full scene', async () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 20);
    const wm = new ExcalidrawWindowManager();
    const controller = new ExcalidrawController({
      windowManager: wm,
      sessionStore: store,
      autosaveIntervalMs: 50,
      timeoutMs: 500,
    });

    attachFakeWindow(wm, controller);
    controller.onSceneChange(makeScene());
    await controller.saveNow();

    const recent = controller.getRecentSessions();
    if (recent.length !== 1) throw new Error(`expected 1 recent session, got ${recent.length}`);
    if (!recent[0].sessionId || !recent[0].name || !recent[0].filePath) {
      throw new Error('recent session missing metadata fields');
    }
    if ('elements' in recent[0]) {
      throw new Error('recent session should not expose full scene elements');
    }

    controller.dispose();
  });

  await test('autosave reuses a single session file across saves', async () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 20);
    const wm = new ExcalidrawWindowManager();
    const controller = new ExcalidrawController({
      windowManager: wm,
      sessionStore: store,
      autosaveIntervalMs: 50,
      timeoutMs: 500,
    });

    attachFakeWindow(wm, controller);
    controller.onSceneChange(makeScene());
    await controller.saveNow();

    const first = store.getRecentSessions()[0];

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.onSceneChange({ ...makeScene(), sceneVersion: 2 });
    await controller.saveNow();

    const sessions = store.getRecentSessions();
    if (sessions.length !== 1) throw new Error(`expected 1 session across saves, got ${sessions.length}`);
    if (sessions[0].filePath !== first.filePath) throw new Error('autosave should reuse the same file');
    if (sessions[0].updatedAt < first.updatedAt) throw new Error('updatedAt should advance on second save');

    controller.dispose();
  });

  await test('multiple scene changes coalesce into a single autosave per tick', async () => {
    const dir = makeTempDir();
    const store = new SessionStore(dir, 20);
    const wm = new ExcalidrawWindowManager();
    let snapshotCount = 0;

    const BrowserWindow = require('electron').BrowserWindow;
    const win = new BrowserWindow();
    win.webContents.send = (channel: string, data: any) => {
      if (channel === 'canvas:request-snapshot') {
        snapshotCount++;
        controller.handleSnapshotResponse({
          requestId: data.requestId,
          snapshot: makeSnapshot([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }]),
        });
      }
    };
    (wm as any).window = win;

    const controller = new ExcalidrawController({
      windowManager: wm,
      sessionStore: store,
      autosaveIntervalMs: 50,
      timeoutMs: 500,
    });

    controller.onSceneChange(makeScene());
    controller.onSceneChange({ ...makeScene(), sceneVersion: 2 });
    controller.onSceneChange({ ...makeScene(), sceneVersion: 3 });

    await new Promise((resolve) => setTimeout(resolve, 80));
    await controller.saveNow();

    if (snapshotCount !== 1) throw new Error(`expected 1 snapshot per tick, got ${snapshotCount}`);
    if (store.getRecentSessions().length !== 1) throw new Error('expected one saved session');

    controller.dispose();
  });

  console.log('\n🎉 ExcalidrawController S6 autosave tests passed');
})();
