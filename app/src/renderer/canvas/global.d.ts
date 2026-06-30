import type { CanvasSceneRequest, SceneSummary } from '../../main/excalidraw/excalidrawTypes';

export interface BudCanvasAPI {
  /** Main process asked the renderer for a scene summary. */
  onRequestScene: (callback: (request: CanvasSceneRequest) => void) => void;
  /** Send a scene summary back for a specific request. */
  requestSceneResponse: (requestId: string, scene: SceneSummary) => void;
  /** Notify the main process that the scene changed locally. */
  publishSceneChange: (scene: SceneSummary) => void;
}

declare global {
  interface Window {
    budCanvasAPI: BudCanvasAPI;
  }
}

export {};
