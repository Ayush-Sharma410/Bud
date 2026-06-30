/**
 * Bud — Global Hotkey Manager
 *
 * Captures the push-to-talk hotkey (Ctrl+Alt) globally,
 * even when Bud is not the focused application.
 *
 * Uses uiohook-napi for low-level keyboard hooks that can detect
 * modifier-only key combinations.
 *
 * Replaces: GlobalPushToTalkShortcutMonitor.swift
 */

interface GlobalHotkeyOptions {
  onPushToTalkStart: () => void;
  onPushToTalkEnd: () => void;
  /** Called when the Escape key is pressed — kills all Agent Tasks */
  onEscapePressed?: () => void;
  /** Called when mute toggle hotkey is pressed (Ctrl+Alt+M) */
  onMuteToggle?: () => void;
  /** Called when the canvas voice-session toggle hotkey is pressed */
  onCanvasToggle?: () => void;
  /** Accelerator for the canvas toggle. Default: CommandOrControl+Shift+Space. */
  canvasToggleAccelerator?: string;
}

export class GlobalHotkey {
  private ctrlPressed = false;
  private altPressed = false;
  private shiftPressed = false;
  private spacePressed = false;
  private mPressed = false;
  private metaPressed = false;
  private isActive = false;
  private muteToggleActive = false;
  private canvasToggleArmed = false;
  private isUiohookActive = false;
  private canvasToggleAccelerator: string;

  constructor(private options: GlobalHotkeyOptions) {
    this.canvasToggleAccelerator = options.canvasToggleAccelerator || 'CommandOrControl+Shift+Space';
    this.startListening();
  }

  private async startListening() {
    try {
      // Dynamic import to avoid issues if native module isn't built yet
      const { uIOhook, UiohookKey } = await import('uiohook-napi');

      uIOhook.on('keydown', (e) => {
        // Escape key — instant kill switch for Agent Tasks
        if (e.keycode === UiohookKey.Escape) {
          this.options.onEscapePressed?.();
        }

        if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) {
          this.ctrlPressed = true;
        }
        if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
          this.altPressed = true;
        }
        if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftRight) {
          this.shiftPressed = true;
        }
        if (e.keycode === UiohookKey.Space) {
          this.spacePressed = true;
        }
        if (e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight) {
          this.metaPressed = true;
        }
        if (e.keycode === UiohookKey.M) {
          this.mPressed = true;
        }

        // Ctrl+Alt+M → mute toggle
        if (this.ctrlPressed && this.altPressed && this.mPressed && !this.muteToggleActive) {
          this.muteToggleActive = true;
          this.options.onMuteToggle?.();
        }

        // Both Ctrl+Alt pressed → start push-to-talk
        if (this.ctrlPressed && this.altPressed && !this.isActive && !this.mPressed) {
          this.isActive = true;
          this.options.onPushToTalkStart();
        }

        // CommandOrControl+Shift+Space → toggle canvas voice session
        const commandOrControl = this.ctrlPressed || this.metaPressed;
        if (commandOrControl && this.shiftPressed && this.spacePressed && !this.canvasToggleArmed) {
          this.canvasToggleArmed = true;
          this.options.onCanvasToggle?.();
        }
      });

      uIOhook.on('keyup', (e) => {
        if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) {
          this.ctrlPressed = false;
        }
        if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
          this.altPressed = false;
        }
        if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftRight) {
          this.shiftPressed = false;
        }
        if (e.keycode === UiohookKey.Space) {
          this.spacePressed = false;
        }
        if (e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight) {
          this.metaPressed = false;
        }
        if (e.keycode === UiohookKey.M) {
          this.mPressed = false;
          this.muteToggleActive = false;
        }

        // Either key released → end push-to-talk
        if (this.isActive && (!this.ctrlPressed || !this.altPressed)) {
          this.isActive = false;
          this.options.onPushToTalkEnd();
        }

        // Release of any canvas-toggle chord key resets the latch
        if (this.canvasToggleArmed && (!this.ctrlPressed && !this.metaPressed || !this.shiftPressed || !this.spacePressed)) {
          this.canvasToggleArmed = false;
        }
      });

      uIOhook.start();
      this.isUiohookActive = true;
      console.log('Global hotkey listener started (Ctrl+Alt for push-to-talk, Ctrl+Alt+M for mute toggle, Ctrl/Cmd+Shift+Space for canvas toggle)');
    } catch (err) {
      console.error('Failed to start global hotkey listener:', err);
      console.log(
        'Falling back to Electron globalShortcut (limited modifier-only support)'
      );
      this.startFallbackListener();
    }
  }

  /**
   * Fallback: Use Electron's built-in globalShortcut.
   * This won't support modifier-only combos well, but it's better than nothing.
   */
  private startFallbackListener() {
    const { globalShortcut } = require('electron');

    // Register a key combo with a dummy key since modifier-only isn't supported
    // Users can reconfigure this in settings
    globalShortcut.register('CommandOrControl+Alt+Space', () => {
      if (!this.isActive) {
        this.isActive = true;
        this.options.onPushToTalkStart();

        // Auto-stop after a timeout since we can't detect key release
        setTimeout(() => {
          if (this.isActive) {
            this.isActive = false;
            this.options.onPushToTalkEnd();
          }
        }, 10000); // 10 second max recording
      } else {
        this.isActive = false;
        this.options.onPushToTalkEnd();
      }
    });

    // Register mute toggle
    globalShortcut.register('CommandOrControl+Alt+M', () => {
      this.options.onMuteToggle?.();
    });

    // Register canvas voice-session toggle from settings
    const canvasRegistered = globalShortcut.register(this.canvasToggleAccelerator, () => {
      this.options.onCanvasToggle?.();
    });
    if (!canvasRegistered) {
      console.warn(
        `⚠️ Failed to register canvas toggle hotkey: ${this.canvasToggleAccelerator}. It may be bound by the OS or another app. Remap it in settings.`
      );
    }

    console.log(
      'Fallback hotkey registered: Ctrl+Alt+Space (toggle push-to-talk), Ctrl+Alt+M (mute toggle), ' +
        `${this.canvasToggleAccelerator} (canvas toggle)`
    );
  }

  /**
   * Update the canvas toggle accelerator at runtime.
   * In uiohook mode the default Ctrl/Cmd+Shift+Space chord is fixed, so a custom
   * accelerator only takes effect in the globalShortcut fallback path until the
   * app is restarted.
   */
  updateCanvasToggleAccelerator(accelerator: string): void {
    this.canvasToggleAccelerator = accelerator;
    if (!this.isUiohookActive) {
      try {
        const { globalShortcut } = require('electron');
        globalShortcut.unregister(accelerator);
        const registered = globalShortcut.register(accelerator, () => {
          this.options.onCanvasToggle?.();
        });
        if (!registered) {
          console.warn(
            `⚠️ Failed to register canvas toggle hotkey: ${accelerator}. It may be bound by the OS or another app.`
          );
        } else {
          console.log(`🎨 Canvas toggle hotkey updated: ${accelerator}`);
        }
      } catch (err) {
        console.warn('⚠️ Failed to update canvas toggle hotkey:', err);
      }
    } else {
      console.log(
        `🎨 Canvas toggle hotkey setting saved as ${accelerator}; restart Bud to use a custom accelerator (default Ctrl/Cmd+Shift+Space is active now).`
      );
    }
  }

  destroy() {
    try {
      const { uIOhook } = require('uiohook-napi');
      uIOhook.stop();
      this.isUiohookActive = false;
    } catch {
      const { globalShortcut } = require('electron');
      globalShortcut.unregisterAll();
    }
  }
}
