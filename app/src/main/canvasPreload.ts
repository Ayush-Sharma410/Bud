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
  CanvasRenderGhostsRequest,
  CanvasSceneRequest,
  CanvasSceneResponse,
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

  // Renderer -> main response: answer for a specific apply request
  sendApplyResponse: (requestId: string, result: CanvasApplyResponse['result']) => {
    ipcRenderer.send('canvas:apply-response', { requestId, result } as CanvasApplyResponse);
  },
});
