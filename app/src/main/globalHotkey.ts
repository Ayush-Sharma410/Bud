/**
 * Bud — Global Hotkey Manager
 *
 * Cross-platform (Windows, macOS, Linux) via Electron's globalShortcut.
 * Registers the canvas voice-session toggle and the mute toggle.
 */
import { globalShortcut } from 'electron';

interface GlobalHotkeyOptions {
  /** Called when the canvas voice-session toggle hotkey is pressed. */
  onCanvasToggle: () => void;
  /** Called when the mute toggle hotkey is pressed. */
  onMuteToggle: () => void;
  /** Accelerator for the canvas toggle. Default: CommandOrControl+Shift+Space. */
  canvasToggleAccelerator?: string;
  /** Accelerator for the mute toggle. Default: CommandOrControl+Alt+M. */
  muteToggleAccelerator?: string;
}

export class GlobalHotkey {
  private canvasToggleAccelerator: string;
  private muteToggleAccelerator: string;
  private onCanvasToggle: () => void;
  private onMuteToggle: () => void;

  constructor(options: GlobalHotkeyOptions) {
    this.onCanvasToggle = options.onCanvasToggle;
    this.onMuteToggle = options.onMuteToggle;
    this.canvasToggleAccelerator = options.canvasToggleAccelerator || 'CommandOrControl+Shift+Space';
    this.muteToggleAccelerator = options.muteToggleAccelerator || 'CommandOrControl+Alt+M';
    this.register();
  }

  private register() {
    const canvasOk = globalShortcut.register(this.canvasToggleAccelerator, () => this.onCanvasToggle());
    if (!canvasOk) {
      console.warn(
        `⚠️ Failed to register canvas toggle hotkey: ${this.canvasToggleAccelerator}. It may be bound by the OS or another app. Remap it in settings.`
      );
    } else {
      console.log(`🎨 Canvas toggle hotkey registered: ${this.canvasToggleAccelerator}`);
    }

    const muteOk = globalShortcut.register(this.muteToggleAccelerator, () => this.onMuteToggle());
    if (!muteOk) {
      console.warn(`⚠️ Failed to register mute hotkey: ${this.muteToggleAccelerator}.`);
    } else {
      console.log(`🔇 Mute toggle hotkey registered: ${this.muteToggleAccelerator}`);
    }
  }

  /**
   * Update the canvas toggle accelerator at runtime.
   * Unregisters the old accelerator and registers the new one cleanly.
   */
  updateCanvasToggleAccelerator(accelerator: string): void {
    if (this.canvasToggleAccelerator === accelerator) {
      console.log(`🎨 Canvas toggle hotkey unchanged: ${accelerator}`);
      return;
    }
    try { globalShortcut.unregister(this.canvasToggleAccelerator); } catch { /* not registered */ }
    this.canvasToggleAccelerator = accelerator;
    globalShortcut.register(accelerator, () => this.onCanvasToggle());
    console.log(`🎨 Canvas toggle hotkey updated: ${accelerator}`);
  }

  destroy() {
    try { globalShortcut.unregister(this.canvasToggleAccelerator); } catch { /* not registered */ }
    try { globalShortcut.unregister(this.muteToggleAccelerator); } catch { /* not registered */ }
  }
}
