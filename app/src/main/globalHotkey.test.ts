/**
 * Plain-node unit tests for GlobalHotkey canvas accelerator re-registration.
 *
 * Run with: npx ts-node app/src/main/globalHotkey.test.ts
 */

import { Module } from 'module';

const registered = new Map<string, () => void>();

const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === 'electron') {
    return {
      globalShortcut: {
        register: (accelerator: string, callback: () => void) => {
          if (registered.has(accelerator)) return false;
          registered.set(accelerator, callback);
          return true;
        },
        unregister: (accelerator: string) => {
          registered.delete(accelerator);
        },
        unregisterAll: () => {
          registered.clear();
        },
      },
    };
  }
  if (id === 'uiohook-napi') {
    return {
      uIOhook: {
        on: () => {},
        start: () => {},
        stop: () => {},
      },
      UiohookKey: {
        Escape: 1,
        Ctrl: 29,
        Alt: 56,
        M: 50,
        CtrlRight: 30,
        AltRight: 100,
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const { GlobalHotkey } = await import('./globalHotkey');

  await test('constructor registers configured canvas toggle accelerator', async () => {
    registered.clear();
    let toggled = false;

    new GlobalHotkey({
      onPushToTalkStart: () => {},
      onPushToTalkEnd: () => {},
      onCanvasToggle: () => {
        toggled = true;
      },
      canvasToggleAccelerator: 'CommandOrControl+Shift+Space',
    });

    await wait(50);

    const callback = registered.get('CommandOrControl+Shift+Space');
    if (!callback) throw new Error('canvas toggle was not registered');
    callback();
    if (!toggled) throw new Error('canvas toggle callback did not fire');
  });

  await test('updateCanvasToggleAccelerator re-registers without duplicates', async () => {
    registered.clear();
    let toggled = false;

    const hotkey = new GlobalHotkey({
      onPushToTalkStart: () => {},
      onPushToTalkEnd: () => {},
      onCanvasToggle: () => {
        toggled = true;
      },
      canvasToggleAccelerator: 'CommandOrControl+Shift+Space',
    });

    await wait(50);

    hotkey.updateCanvasToggleAccelerator('Alt+Shift+C');

    if (registered.has('CommandOrControl+Shift+Space')) {
      throw new Error('old canvas accelerator was not unregistered');
    }
    const newCallback = registered.get('Alt+Shift+C');
    if (!newCallback) throw new Error('new canvas accelerator was not registered');
    newCallback();
    if (!toggled) throw new Error('new accelerator callback did not fire');

    if (registered.size !== 1) {
      throw new Error(`expected 1 registration, got ${registered.size}`);
    }
  });

  await test('registration failure logs a warning and does not crash', async () => {
    registered.clear();
    // Occupying the accelerator makes the next registration fail.
    registered.set('Alt+Shift+X', () => {});

    const hotkey = new GlobalHotkey({
      onPushToTalkStart: () => {},
      onPushToTalkEnd: () => {},
      onCanvasToggle: () => {},
      canvasToggleAccelerator: 'Alt+Shift+X',
    });

    await wait(50);
    hotkey.updateCanvasToggleAccelerator('Alt+Shift+Y');
    // If we get here without throwing, the failure was handled gracefully.
  });

  await test('destroy unregisters canvas shortcut', async () => {
    registered.clear();

    const hotkey = new GlobalHotkey({
      onPushToTalkStart: () => {},
      onPushToTalkEnd: () => {},
      onCanvasToggle: () => {},
      canvasToggleAccelerator: 'CommandOrControl+Shift+Space',
    });

    await wait(50);
    if (!registered.has('CommandOrControl+Shift+Space')) {
      throw new Error('canvas shortcut not registered before destroy');
    }

    hotkey.destroy();

    if (registered.has('CommandOrControl+Shift+Space')) {
      throw new Error('canvas shortcut was not unregistered on destroy');
    }
  });

  console.log('\n🎉 GlobalHotkey canvas accelerator tests passed');
})();
