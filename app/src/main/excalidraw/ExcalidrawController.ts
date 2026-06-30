import { randomUUID } from 'crypto';
import { ExcalidrawWindowManager } from './ExcalidrawWindowManager';
import { classifyOperation } from './safetyGate';
import type {
  ApplyResult,
  CanvasApplyRequest,
  CanvasApplyResponse,
  CanvasHUDPayload,
  CanvasHUDState,
  CanvasSceneRequest,
  CanvasSceneResponse,
  ExcalidrawOperation,
  ExcalidrawSessionState,
  SceneSummary,
} from './excalidrawTypes';

import type { AppSettings } from '../settings';

export interface ExcalidrawControllerOptions {
  windowManager: ExcalidrawWindowManager;
  /** Callback that returns whether the realtime voice pipeline is currently muted. */
  getMuted?: () => boolean;
  /** Callback that toggles realtime mute. Should return the new muted state. */
  toggleMute?: () => boolean;
  /** Callback that returns the current app settings. Used for safety thresholds. */
  getSettings?: () => AppSettings;
  timeoutMs?: number;
}

interface PendingScene {
  resolve: (scene: SceneSummary) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingApply {
  resolve: (result: ApplyResult) => void;
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
 * S3 responsibilities:
 * - Apply small, safe Excalidraw mutations immediately through `applyOperation`.
 * - Classify operations with the deterministic safety gate and return structured
 *   results (applied / requires_confirmation / unsupported / not_found / error).
 * - Send controller-approved patches to the renderer via `canvas:apply-scene`.
 *
 * S4+ responsibilities (proposals, undo, autosave) are intentionally
 * not implemented here yet.
 */
export class ExcalidrawController {
  private windowManager: ExcalidrawWindowManager;
  private getMuted?: () => boolean;
  private toggleMute?: () => boolean;
  private getSettings?: () => AppSettings;
  private timeoutMs: number;
  private pendingScenes = new Map<string, PendingScene>();
  private pendingApplies = new Map<string, PendingApply>();
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
    this.getSettings = options.getSettings;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Inject or replace the settings provider after app startup. */
  setSettingsProvider(getSettings: () => AppSettings): void {
    this.getSettings = getSettings;
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

  /**
   * Apply a high-level, controller-approved Excalidraw operation.
   *
   * 1. Classifies the operation through the deterministic safety gate.
   * 2. For immediate-safe ops, sends a controller-generated patch to the
   *    renderer via `canvas:apply-scene` and waits for `canvas:apply-response`.
   * 3. For destructive/large/ambiguous/unsupported ops, returns the
   *    corresponding structured status without mutating the scene.
   */
  async applyOperation(op: ExcalidrawOperation): Promise<ApplyResult> {
    const scene = this.latestScene ?? (await this.readScene());
    const settings = this.getSettings?.().excalidraw ?? {
      toggleHotkey: 'CommandOrControl+Shift+Space',
      saveDirectory: '',
      autosaveIntervalMs: 5000,
      theme: 'auto',
      safetyThresholds: { maxElementsPerImmediateApply: 5, maxElementsPerDelete: 3 },
      snapshotRing: { maxOperations: 50, maxAgeMs: 1_800_000 },
    };
    const classification = classifyOperation(op, { scene, settings });

    if (classification.decision === 'requires_confirmation') {
      return { status: 'requires_confirmation', reason: classification.reason ?? 'Operation requires confirmation.' };
    }
    if (classification.decision === 'unsupported') {
      return { status: 'unsupported', reason: classification.reason ?? 'Operation is not supported in S3.' };
    }
    if (classification.decision === 'not_found') {
      return { status: 'not_found', ids: classification.notFoundIds ?? [], reason: classification.reason ?? 'Target elements not found.' };
    }
    if (classification.decision === 'error') {
      return { status: 'error', reason: classification.reason ?? 'Safety gate error.' };
    }

    // Immediate path: open the canvas, send patch, wait for renderer response.
    await this.windowManager.openOrFocus();

    return new Promise<ApplyResult>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingApplies.delete(requestId);
        reject(new Error(`applyOperation timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingApplies.set(requestId, { resolve, reject, timer });

      const request: CanvasApplyRequest = { requestId, operations: [op] };
      this.windowManager.sendToCanvas('canvas:apply-scene', request);
    });
  }

  /** Handle a renderer response to a prior `applyOperation(...)` request. */
  handleApplyResponse(response: CanvasApplyResponse): void {
    const pending = this.pendingApplies.get(response.requestId);
    if (!pending) {
      console.warn(`⚠️ ExcalidrawController: unmatched apply response ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingApplies.delete(response.requestId);
    pending.resolve(response.result);
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
