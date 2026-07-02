/**
 * Bud — Voice Input Manager
 *
 * Drives the two voice input modes via a native global keyboard hook
 * (`uiohook-napi`), which can track press + release system-wide — something
 * Electron's `globalShortcut` cannot do.
 *
 * Modes (mutually exclusive):
 *  - `idle`      Mic off. Default at startup.
 *  - `ptt`       Push-to-talk. Hold Ctrl+Alt to listen; release to stop.
 *  - `always-on` Listen continuously. Enter with bare Ctrl x3, exit with Escape.
 *
 * The class owns the state machine only. Actual mic/STT control is delegated
 * to the Cartesia voice manager through the callbacks passed in options.
 *
 * uiohook is observe-only: it never consumes events, so other apps keep
 * receiving every key (including Escape when Bud is idle).
 */
import type { UiohookKeyboardEvent } from 'uiohook-napi';

export type VoiceMode = 'idle' | 'ptt' | 'always-on';

/** Structural subset of the uiohook-napi `UiohookKey` map that we use. */
interface KeyMap {
  Escape: number;
  Ctrl: number;
  CtrlRight: number;
  Alt: number;
  AltRight: number;
}

export interface VoiceInputManagerOptions {
  /** Mic on + PCM forwarding to STT. */
  onEnterListening: () => void;
  /** Mic off (tracks released). */
  onExitListening: () => void;
  /** Stop any in-progress response (Escape path). */
  onInterrupt: () => void;
  /** Notified on every mode change (idle / ptt / always-on). */
  onModeChange?: (mode: VoiceMode) => void;
}

/** Three bare Ctrl presses must occur within this window to enter always-on. */
const TRIPLET_WINDOW_MS = 1200;

export class VoiceInputManager {
  private mode: VoiceMode = 'idle';

  // Modifier transition state (up->down transitions only; auto-repeat ignored).
  private ctrlDown = false;
  private altDown = false;
  // Non-modifier keys currently held (everything that is not Ctrl/Alt, incl.
  // Shift/Meta). Used to avoid false PTT/trigger from modifier+key shortcuts.
  private otherKeys = new Set<number>();

  // Bare-Ctrl triplet counting.
  private ctrlPressValid = false; // is the in-flight Ctrl press a clean bare one?
  private ctrlPressTimestamps: number[] = [];

  private pttActive = false;

  // uiohook handles (set in start(); null if the native hook is unavailable).
  private keydownHandler?: (e: UiohookKeyboardEvent) => void;
  private keyupHandler?: (e: UiohookKeyboardEvent) => void;
  private hookActive = false;

  constructor(private options: VoiceInputManagerOptions) {
    this.start();
  }

  getMode(): VoiceMode {
    return this.mode;
  }

  private async start(): Promise<void> {
    try {
      const { uIOhook, UiohookKey } = await import('uiohook-napi');
      const K = UiohookKey as KeyMap;

      this.keydownHandler = (e) => this.onKeyDown(e, K);
      this.keyupHandler = (e) => this.onKeyUp(e, K);
      uIOhook.on('keydown', this.keydownHandler);
      uIOhook.on('keyup', this.keyupHandler);
      uIOhook.start();
      this.hookActive = true;
      console.log('🎙️ Voice input hook started (hold Ctrl+Alt = PTT, Ctrl x3 = always-on, Esc = exit)');
    } catch (err) {
      console.error('⚠️ Failed to start uiohook — voice input modes disabled:', err);
    }
  }

  private isCtrl(K: KeyMap, k: number): boolean {
    return k === K.Ctrl || k === K.CtrlRight;
  }

  private isAlt(K: KeyMap, k: number): boolean {
    return k === K.Alt || k === K.AltRight;
  }

  private onKeyDown(e: UiohookKeyboardEvent, K: KeyMap): void {
    const k = e.keycode;

    if (k === K.Escape) {
      this.handleEscape();
      return;
    }

    if (this.isCtrl(K, k)) {
      // Only react to a genuine up->down transition; OS key-repeat spams
      // keydown while held and must not inflate the triplet counter.
      if (!this.ctrlDown) {
        this.ctrlDown = true;
        this.ctrlPressValid = this.otherKeys.size === 0 && !this.altDown;
        this.tryStartPtt();
      }
      return;
    }

    if (this.isAlt(K, k)) {
      if (!this.altDown) {
        this.altDown = true;
        // Alt pressed while Ctrl is held turns the in-flight Ctrl press into
        // the start of a Ctrl+Alt (PTT) gesture, not a bare Ctrl press.
        if (this.ctrlDown) this.ctrlPressValid = false;
        this.tryStartPtt();
      }
      return;
    }

    // Any other key (Shift, Meta, letters, ...).
    this.otherKeys.add(k);
    if (this.ctrlDown) this.ctrlPressValid = false;
    // A non-modifier pressed during a held Ctrl+Alt is a shortcut, not talk.
    if (this.pttActive) this.stopPtt();
  }

  private onKeyUp(e: UiohookKeyboardEvent, K: KeyMap): void {
    const k = e.keycode;

    if (this.isCtrl(K, k)) {
      if (this.ctrlDown) {
        this.ctrlDown = false;
        if (this.ctrlPressValid && !this.altDown && this.otherKeys.size === 0) {
          this.registerBareCtrlPress();
        }
        if (this.pttActive) this.stopPtt();
      }
      return;
    }

    if (this.isAlt(K, k)) {
      if (this.altDown) {
        this.altDown = false;
        if (this.pttActive) this.stopPtt();
      }
      return;
    }

    this.otherKeys.delete(k);
  }

  private tryStartPtt(): void {
    // PTT is redundant while always-on is already listening.
    if (this.mode === 'always-on') return;
    if (this.pttActive) return;
    if (this.ctrlDown && this.altDown && this.otherKeys.size === 0) {
      this.pttActive = true;
      this.setMode('ptt');
      this.options.onEnterListening();
    }
  }

  private stopPtt(): void {
    if (!this.pttActive) return;
    this.pttActive = false;
    this.setMode('idle');
    this.options.onExitListening();
  }

  private registerBareCtrlPress(): void {
    const now = Date.now();
    this.ctrlPressTimestamps.push(now);
    this.ctrlPressTimestamps = this.ctrlPressTimestamps.filter(
      (t) => now - t <= TRIPLET_WINDOW_MS
    );
    if (this.ctrlPressTimestamps.length >= 3) {
      this.ctrlPressTimestamps = [];
      this.enterAlwaysOn();
    }
  }

  private enterAlwaysOn(): void {
    // Ctrl x3 while PTT is held, or while already always-on, is a no-op.
    if (this.mode === 'ptt' || this.mode === 'always-on') return;
    this.setMode('always-on');
    this.options.onEnterListening();
  }

  private handleEscape(): void {
    // Escape only acts while Bud is actively listening; in idle it is ignored
    // and (uiohook being observe-only) still reaches other apps.
    if (this.mode === 'idle') return;
    this.pttActive = false;
    this.setMode('idle');
    this.options.onInterrupt();
    this.options.onExitListening();
  }

  private setMode(mode: VoiceMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.options.onModeChange?.(mode);
  }

  destroy(): void {
    if (this.hookActive) {
      try {
        const { uIOhook } = require('uiohook-napi');
        if (this.keydownHandler) uIOhook.off('keydown', this.keydownHandler);
        if (this.keyupHandler) uIOhook.off('keyup', this.keyupHandler);
        uIOhook.stop();
      } catch {
        // hook already gone
      }
      this.hookActive = false;
    }
  }
}
