/**
 * Bud — Action Executor
 *
 * Translates parsed action objects into physical input events on Windows.
 * Uses @nut-tree/nut-js for mouse/keyboard control and child_process for
 * app launching.
 *
 * Supports an injectable backend interface for testing — swap in a mock
 * recorder instead of the real nut-js to assert API calls without moving
 * the actual mouse.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { ParsedAction } from './actionParser';

const execAsync = promisify(exec);

// --- Backend Interface (for testability) ---

export interface ActionBackend {
  mouseMove(x: number, y: number): Promise<void>;
  mouseClick(button: 'left' | 'right'): Promise<void>;
  mouseDoubleClick(button: 'left'): Promise<void>;
  mouseScroll(direction: 'up' | 'down', amount: number): Promise<void>;
  keyType(text: string): Promise<void>;
  keyPress(keys: string[]): Promise<void>;
  keyRelease(keys: string[]): Promise<void>;
}

// --- nut-js Backend ---

class NutJSBackend implements ActionBackend {
  private nutMouse: any = null;
  private nutKeyboard: any = null;
  private nutButton: any = null;
  private nutKey: any = null;
  private initialized = false;

  private async init() {
    if (this.initialized) return;
    try {
      const nutjs = require('@nut-tree-fork/nut-js');
      this.nutMouse = nutjs.mouse;
      this.nutKeyboard = nutjs.keyboard;
      this.nutButton = nutjs.Button;
      this.nutKey = nutjs.Key;

      // Configure nut-js for speed
      if (this.nutMouse) {
        this.nutMouse.config.autoDelayMs = 0;
        this.nutMouse.config.mouseSpeed = 2000; // pixels per second — fast
      }
      if (this.nutKeyboard) {
        this.nutKeyboard.config.autoDelayMs = 0;
      }

      this.initialized = true;
      console.log('🤖 nut-js initialized for action execution');
    } catch (err) {
      console.error('⚠️ Failed to initialize nut-js:', err);
      throw err;
    }
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.init();
    const { Point } = require('@nut-tree-fork/nut-js');
    await this.nutMouse.setPosition(new Point(x, y));
  }

  async mouseClick(button: 'left' | 'right'): Promise<void> {
    await this.init();
    const btn = button === 'right' ? this.nutButton.RIGHT : this.nutButton.LEFT;
    await this.nutMouse.click(btn);
  }

  async mouseDoubleClick(button: 'left'): Promise<void> {
    await this.init();
    await this.nutMouse.doubleClick(this.nutButton.LEFT);
  }

  async mouseScroll(direction: 'up' | 'down', amount: number): Promise<void> {
    await this.init();
    if (direction === 'down') {
      await this.nutMouse.scrollDown(amount);
    } else {
      await this.nutMouse.scrollUp(amount);
    }
  }

  async keyType(text: string): Promise<void> {
    await this.init();
    await this.nutKeyboard.type(text);
  }

  async keyPress(keys: string[]): Promise<void> {
    await this.init();
    for (const key of keys) {
      const mapped = this.resolveKey(key);
      await this.nutKeyboard.pressKey(mapped);
    }
  }

  async keyRelease(keys: string[]): Promise<void> {
    await this.init();
    for (const key of keys) {
      const mapped = this.resolveKey(key);
      await this.nutKeyboard.releaseKey(mapped);
    }
  }

  /**
   * Map a human-readable key name to a nut-js Key enum value.
   * Handles common aliases (Ctrl, Alt, Shift, Win, Enter, etc.).
   */
  private resolveKey(keyName: string): any {
    const normalized = keyName.trim().toLowerCase();
    const keyMap: Record<string, string> = {
      'ctrl': 'LeftControl',
      'control': 'LeftControl',
      'alt': 'LeftAlt',
      'shift': 'LeftShift',
      'win': 'LeftWin',
      'windows': 'LeftWin',
      'cmd': 'LeftWin',
      'enter': 'Return',
      'return': 'Return',
      'tab': 'Tab',
      'escape': 'Escape',
      'esc': 'Escape',
      'backspace': 'Backspace',
      'delete': 'Delete',
      'space': 'Space',
      'up': 'Up',
      'down': 'Down',
      'left': 'Left',
      'right': 'Right',
      'home': 'Home',
      'end': 'End',
      'pageup': 'PageUp',
      'pagedown': 'PageDown',
      'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4',
      'f5': 'F5', 'f6': 'F6', 'f7': 'F7', 'f8': 'F8',
      'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
    };

    const mappedName = keyMap[normalized] || keyName;

    // Try to find the key in nut-js Key enum
    if (this.nutKey[mappedName]) {
      return this.nutKey[mappedName];
    }

    // Try uppercase single character (e.g., 'a' → 'A')
    if (keyName.length === 1) {
      const upper = keyName.toUpperCase();
      if (this.nutKey[upper]) {
        return this.nutKey[upper];
      }
    }

    console.warn(`⚠️ Unknown key: "${keyName}", attempting direct lookup`);
    return this.nutKey[keyName] || keyName;
  }
}

