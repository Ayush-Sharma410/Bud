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
  CanvasClearGhostsRequest,
  CanvasGhostResponse,
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
  CreateElementOperation,
  ElementChanges,
  ExcalidrawElementType as SummaryElementType,
  ExcalidrawOperation,
  FullSceneSnapshot,
  GhostElementPayload,
  GhostOptionPayload,
  GhostPayload,
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

  window.budCanvasAPI.onRenderGhosts((request: CanvasRenderGhostsRequest) => {
    if (!apiRef) {
      window.budCanvasAPI.sendGhostResponse(request.proposalId, 'rendered', 'error', 'Excalidraw API not mounted yet.');
      return;
    }

    try {
      const payload = buildGhostPayload(apiRef, request);
      const current = apiRef.getSceneElementsIncludingDeleted();
      const cleaned = removeGhosts(current, request.proposalId);
      apiRef.updateScene({ elements: [...cleaned, ...(payload.ghosts as ExcalidrawElement[])], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      window.budCanvasAPI.sendGhostResponse(request.proposalId, 'rendered', 'ok');
    } catch (err: any) {
      window.budCanvasAPI.sendGhostResponse(request.proposalId, 'rendered', 'error', err?.message ?? String(err));
    }
  });

  window.budCanvasAPI.onClearGhosts((request: CanvasClearGhostsRequest) => {
    if (!apiRef) {
      window.budCanvasAPI.sendGhostResponse(request.proposalId ?? '', 'cleared', 'error', 'Excalidraw API not mounted yet.');
      return;
    }

    try {
      const current = apiRef.getSceneElementsIncludingDeleted();
      const cleaned = removeGhosts(current, request.proposalId);
      apiRef.updateScene({ elements: cleaned, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      window.budCanvasAPI.sendGhostResponse(request.proposalId ?? '', 'cleared', 'ok');
    } catch (err: any) {
      window.budCanvasAPI.sendGhostResponse(request.proposalId ?? '', 'cleared', 'error', err?.message ?? String(err));
    }
  });

  // --- S5: snapshot + undo + redo --------------------------------------------

  window.budCanvasAPI.onRequestSnapshot((request: CanvasSnapshotRequest) => {
    if (!apiRef) {
      window.budCanvasAPI.sendSnapshotResponse(request.requestId, {
        sceneVersion: 0,
        elements: [],
        timestamp: Date.now(),
      });
      return;
    }

    try {
      const elements = apiRef.getSceneElementsIncludingDeleted().filter((el) => !isGhostElement(el));
      const appState = apiRef.getAppState();
      window.budCanvasAPI.sendSnapshotResponse(request.requestId, {
        sceneVersion: getSceneVersion(elements),
        elements,
        appState: pickSafeAppState(appState),
        timestamp: Date.now(),
      });
    } catch (err: any) {
      window.budCanvasAPI.sendSnapshotResponse(request.requestId, {
        sceneVersion: 0,
        elements: [],
        timestamp: Date.now(),
      });
    }
  });

  window.budCanvasAPI.onUndoNative((request: CanvasUndoNativeRequest) => {
    if (!apiRef) {
      window.budCanvasAPI.sendUndoNativeResponse(request.requestId, undefined, false);
      return;
    }

    try {
      const beforeVersion = getSceneVersion(apiRef.getSceneElementsIncludingDeleted().filter((el) => !isGhostElement(el)));
      dispatchShortcut('z', { shift: false });

      // Give Excalidraw a tick to process the shortcut, then report whether
      // the scene version changed.
      setTimeout(() => {
        const afterElements = apiRef!.getSceneElementsIncludingDeleted().filter((el) => !isGhostElement(el));
        const afterVersion = getSceneVersion(afterElements);
        window.budCanvasAPI.sendUndoNativeResponse(request.requestId, afterVersion, afterVersion !== beforeVersion);
      }, 80);
    } catch (err: any) {
      window.budCanvasAPI.sendUndoNativeResponse(request.requestId, undefined, false);
    }
  });

  window.budCanvasAPI.onRedoNative((request: CanvasRedoNativeRequest) => {
    if (!apiRef) {
      window.budCanvasAPI.sendRedoNativeResponse(request.requestId, undefined, false);
      return;
    }

    try {
      const beforeVersion = getSceneVersion(apiRef.getSceneElementsIncludingDeleted().filter((el) => !isGhostElement(el)));
      dispatchShortcut('y', { shift: false });

      setTimeout(() => {
        const afterElements = apiRef!.getSceneElementsIncludingDeleted().filter((el) => !isGhostElement(el));
        const afterVersion = getSceneVersion(afterElements);
        window.budCanvasAPI.sendRedoNativeResponse(request.requestId, afterVersion, afterVersion !== beforeVersion);
      }, 80);
    } catch (err: any) {
      window.budCanvasAPI.sendRedoNativeResponse(request.requestId, undefined, false);
    }
  });

  window.budCanvasAPI.onRestoreSnapshot((request: CanvasRestoreSnapshotRequest) => {
    if (!apiRef) {
      window.budCanvasAPI.sendRestoreSnapshotResponse(request.requestId, { status: 'error', reason: 'Excalidraw API not mounted yet.' });
      return;
    }

    try {
      // Ensure no proposal ghosts become real scene state after the restore.
      const current = apiRef.getSceneElementsIncludingDeleted();
      const cleaned = removeGhosts(current);
      const restoredElements = (request.snapshot.elements as ExcalidrawElement[]) ?? [];
      apiRef.updateScene({
        elements: restoredElements,
        appState: request.snapshot.appState as any,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      // Also remove any ghosts that were still present in the current scene so
      // they do not survive alongside the restored snapshot.
      const afterElements = apiRef.getSceneElementsIncludingDeleted();
      const finalElements = removeGhosts(afterElements);
      if (finalElements.length !== afterElements.length) {
        apiRef.updateScene({ elements: finalElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      }

      const sceneVersion = getSceneVersion(finalElements.filter((el) => !isGhostElement(el)));
      window.budCanvasAPI.sendRestoreSnapshotResponse(request.requestId, { status: 'restored', sceneVersion });
    } catch (err: any) {
      window.budCanvasAPI.sendRestoreSnapshotResponse(request.requestId, { status: 'error', reason: err?.message ?? String(err) });
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

function pickSafeAppState(appState: AppState): Record<string, any> {
  return {
    zoom: appState.zoom,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    theme: appState.theme,
  };
}

function dispatchShortcut(key: string, opts: { shift: boolean }): void {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const baseInit: KeyboardEventInit = {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: !isMac,
    metaKey: isMac,
    shiftKey: opts.shift,
    bubbles: true,
    cancelable: true,
  };

  try {
    window.dispatchEvent(new KeyboardEvent('keydown', baseInit));
    window.dispatchEvent(new KeyboardEvent('keyup', baseInit));
  } catch {
    // Some test environments may not have a real `window`; fall back silently.
  }
}

function buildSceneSummary(elements: readonly ExcalidrawElement[], appState: AppState): SceneSummary {
  const ghostIds = new Set(elements.filter(isGhostElement).map((el) => el.id));
  const realElements = elements.filter((el) => !isGhostElement(el));
  const nonDeleted = getNonDeletedElements(realElements);
  const selectedIds = Object.keys(appState.selectedElementIds ?? {}).filter(
    (id) => appState.selectedElementIds![id] === true && !ghostIds.has(id),
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
    sceneVersion: getSceneVersion(realElements),
    elementCount: realElements.length,
    canvasSize: {
      width: appState.width ?? 0,
      height: appState.height ?? 0,
    },
    selection: selectedIds,
    deletedCount: realElements.length - nonDeleted.length,
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
      case 'delete': {
        const ids = op.ids ?? [];
        for (const id of ids) {
          const existing = elementsById.get(id);
          if (!existing) {
            return { status: 'not_found', ids: [id], reason: `Element ${id} not found in scene.` };
          }
          if (isGhostElement(existing)) continue;
          elementsById.set(id, markDeleted(existing));
          affectedIds.push(id);
        }
        break;
      }
      case 'clearCanvas': {
        for (const [id, el] of elementsById) {
          if (isGhostElement(el) || el.isDeleted) continue;
          elementsById.set(id, markDeleted(el));
          affectedIds.push(id);
        }
        break;
      }
      case 'replaceScene':
      case 'reorganizeLayout':
      case 'importScene': {
        // These should never reach the renderer in S3/S4 because the safety gate blocks them.
        return {
          status: 'unsupported',
          reason: `Operation ${op.kind} is not applied directly by the renderer in S3/S4.`,
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

function isGhostElement(element: ExcalidrawElement): boolean {
  return (element as any).customData?.ghost === true;
}

function isMatchingGhost(element: ExcalidrawElement, proposalId?: string): boolean {
  if (!isGhostElement(element)) return false;
  if (!proposalId) return true;
  return (element as any).customData?.proposalId === proposalId;
}

function removeGhosts(elements: readonly ExcalidrawElement[], proposalId?: string): ExcalidrawElement[] {
  return elements.filter((el) => !isMatchingGhost(el, proposalId));
}

function markDeleted(element: ExcalidrawElement): ExcalidrawElement {
  const mutable = { ...element } as Record<string, any>;
  mutable.isDeleted = true;
  mutable.version = (element.version ?? 0) + 1;
  mutable.versionNonce = Math.floor(Math.random() * 2_000_000_000);
  mutable.updated = Date.now();
  return mutable as ExcalidrawElement;
}

function toGhostElement<T extends ExcalidrawElement>(
  element: T,
  proposalId: string,
  originalId?: string,
  optionId?: string,
): T {
  const optionSegment = optionId ? `${optionId}-` : '';
  const ghostId = `ghost-${proposalId.slice(0, 8)}-${optionSegment}${element.id}`;
  const mutable = { ...element } as Record<string, any>;
  mutable.id = ghostId;
  mutable.customData = { proposalId, ghost: true, optionId, originalId };
  mutable.strokeStyle = 'dashed';
  mutable.opacity = 40;
  mutable.groupIds = [];
  mutable.frameId = null;
  mutable.boundElements = null;
  mutable.version = 1;
  mutable.versionNonce = Math.floor(Math.random() * 2_000_000_000);
  mutable.updated = Date.now();
  return mutable as T;
}

/** Per-option stroke tints so review-options ghost sets are visually distinct. */
const OPTION_TINTS = [
  '#f76707', // orange
  '#15aabf', // cyan
  '#ae3ec9', // violet
  '#40c057', // green
  '#4c6ef5', // blue
];

function optionTint(index: number): string {
  return OPTION_TINTS[index % OPTION_TINTS.length];
}

function buildGhostPayload(
  api: ExcalidrawImperativeAPI,
  request: CanvasRenderGhostsRequest,
): GhostPayload {
  const proposalId = request.proposalId;
  const mode = request.mode ?? 'diagram_patch';

  if (mode === 'review_options') {
    const sceneElements = api.getSceneElementsIncludingDeleted();
    const byId = new Map<string, ExcalidrawElement>(sceneElements.map((el) => [el.id, el]));
    const allGhosts: ExcalidrawElement[] = [];
    const optionPayloads: GhostOptionPayload[] = [];

    const options = request.options ?? [];
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const tint = optionTint(i);
      const offset = i * 4;
      const optionGhostIds: string[] = [];

      for (const op of option.operations) {
        switch (op.kind) {
          case 'create': {
            const created = createElementFromOperation(op as CreateElementOperation);
            const ghost = toGhostElement(created, proposalId, undefined, option.optionId) as Record<string, any>;
            ghost.strokeColor = tint;
            ghost.x += offset;
            ghost.y += offset;
            optionGhostIds.push(ghost.id);
            allGhosts.push(ghost as ExcalidrawElement);
            break;
          }
          case 'update': {
            const ids = op.ids ?? [];
            for (const id of ids) {
              const existing = byId.get(id);
              if (!existing || isGhostElement(existing)) continue;
              const changed = applyElementChanges(existing, op.changes);
              const ghost = toGhostElement(changed, proposalId, id, option.optionId) as Record<string, any>;
              ghost.strokeColor = tint;
              ghost.x += offset;
              ghost.y += offset;
              optionGhostIds.push(ghost.id);
              allGhosts.push(ghost as ExcalidrawElement);
            }
            break;
          }
          case 'delete': {
            const ids = op.ids ?? [];
            for (const id of ids) {
              const existing = byId.get(id);
              if (!existing || isGhostElement(existing)) continue;
              const ghost = toGhostElement(existing, proposalId, id, option.optionId) as Record<string, any>;
              ghost.strokeColor = '#e03131';
              ghost.opacity = 55;
              optionGhostIds.push(ghost.id);
              allGhosts.push(ghost as ExcalidrawElement);
            }
            break;
          }
          case 'clearCanvas': {
            break;
          }
          default: {
            break;
          }
        }
      }

      optionPayloads.push({
        optionId: option.optionId,
        title: option.title,
        rationale: option.rationale,
        ghostIds: optionGhostIds,
      });
    }

    return {
      proposalId,
      mode,
      ghosts: allGhosts,
      options: optionPayloads,
      reason: request.reason,
      expiresAt: request.expiresAt,
    };
  }

  // diagram_patch: preserve single-option ghost behavior from the base operations.
  const sceneElements = api.getSceneElementsIncludingDeleted();
  const byId = new Map<string, ExcalidrawElement>(sceneElements.map((el) => [el.id, el]));
  const ghosts: ExcalidrawElement[] = [];

  for (const op of request.operations) {
    switch (op.kind) {
      case 'create': {
        const created = createElementFromOperation(op as CreateElementOperation);
        ghosts.push(toGhostElement(created, proposalId));
        break;
      }
      case 'update': {
        const ids = op.ids ?? [];
        for (const id of ids) {
          const existing = byId.get(id);
          if (!existing || isGhostElement(existing)) continue;
          const changed = applyElementChanges(existing, op.changes);
          ghosts.push(toGhostElement(changed, proposalId, id));
        }
        break;
      }
      case 'delete': {
        const ids = op.ids ?? [];
        for (const id of ids) {
          const existing = byId.get(id);
          if (!existing || isGhostElement(existing)) continue;
          const ghost = toGhostElement(existing, proposalId, id) as Record<string, any>;
          ghost.strokeColor = '#e03131';
          ghost.opacity = 55;
          ghosts.push(ghost as ExcalidrawElement);
        }
        break;
      }
      case 'clearCanvas': {
        break;
      }
      default: {
        break;
      }
    }
  }

  return {
    proposalId,
    mode,
    ghosts,
    reason: request.reason,
    expiresAt: request.expiresAt,
  };
}
