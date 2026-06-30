/**
 * Dedicated preload for the Excalidraw canvas renderer.
 *
 * Keeps the canvas IPC surface separate from `window.budAPI` used by the
 * panel/overlay renderers. The canvas renderer must not use Node APIs directly.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  CanvasApplyRequest,
  CanvasApplyResponse,
  CanvasClearGhostsRequest,
  CanvasGhostResponse,
  CanvasHUDPayload,
  CanvasRedoNativeRequest,
  CanvasRedoNativeResponse,
  CanvasRenderGhostsRequest,
  CanvasRestoreSnapshotRequest,
  CanvasRestoreSnapshotResponse,
  CanvasSceneRequest,
  CanvasSceneResponse,
  CanvasSnapshotRequest,
  CanvasSnapshotResponse,
  CanvasUndoNativeRequest,
  CanvasUndoNativeResponse,
  SceneSummary,
} from './excalidraw/excalidrawTypes';

contextBridge.exposeInMainWorld('budCanvasAPI', {
  // Renderer -> main: request for a scene summary
  onRequestScene: (callback: (request: CanvasSceneRequest) => void) => {
    ipcRenderer.on('canvas:request-scene', (_event, request: CanvasSceneRequest) => {
      callback(request);
    });
  },

  // Renderer -> main response: answer for a specific scene request
  requestSceneResponse: (requestId: string, scene: SceneSummary) => {
    ipcRenderer.send('canvas:scene-response', { requestId, scene } as CanvasSceneResponse);
  },

  // Renderer -> main publish: scene changed locally
  publishSceneChange: (scene: SceneSummary) => {
    ipcRenderer.send('canvas:scene-change', scene);
  },

  // Main -> renderer: apply a controller-approved operation batch
  onApplyScene: (callback: (request: CanvasApplyRequest) => void) => {
    ipcRenderer.on('canvas:apply-scene', (_event, request: CanvasApplyRequest) => {
      callback(request);
    });
  },

  // Main -> renderer: render a proposal's ghost elements
  onRenderGhosts: (callback: (request: CanvasRenderGhostsRequest) => void) => {
    ipcRenderer.on('canvas:render-ghosts', (_event, request: CanvasRenderGhostsRequest) => {
      callback(request);
    });
  },

  // Main -> renderer: clear ghost elements
  onClearGhosts: (callback: (request: CanvasClearGhostsRequest) => void) => {
    ipcRenderer.on('canvas:clear-ghosts', (_event, request: CanvasClearGhostsRequest) => {
      callback(request);
    });
  },

  // Renderer -> main: acknowledge render/clear of ghosts
  sendGhostResponse: (proposalId: string, action: CanvasGhostResponse['action'], status: CanvasGhostResponse['status'], reason?: string) => {
    ipcRenderer.send('canvas:ghost-response', { proposalId, action, status, reason } as CanvasGhostResponse);
  },

  // Main -> renderer: update the canvas HUD state
  onHUDState: (callback: (payload: CanvasHUDPayload) => void) => {
    ipcRenderer.on('canvas:hud', (_event, payload: CanvasHUDPayload) => {
      callback(payload);
    });
  },

  // Main -> renderer: request a private full-scene snapshot
  onRequestSnapshot: (callback: (request: CanvasSnapshotRequest) => void) => {
    ipcRenderer.on('canvas:request-snapshot', (_event, request: CanvasSnapshotRequest) => {
      callback(request);
    });
  },

  // Renderer -> main: full-scene snapshot response
  sendSnapshotResponse: (requestId: string, snapshot: CanvasSnapshotResponse['snapshot']) => {
    ipcRenderer.send('canvas:snapshot-response', { requestId, snapshot } as CanvasSnapshotResponse);
  },

  // Main -> renderer: trigger native Excalidraw undo
  onUndoNative: (callback: (request: CanvasUndoNativeRequest) => void) => {
    ipcRenderer.on('canvas:undo-native', (_event, request: CanvasUndoNativeRequest) => {
      callback(request);
    });
  },

  // Renderer -> main: native undo response
  sendUndoNativeResponse: (requestId: string, sceneVersion?: number, changed?: boolean) => {
    ipcRenderer.send('canvas:undo-native-response', { requestId, sceneVersion, changed } as CanvasUndoNativeResponse);
  },

  // Main -> renderer: restore a controller-managed snapshot
  onRestoreSnapshot: (callback: (request: CanvasRestoreSnapshotRequest) => void) => {
    ipcRenderer.on('canvas:restore-snapshot', (_event, request: CanvasRestoreSnapshotRequest) => {
      callback(request);
    });
  },

  // Renderer -> main: restore-snapshot response
  sendRestoreSnapshotResponse: (requestId: string, result: CanvasRestoreSnapshotResponse['result']) => {
    ipcRenderer.send('canvas:restore-snapshot-response', { requestId, result } as CanvasRestoreSnapshotResponse);
  },

  // Main -> renderer: trigger native Excalidraw redo
  onRedoNative: (callback: (request: CanvasRedoNativeRequest) => void) => {
    ipcRenderer.on('canvas:redo-native', (_event, request: CanvasRedoNativeRequest) => {
      callback(request);
    });
  },

  // Renderer -> main: native redo response
  sendRedoNativeResponse: (requestId: string, sceneVersion?: number, changed?: boolean) => {
    ipcRenderer.send('canvas:redo-native-response', { requestId, sceneVersion, changed } as CanvasRedoNativeResponse);
  },
});
