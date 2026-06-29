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
}

export class GlobalHotkey {
  private ctrlPressed = false;
  private altPressed = false;
  private mPressed = false;
  private isActive = false;
  private muteToggleActive = false;

  constructor(private options: GlobalHotkeyOptions) {
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
      });

      uIOhook.on('keyup', (e) => {
        if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) {
          this.ctrlPressed = false;
        }
        if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
          this.altPressed = false;
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
      });

      uIOhook.start();
      console.log('Global hotkey listener started (Ctrl+Alt for push-to-talk, Ctrl+Alt+M for mute toggle)');
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

    console.log(
      'Fallback hotkey registered: Ctrl+Alt+Space (toggle push-to-talk), Ctrl+Alt+M (mute toggle)'
    );
  }

  destroy() {
    try {
      const { uIOhook } = require('uiohook-napi');
      uIOhook.stop();
    } catch {
      const { globalShortcut } = require('electron');
      globalShortcut.unregisterAll();
    }
  }
}
