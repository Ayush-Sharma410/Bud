import { randomUUID } from 'crypto';
import { ExcalidrawWindowManager } from './ExcalidrawWindowManager';
import type {
  CanvasHUDPayload,
  CanvasHUDState,
  CanvasSceneRequest,
  CanvasSceneResponse,
  ExcalidrawSessionState,
  SceneSummary,
} from './excalidrawTypes';

export interface ExcalidrawControllerOptions {
  windowManager: ExcalidrawWindowManager;
  /** Callback that returns whether the realtime voice pipeline is currently muted. */
  getMuted?: () => boolean;
  /** Callback that toggles realtime mute. Should return the new muted state. */
  toggleMute?: () => boolean;
  timeoutMs?: number;
}

interface PendingScene {
  resolve: (scene: SceneSummary) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Main-process controller for the embedded Excalidraw canvas.
 *
 * S1 responsibilities:
 * - Open/focus the canvas window.
 * - Request and return a compact `SceneSummary` from the renderer.
 * - Cache the latest scene summary published by the renderer.
 *
 * S2 responsibilities:
 * - Toggle a canvas-scoped continuous voice session on the configured hotkey.
 * - Open/focus the canvas on start, unmute Realtime if muted, restore mute on end.
 * - Keep the canvas window open when the session ends.
 * - Publish a minimal HUD state to the renderer.
 *
 * S3+ responsibilities (apply, proposals, undo, autosave) are intentionally
 * not implemented here yet.
 */
export class ExcalidrawController {
  private windowManager: ExcalidrawWindowManager;
  private getMuted?: () => boolean;
  private toggleMute?: () => boolean;
  private timeoutMs: number;
  private pendingScenes = new Map<string, PendingScene>();
  private latestScene: SceneSummary | null = null;

  // S2 session state
  private isSessionActive = false;
  private sessionStartedAt?: number;
  private restoredMuteState = false;
  private hudState: CanvasHUDState = 'idle';

  constructor(options: ExcalidrawControllerOptions) {
    this.windowManager = options.windowManager;
    this.getMuted = options.getMuted;
    this.toggleMute = options.toggleMute;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Open the canvas window, or bring it to the foreground if it already exists. */
  async openCanvas(): Promise<void> {
    await this.windowManager.openOrFocus();
  }

  /** Alias used by callers that want to emphasize focusing an existing canvas. */
  async focusCanvas(): Promise<void> {
    await this.windowManager.openOrFocus();
  }

  /**
   * Ask the renderer for a compact scene summary and return it.
   * Creates/focuses the window first and enforces a request timeout.
   */
  async readScene(): Promise<SceneSummary> {
    await this.windowManager.openOrFocus();

    return new Promise<SceneSummary>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingScenes.delete(requestId);
        reject(new Error(`readScene timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingScenes.set(requestId, { resolve, reject, timer });

      this.windowManager.sendToCanvas('canvas:request-scene', {
        requestId,
      } as CanvasSceneRequest);
    });
  }

  /** Handle a renderer response to a prior `readScene()` request. */
  handleSceneResponse(response: CanvasSceneResponse): void {
    const pending = this.pendingScenes.get(response.requestId);
    if (!pending) {
      console.warn(`⚠️ ExcalidrawController: unmatched scene response ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingScenes.delete(response.requestId);
    pending.resolve(response.scene);
  }

  /** Receive periodic scene summaries published by the renderer on every change. */
  onSceneChange(scene: SceneSummary): void {
    this.latestScene = scene;
  }

  /** Return the most recently observed scene summary, if any. */
  getLatestScene(): SceneSummary | null {
    return this.latestScene;
  }

  // --- S2: canvas-scoped voice session toggle ---

  /** Toggle the canvas voice session on/off. Returns the new active state. */
  async toggleSession(): Promise<boolean> {
    if (this.isSessionActive) {
      await this.endSession();
    } else {
      await this.startSession();
    }
    return this.isSessionActive;
  }

  /** Open/focus the canvas and start a continuous voice session scoped to it. */
  async startSession(): Promise<void> {
    await this.openCanvas();

    this.isSessionActive = true;
    this.sessionStartedAt = Date.now();

    if (!this.getMuted || !this.toggleMute) {
      console.warn('⚠️ Excalidraw voice session started without realtime mute callbacks — canvas will not control listening state');
      this.restoredMuteState = false;
    } else {
      const currentlyMuted = this.getMuted();
      if (currentlyMuted) {
        this.restoredMuteState = true;
        this.toggleMute();
        console.log('🎙️ Excalidraw voice session unmuted Realtime');
      } else {
        this.restoredMuteState = false;
      }
    }

    this.setHUDState('listening');
    console.log('🎨 Excalidraw voice session started');
  }

  /**
   * End the canvas voice session while keeping the canvas window and sketch open.
   * Restores the mute state if the session had to unmute Realtime.
   */
  async endSession(): Promise<void> {
    this.isSessionActive = false;
    this.sessionStartedAt = undefined;

    if (this.restoredMuteState && this.getMuted && this.toggleMute) {
      const currentlyMuted = this.getMuted();
      if (!currentlyMuted) {
        this.toggleMute();
        console.log('🎙️ Excalidraw voice session restored Realtime mute');
      }
    }
    this.restoredMuteState = false;

    this.setHUDState('idle');
    console.log('🎨 Excalidraw voice session ended');
  }

  /** Return the current session state (active + HUD). */
  getSessionState(): ExcalidrawSessionState {
    return {
      isActive: this.isSessionActive,
      startedAt: this.sessionStartedAt,
      hudState: this.hudState,
    };
  }

  /** Send a HUD state update to the canvas renderer if the window is alive. */
  private setHUDState(state: CanvasHUDState): void {
    this.hudState = state;
    const payload: CanvasHUDPayload = { state };
    this.windowManager.sendToCanvas('canvas:hud', payload);
  }
}