// --- Action Executor ---

export class ActionExecutor {
  private backend: ActionBackend;

  constructor(backend?: ActionBackend) {
    this.backend = backend || new NutJSBackend();
  }

  /**
   * Execute a parsed action. Returns when the action is complete.
   * Throws on failure.
   */
  async execute(action: ParsedAction): Promise<{ stdout?: string; stderr?: string } | void> {
    console.log(`🤖 Executing: ${action.type} — ${action.label}`);

    let targetX = 0;
    let targetY = 0;

    if ('x' in action && 'y' in action) {
      try {
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const scale = primaryDisplay.scaleFactor || 1;
        targetX = Math.round(action.x / scale);
        targetY = Math.round(action.y / scale);
        console.log(`📐 High-DPI coordinate scaling: (${action.x}, ${action.y}) -> logical (${targetX}, ${targetY}) at scale ${scale}`);
      } catch (err) {
        // Fallback for tests/environments without electron screen API
        targetX = action.x;
        targetY = action.y;
      }
    }

    switch (action.type) {
      case 'click':
        await this.backend.mouseMove(targetX, targetY);
        await this.backend.mouseClick('left');
        break;

      case 'double_click':
        await this.backend.mouseMove(targetX, targetY);
        await this.backend.mouseDoubleClick('left');
        break;

      case 'right_click':
        await this.backend.mouseMove(targetX, targetY);
        await this.backend.mouseClick('right');
        break;

      case 'type':
        await this.backend.keyType(action.text);
        break;

      case 'press':
        await this.executeKeyCombo(action.key);
        break;

      case 'scroll':
        await this.backend.mouseMove(targetX, targetY);
        await this.backend.mouseScroll(action.direction, action.amount);
        break;

      case 'wait':
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        break;

      case 'launch':
        await this.launchApp(action.target);
        break;

      case 'shell':
        return await this.shellExec(action.command);

      case 'done':
        // No-op — signals task completion
        console.log(`✅ Task done: ${action.summary}`);
        break;
    }
  }

  /**
   * Execute a key combination like "Ctrl+T" or a single key like "Enter".
   */
  private async executeKeyCombo(keyCombo: string): Promise<void> {
    const keys = keyCombo.split('+').map((k) => k.trim());

    if (keys.length === 1) {
      // Single key press
      await this.backend.keyPress(keys);
      await this.backend.keyRelease(keys);
    } else {
      // Combo: press all keys, then release in reverse order
      await this.backend.keyPress(keys);
      await this.backend.keyRelease([...keys].reverse());
    }
  }

  /**
   * Launch an application via Windows shell.
   * Uses `start ""` which resolves app names from PATH and Start menu.
   */
  private launchApp(appName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use Windows `start` command — works with app names, paths, and URLs
      const command = `start "" "${appName}"`;
      console.log(`🚀 Launching: ${command}`);

      exec(command, { shell: 'cmd.exe' }, (error) => {
        if (error) {
          console.error(`⚠️ Launch failed: ${appName}`, error);
          reject(error);
        } else {
          console.log(`✅ Launched: ${appName}`);
          // Give the app a moment to open
          setTimeout(resolve, 1000);
        }
      });
    });
  }

  /**
   * Execute a PowerShell command.
   * Returns stdout for the agent to see in its next iteration.
   */
  private async shellExec(command: string): Promise<{ stdout: string; stderr: string }> {
    console.log(`🐚 Shell: ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command, {
        shell: 'powershell.exe',
        timeout: 30000,
      });
      if (stdout.trim()) {
        console.log(`🐚 Shell stdout: ${stdout.trim().substring(0, 200)}`);
      }
      if (stderr.trim()) {
        console.warn(`🐚 Shell stderr: ${stderr.trim().substring(0, 200)}`);
      }
      // Give the launched app a moment to appear
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err: any) {
      console.error(`⚠️ Shell exec failed:`, err);
      // Return the error output instead of throwing — the model needs to see failures
      return {
        stdout: err.stdout?.trim() || '',
        stderr: err.stderr?.trim() || err.message || String(err),
      };
    }
  }
}
