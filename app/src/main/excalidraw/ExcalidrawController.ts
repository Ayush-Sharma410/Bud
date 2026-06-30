import { randomUUID } from 'crypto';
import { ExcalidrawWindowManager } from './ExcalidrawWindowManager';
import type { CanvasSceneRequest, CanvasSceneResponse, SceneSummary } from './excalidrawTypes';

export interface ExcalidrawControllerOptions {
  windowManager: ExcalidrawWindowManager;
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
 * S2+ responsibilities (hotkey, apply, proposals, undo, autosave) are intentionally
 * not implemented here yet.
 */
export class ExcalidrawController {
  private windowManager: ExcalidrawWindowManager;
  private timeoutMs: number;
  private pendingScenes = new Map<string, PendingScene>();
  private latestScene: SceneSummary | null = null;

  constructor(options: ExcalidrawControllerOptions) {
    this.windowManager = options.windowManager;
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
}
