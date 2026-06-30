import { getSceneVersion, getNonDeletedElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState } from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawElementType,
} from '@excalidraw/excalidraw/element/types';
import type { CanvasSceneRequest, SceneSummary, ExcalidrawElementType as SummaryElementType } from '../../main/excalidraw/excalidrawTypes';

let apiRef: ExcalidrawImperativeAPI | null = null;
let unsubscribeOnChange: (() => void) | null = null;

/** Capture the Excalidraw imperative API so the renderer can answer scene queries. */
export function setExcalidrawAPI(api: ExcalidrawImperativeAPI): void {
  apiRef = api;

  if (unsubscribeOnChange) {
    unsubscribeOnChange();
    unsubscribeOnChange = null;
  }

  unsubscribeOnChange = api.onChange((elements, appState) => {
    window.budCanvasAPI.publishSceneChange(buildSceneSummary(elements, appState));
  });
}

/** Wire up renderer-side listeners for main-process scene requests. */
export function initCanvasIPC(): void {
  window.budCanvasAPI.onRequestScene((request: CanvasSceneRequest) => {
    if (!apiRef) {
      // Renderer API not mounted yet; send an empty summary so the request resolves.
      window.budCanvasAPI.requestSceneResponse(request.requestId, {
        sceneVersion: 0,
        elementCount: 0,
        canvasSize: { width: 0, height: 0 },
        selection: [],
        deletedCount: 0,
        elements: [],
      });
      return;
    }

    const elements = apiRef.getSceneElementsIncludingDeleted();
    const appState = apiRef.getAppState();
    const scene = buildSceneSummary(elements, appState);
    window.budCanvasAPI.requestSceneResponse(request.requestId, scene);
  });
}

function buildSceneSummary(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
): SceneSummary {
  const nonDeleted = getNonDeletedElements(elements);
  const selectedIds = Object.keys(appState.selectedElementIds ?? {}).filter(
    (id) => appState.selectedElementIds![id] === true,
  );

  const summarized = nonDeleted
    .filter((el) => el.type !== 'selection')
    .map((el) => {
      const base = {
        id: el.id,
        type: el.type as SummaryElementType,
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        strokeColor: el.strokeColor,
        backgroundColor: el.backgroundColor,
        roughness: el.roughness,
        strokeWidth: el.strokeWidth,
      };

      if (el.type === 'text') {
        return { ...base, text: (el as ExcalidrawTextElement).text };
      }

      return base;
    });

  return {
    sceneVersion: getSceneVersion(elements),
    elementCount: elements.length,
    canvasSize: {
      width: appState.width ?? 0,
      height: appState.height ?? 0,
    },
    selection: selectedIds,
    deletedCount: elements.length - nonDeleted.length,
    elements: summarized,
  };
}
