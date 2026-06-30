/**
 * Dedicated preload for the Excalidraw canvas renderer.
 *
 * Keeps the canvas IPC surface separate from `window.budAPI` used by the
 * panel/overlay renderers. The canvas renderer must not use Node APIs directly.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { CanvasSceneRequest, CanvasSceneResponse, SceneSummary } from './excalidraw/excalidrawTypes';

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
});
