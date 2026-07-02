/**
 * Bud — Global Hotkey Manager
 *
 * Registers the Excalidraw canvas-session toggle via Electron's `globalShortcut`.
 * The voice input modes (push-to-talk / always-on / Escape) are handled by
 * `VoiceInputManager` using a native keyboard hook, not here — `globalShortcut`
 * cannot detect key release or bare modifiers.
 */
import { globalShortcut } from 'electron';

interface GlobalHotkeyOptions {
  /** Called when the canvas voice-session toggle hotkey is pressed. */
  onCanvasToggle: () => void;
  /** Accelerator for the canvas toggle. Default: CommandOrControl+Shift+Space. */
  canvasToggleAccelerator?: string;
}

export class GlobalHotkey {
  private canvasToggleAccelerator: string;
  private onCanvasToggle: () => void;

  constructor(options: GlobalHotkeyOptions) {
    this.onCanvasToggle = options.onCanvasToggle;
    this.canvasToggleAccelerator = options.canvasToggleAccelerator || 'CommandOrControl+Shift+Space';
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
  }
}
