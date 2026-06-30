import {
  getSceneVersion,
  getNonDeletedElements,
  FONT_FAMILY,
  ROUNDNESS,
  CaptureUpdateAction,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState } from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawLinearElement,
  ExcalidrawArrowElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawElementType,
} from '@excalidraw/excalidraw/element/types';
import type {
  CanvasApplyRequest,
  CanvasSceneRequest,
  CreateElementOperation,
  ElementChanges,
  ExcalidrawElementType as SummaryElementType,
  SceneSummary,
} from '../../main/excalidraw/excalidrawTypes';

/** Local point alias for linear/freedraw element coordinates. */
type LocalPoint = readonly [number, number];

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

/** Wire up renderer-side listeners for main-process scene and apply requests. */
export function initCanvasIPC(): void {
  window.budCanvasAPI.onRequestScene((request: CanvasSceneRequest) => {
    if (!apiRef) {
      // Renderer API not mounted yet; send an empty summary so the request resolves.
      window.budCanvasAPI.requestSceneResponse(request.requestId, emptySceneSummary());
      return;
    }

    const elements = apiRef.getSceneElementsIncludingDeleted();
    const appState = apiRef.getAppState();
    const scene = buildSceneSummary(elements, appState);
    window.budCanvasAPI.requestSceneResponse(request.requestId, scene);
  });

  window.budCanvasAPI.onApplyScene((request: CanvasApplyRequest) => {
    if (!apiRef) {
      window.budCanvasAPI.sendApplyResponse(request.requestId, {
        status: 'error',
        reason: 'Excalidraw API not mounted yet.',
      });
      return;
    }

    try {
      const result = applyOperationsToScene(apiRef, request.operations);
      window.budCanvasAPI.sendApplyResponse(request.requestId, result);
    } catch (err: any) {
      window.budCanvasAPI.sendApplyResponse(request.requestId, {
        status: 'error',
        reason: err?.message ?? String(err),
      });
    }
  });
}

function emptySceneSummary(): SceneSummary {
  return {
    sceneVersion: 0,
    elementCount: 0,
    canvasSize: { width: 0, height: 0 },
    selection: [],
    deletedCount: 0,
    elements: [],
  };
}

