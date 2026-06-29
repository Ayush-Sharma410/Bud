/**
 * Regression harness for AnnotationController coordinate math.
 *
 * Mocks Electron's screen API and verifies that screenshot-pixel coordinates
 * are converted to the correct logical overlay client coordinates.
 */

import { Module } from 'module';

// ── Manual module mock for Electron ───────────────────────────

interface MockDisplay {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  size: { width: number; height: number };
  scaleFactor: number;
  workArea: { x: number; y: number; width: number; height: number };
  workAreaSize: { width: number; height: number };
}

let mockDisplays: MockDisplay[] = [];
let mockCursor = { x: 0, y: 0 };

const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === 'electron') {
    return {
      screen: {
        getAllDisplays: () => mockDisplays,
        getCursorScreenPoint: () => mockCursor,
        getDisplayNearestPoint: (point: { x: number; y: number }) => {
          return (
            mockDisplays.find(
              (d) =>
                point.x >= d.bounds.x &&
                point.x < d.bounds.x + d.bounds.width &&
                point.y >= d.bounds.y &&
                point.y < d.bounds.y + d.bounds.height
            ) || mockDisplays[0]
          );
        },
      },
      BrowserWindow: class MockBrowserWindow {
        isDestroyed() {
          return false;
        }
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

// ── Load controller AFTER installing the mock ─────────────────

const { AnnotationController } = require('./AnnotationController');

// ── Helpers ───────────────────────────────────────────────────

function makeController(captureSend?: (data: any) => void) {
  let lastData: any = null;
  const mockOverlayWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  };
  return {
    controller: new AnnotationController({
      sendToOverlay: (_channel: string, data: any) => {
        lastData = data;
        captureSend?.(data);
      },
      getOverlayWindow: () => mockOverlayWindow as any,
    }),
    getLastData: () => lastData,
  };
}

function makeControllerWithMocks(
  captureSend: (data: any) => void,
  gridLocator: any,
  captureScreensFn: () => Promise<any>,
) {
  let lastData: any = null;
  const mockOverlayWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  };
  return {
    controller: new AnnotationController({
      sendToOverlay: (_channel: string, data: any) => {
        lastData = data;
        captureSend(data);
      },
      getOverlayWindow: () => mockOverlayWindow as any,
      gridLocator,
      captureScreensFn,
    }),
    getLastData: () => lastData,
  };
}

function assertEqual(actual: number, expected: number, label: string) {
  if (Math.abs(actual - expected) > 0.001) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

// ── Tests ─────────────────────────────────────────────────────

async function runTests() {
  let failed = 0;
  let passed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err: any) {
      console.log(`❌ ${name}: ${err.message}`);
      failed++;
    }
  }

  await test('high-DPI single monitor: physical coords scaled to logical overlay coords', async () => {
    // 4K display at 200% scaling. Electron's display.size/bounds are logical/DIP;
    // the actual screenshot (physical) pixels are size * scaleFactor.
    mockDisplays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: 960, y: 540 };

    const { controller, getLastData } = makeController();
    await controller.render({
      annotations: [{ type: 'point', x: 2000, y: 1000 }],
    });

    const ann = getLastData()?.annotations?.[0];
    if (!ann) throw new Error('no annotation emitted');

    // Physical (2000,1000) at 200% => logical (1000,500)
    // Overlay window starts at combined bounds origin (0,0), so client coords are the same.
    assertEqual(ann.overlayX, 1000, 'overlayX');
    assertEqual(ann.overlayY, 500, 'overlayY');
  });

  await test('multi-monitor with negative origin: offset to combined bounds origin', async () => {
    // Display 0 to the left of display 1
    mockDisplays = [
      {
        id: 1,
        bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
        workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
      {
        id: 2,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: -960, y: 540 };

    const { controller, getLastData } = makeController();
    await controller.render({
      annotations: [{ type: 'point', screenIndex: 0, x: 500, y: 300 }],
    });

    const ann = getLastData()?.annotations?.[0];
    if (!ann) throw new Error('no annotation emitted');

    // Screen logical x = -1920 + 500 = -1420
    // Combined bounds origin = -1920
    // Overlay client x = -1420 - (-1920) = 500
    assertEqual(ann.overlayX, 500, 'overlayX');
    assertEqual(ann.overlayY, 300, 'overlayY');
  });

  await test('high-DPI + negative origin: both scale and offset applied', async () => {
    mockDisplays = [
      {
        id: 1,
        bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: -960, y: 540 };

    const { controller, getLastData } = makeController();
    await controller.render({
      annotations: [{ type: 'point', x: 1000, y: 600 }],
    });

    const ann = getLastData()?.annotations?.[0];
    if (!ann) throw new Error('no annotation emitted');

    // Physical (1000,600) at 200% => logical (500,300)
    // Screen logical x = -1920 + 500 = -1420
    // Overlay client x = -1420 - (-1920) = 500
    assertEqual(ann.overlayX, 500, 'overlayX');
    assertEqual(ann.overlayY, 300, 'overlayY');
  });

  await test('arrow end points are also transformed', async () => {
    mockDisplays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: 960, y: 540 };

    const { controller, getLastData } = makeController();
    await controller.render({
      annotations: [{ type: 'arrow', x: 400, y: 300, endX: 800, endY: 600 }],
    });

    const ann = getLastData()?.annotations?.[0];
    if (!ann) throw new Error('no annotation emitted');

    assertEqual(ann.overlayX, 200, 'overlayX (tail)');
    assertEqual(ann.overlayY, 150, 'overlayY (tail)');
    assertEqual(ann.overlayEndX, 400, 'overlayEndX (head)');
    assertEqual(ann.overlayEndY, 300, 'overlayEndY (head)');
  });

  await test('arrow default length is 60 logical pixels regardless of scale', async () => {
    mockDisplays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: 960, y: 540 };

    const { controller, getLastData } = makeController();
    await controller.render({
      annotations: [{ type: 'arrow', x: 400, y: 300 }],
    });

    const ann = getLastData()?.annotations?.[0];
    if (!ann) throw new Error('no annotation emitted');

    assertEqual(ann.overlayX, 200, 'overlayX (tail)');
    assertEqual(ann.overlayY, 150, 'overlayY (tail)');
    assertEqual(ann.endX, 260, 'endX (tail logical + 60)');
    assertEqual(ann.endY, 210, 'endY (tail logical + 60)');
  });

  await test('circle and rectangle sizes are scaled from screenshot pixels', async () => {
    mockDisplays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: 960, y: 540 };

    const { controller, getLastData } = makeController();
    await controller.render({
      annotations: [
        { type: 'circle', x: 400, y: 300, radius: 100 },
        { type: 'rectangle', x: 400, y: 300, width: 200, height: 100 },
      ],
    });

    const [circle, rect] = getLastData()?.annotations || [];
    if (!circle || !rect) throw new Error('annotations not emitted');

    assertEqual(circle.radius, 50, 'circle radius scaled');
    assertEqual(rect.width, 100, 'rectangle width scaled');
    assertEqual(rect.height, 50, 'rectangle height scaled');
  });

  await test('target field: grid locator resolves coordinates, cursor flies to found position', async () => {
    mockDisplays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: 960, y: 540 };

    let locateCallCount = 0;
    const mockGridLocator = {
      locate: async (_b64: string, _w: number, _h: number, query: string) => {
        locateCallCount++;
        if (query === 'the save button') return { x: 2000, y: 1000 };
        return null;
      },
    };

    const mockCaptureScreensFn = async () => [
      {
        screenIndex: 0,
        width: 3840,
        height: 2160,
        scaleFactor: 2,
        isCursorScreen: true,
        imageBase64: 'fake-base64-data',
      },
    ];

    const { controller, getLastData } = makeControllerWithMocks(
      (_data: any) => {},
      mockGridLocator,
      mockCaptureScreensFn,
    );

    await controller.render({
      annotations: [{ type: 'point', target: 'the save button' }],
    });

    assertEqual(locateCallCount, 1, 'grid locator called once');

    const ann = getLastData()?.annotations?.[0];
    if (!ann) throw new Error('no annotation emitted');

    // Grid locator returned physical (2000,1000) at 200% => logical (1000,500)
    assertEqual(ann.overlayX, 1000, 'overlayX from grid locator');
    assertEqual(ann.overlayY, 500, 'overlayY from grid locator');
  });

  await test('target field: grid locator returns null -> annotation skipped', async () => {
    mockDisplays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: 960, y: 540 };

    const mockGridLocator = {
      locate: async () => null,
    };

    const mockCaptureScreensFn = async () => [
      {
        screenIndex: 0,
        width: 1920,
        height: 1080,
        scaleFactor: 1,
        isCursorScreen: true,
        imageBase64: 'fake-base64-data',
      },
    ];

    const { controller, getLastData } = makeControllerWithMocks(
      (_data: any) => {},
      mockGridLocator,
      mockCaptureScreensFn,
    );

    const result = await controller.render({
      annotations: [{ type: 'point', target: 'nonexistent element' }],
    });

    if (result.success !== true) throw new Error('render should succeed');
    assertEqual(result.count, 0, 'zero annotations emitted');
    if (getLastData())
      throw new Error('should not have sent data to overlay');
  });

  await test('target field: explicit x/y still works (backward compatible)', async () => {
    mockDisplays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        workAreaSize: { width: 1920, height: 1040 },
      },
    ];
    mockCursor = { x: 960, y: 540 };

    let locateCallCount = 0;
    const mockGridLocator = {
      locate: async () => {
        locateCallCount++;
        return { x: 0, y: 0 };
      },
    };

    const mockCaptureScreensFn = async () => [];

    const { controller, getLastData } = makeControllerWithMocks(
      (_data: any) => {},
      mockGridLocator,
      mockCaptureScreensFn,
    );

    await controller.render({
      annotations: [{ type: 'point', x: 2000, y: 1000 }],
    });

    assertEqual(locateCallCount, 0, 'grid locator NOT called when x/y provided');

    const ann = getLastData()?.annotations?.[0];
    if (!ann) throw new Error('no annotation emitted');

    assertEqual(ann.overlayX, 1000, 'overlayX from explicit x/y');
    assertEqual(ann.overlayY, 500, 'overlayY from explicit x/y');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
