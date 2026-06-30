import type {
  ApplyResult,
  CanvasApplyRequest,
  CanvasHUDPayload,
  CanvasSceneRequest,
  SceneSummary,
} from '../../main/excalidraw/excalidrawTypes';

export interface BudCanvasAPI {
  /** Main process asked the renderer for a scene summary. */
  onRequestScene: (callback: (request: CanvasSceneRequest) => void) => void;
  /** Send a scene summary back for a specific request. */
  requestSceneResponse: (requestId: string, scene: SceneSummary) => void;
  /** Notify the main process that the scene changed locally. */
  publishSceneChange: (scene: SceneSummary) => void;
  /** Main process pushed a controller-approved operation batch to apply. */
  onApplyScene: (callback: (request: CanvasApplyRequest) => void) => void;
  /** Send the result of an apply operation back to the main process. */
  sendApplyResponse: (requestId: string, result: ApplyResult) => void;
  /** Main process pushed a HUD state update. */
  onHUDState: (callback: (payload: CanvasHUDPayload) => void) => void;
}

declare global {
  interface Window {
    budCanvasAPI: BudCanvasAPI;
  }
}

export {};