function buildSceneSummary(elements: readonly ExcalidrawElement[], appState: AppState): SceneSummary {
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

function applyOperationsToScene(
  api: ExcalidrawImperativeAPI,
  operations: CanvasApplyRequest['operations'],
): import('../../main/excalidraw/excalidrawTypes').ApplyResult {
  const currentElements = api.getSceneElementsIncludingDeleted();
  const elementsById = new Map<string, ExcalidrawElement>(currentElements.map((el) => [el.id, el]));
  const affectedIds: string[] = [];

  for (const op of operations) {
    switch (op.kind) {
      case 'create': {
        const element = createElementFromOperation(op);
        elementsById.set(element.id, element);
        affectedIds.push(element.id);
        break;
      }
      case 'update': {
        const ids = op.ids ?? [];
        for (const id of ids) {
          const existing = elementsById.get(id);
          if (!existing) {
            return { status: 'not_found', ids: [id], reason: `Element ${id} not found in scene.` };
          }
          const updated = applyElementChanges(existing, op.changes);
          elementsById.set(id, updated);
          affectedIds.push(id);
        }
        break;
      }
      case 'delete':
      case 'clearCanvas':
      case 'replaceScene':
      case 'reorganizeLayout':
      case 'importScene': {
        // These should never reach the renderer in S3 because the safety gate blocks them.
        return {
          status: 'unsupported',
          reason: `Operation ${op.kind} is not applied directly by the renderer in S3.`,
        };
      }
      case 'align':
      case 'distribute':
      case 'group':
      case 'ungroup': {
        // These are classified as requires_confirmation by the S3 safety gate and
        // should not reach the renderer in the immediate path.
        return {
          status: 'error',
          reason: `Operation ${op.kind} was not expected in the S3 immediate renderer path.`,
        };
      }
      default: {
        const _exhaustive: never = op;
        void _exhaustive;
        return { status: 'unsupported', reason: `Unknown operation kind.` };
      }
    }
  }

  const newElements = Array.from(elementsById.values());
  api.updateScene({ elements: newElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });

  // sceneVersion will be published by the onChange handler; compute it now for the response.
  const sceneVersion = getSceneVersion(newElements);
  return {
    status: 'applied',
    sceneVersion,
    affectedIds,
    affectedCount: affectedIds.length,
  };
}

function createElementFromOperation(op: CreateElementOperation): ExcalidrawElement {
  const id = op.id ?? generateId();
  const base = {
    id,
    x: op.x,
    y: op.y,
    width: op.width,
    height: op.height,
    angle: op.angle ?? 0,
    strokeColor: op.strokeColor ?? '#1e1e1e',
    backgroundColor: op.backgroundColor ?? 'transparent',
    fillStyle: op.fillStyle ?? 'hachure',
    strokeWidth: op.strokeWidth ?? 1,
    strokeStyle: 'solid' as const,
    roughness: op.roughness ?? 1,
    opacity: op.opacity ?? 100,
    roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS, value: 0.25 } as const,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    index: null,
    isDeleted: false,
    groupIds: [] as const,
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };

  switch (op.elementType) {
    case 'text': {
      const textElement = {
        ...base,
        type: 'text' as const,
        roundness: null,
        text: op.text ?? '',
        fontSize: 20,
        fontFamily: FONT_FAMILY.Virgil as ExcalidrawTextElement['fontFamily'],
        textAlign: 'left' as ExcalidrawTextElement['textAlign'],
        verticalAlign: 'top' as ExcalidrawTextElement['verticalAlign'],
        containerId: null,
        originalText: op.text ?? '',
        lineHeight: 1.25 as ExcalidrawTextElement['lineHeight'],
        autoResize: true,
      };
      return textElement as ExcalidrawElement;
    }
    case 'rectangle':
    case 'ellipse':
    case 'diamond': {
      return { ...base, type: op.elementType } as ExcalidrawElement;
    }
    case 'arrow': {
      const points: readonly LocalPoint[] = [
        [0, 0],
        [op.width, op.height],
      ];
      const arrow: ExcalidrawArrowElement = {
        ...base,
        type: 'arrow',
        elbowed: false,
        points,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: 'arrow',
      } as ExcalidrawArrowElement;
      return arrow as ExcalidrawElement;
    }
    case 'line': {
      const points: readonly LocalPoint[] = [
        [0, 0],
        [op.width, op.height],
      ];
      const linear: ExcalidrawLinearElement = {
        ...base,
        type: 'line',
        points,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
      } as ExcalidrawLinearElement;
      return linear as ExcalidrawElement;
    }
    case 'freedraw': {
      const points: readonly LocalPoint[] = [
        [0, 0],
        [op.width, op.height],
      ];
      const freeDraw: ExcalidrawFreeDrawElement = {
        ...base,
        type: 'freedraw',
        roundness: null,
        points,
        pressures: [0.5, 0.5],
        simulatePressure: true,
        lastCommittedPoint: null,
      } as ExcalidrawFreeDrawElement;
      return freeDraw as ExcalidrawElement;
    }
    default: {
      const _exhaustive: never = op.elementType;
      void _exhaustive;
      throw new Error(`Unsupported create element type: ${(op as any).elementType}`);
    }
  }
}

function applyElementChanges(element: ExcalidrawElement, changes: ElementChanges): ExcalidrawElement {
  const mutable = { ...element } as Record<string, any>;
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) {
      mutable[key] = value;
    }
  }
  mutable.version = (element.version ?? 0) + 1;
  mutable.versionNonce = Math.floor(Math.random() * 2_000_000_000);
  mutable.updated = Date.now();
  return mutable as ExcalidrawElement;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}
