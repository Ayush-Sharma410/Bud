import type {
  ApplyResult,
  CanvasApplyRequest,
  CanvasClearGhostsRequest,
  CanvasGhostResponse,
  CanvasHUDPayload,
  CanvasRedoNativeRequest,
  CanvasRedoNativeResponse,
  CanvasRenderGhostsRequest,
  CanvasRestoreSnapshotRequest,
  CanvasRestoreSnapshotResponse,
  CanvasSceneRequest,
  CanvasSnapshotRequest,
  CanvasSnapshotResponse,
  CanvasUndoNativeRequest,
  CanvasUndoNativeResponse,
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
  /** Main process pushed a proposal's ghost elements to render. */
  onRenderGhosts: (callback: (request: CanvasRenderGhostsRequest) => void) => void;
  /** Main process asked the renderer to clear ghost elements. */
  onClearGhosts: (callback: (request: CanvasClearGhostsRequest) => void) => void;
  /** Send a ghost render/clear acknowledgement back to the main process. */
  sendGhostResponse: (proposalId: string, action: CanvasGhostResponse['action'], status: CanvasGhostResponse['status'], reason?: string) => void;
  /** Main process pushed a HUD state update. */
  onHUDState: (callback: (payload: CanvasHUDPayload) => void) => void;
  /** Main process asked for a private full-scene snapshot. */
  onRequestSnapshot: (callback: (request: CanvasSnapshotRequest) => void) => void;
  /** Send a full-scene snapshot back for a specific request. */
  sendSnapshotResponse: (requestId: string, snapshot: CanvasSnapshotResponse['snapshot']) => void;
  /** Main process asked the renderer to trigger native undo. */
  onUndoNative: (callback: (request: CanvasUndoNativeRequest) => void) => void;
  /** Send the result of a native undo attempt back to the main process. */
  sendUndoNativeResponse: (requestId: string, sceneVersion?: number, changed?: boolean) => void;
  /** Main process asked the renderer to restore a controller-managed snapshot. */
  onRestoreSnapshot: (callback: (request: CanvasRestoreSnapshotRequest) => void) => void;
  /** Send the result of a snapshot restore back to the main process. */
  sendRestoreSnapshotResponse: (requestId: string, result: CanvasRestoreSnapshotResponse['result']) => void;
  /** Main process asked the renderer to trigger native redo. */
  onRedoNative: (callback: (request: CanvasRedoNativeRequest) => void) => void;
  /** Send the result of a native redo attempt back to the main process. */
  sendRedoNativeResponse: (requestId: string, sceneVersion?: number, changed?: boolean) => void;
}

declare global {
  interface Window {
    budCanvasAPI: BudCanvasAPI;
  }
}

export {};
