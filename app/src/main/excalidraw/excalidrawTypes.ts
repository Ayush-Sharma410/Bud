/**
 * Shared types for the embedded Excalidraw canvas copilot.
 *
 * Phase 1 Slice S1 uses only the scene-reading contract (`SceneSummary`,
 * `CanvasSceneRequest`, `CanvasSceneResponse`). Operation/proposal/undo types
 * are stubbed here for type continuity with later slices but are not wired up.
 */

/** Element types we expect to summarize back to prompts. */
export type ExcalidrawElementType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'line'
  | 'text'
  | 'freedraw'
  | 'image'
  | 'selection'
  | 'frame'
  | 'magicframe'
  | 'embeddable'
  | 'iframe';

/** Compact scene snapshot intended for LLM prompts. No full element JSON. */
export interface SceneSummary {
  /** Deterministic version stamp derived from element state. */
  sceneVersion: number;
  /** Total number of elements currently in the scene (including deleted). */
  elementCount: number;
  /** Canvas logical size as reported by Excalidraw. */
  canvasSize: { width: number; height: number };
  /** IDs of currently selected elements. */
  selection: string[];
  /** Number of deleted elements (count only, no payload). */
  deletedCount: number;
  /** Summarized non-deleted elements. */
  elements: Array<{
    id: string;
    type: ExcalidrawElementType;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    strokeColor?: string;
    backgroundColor?: string;
    roughness?: number;
    strokeWidth?: number;
  }>;
}

/** Main -> renderer: please produce a scene summary for this request id. */
export interface CanvasSceneRequest {
  requestId: string;
}

/** Renderer -> main: response to a specific `canvas:request-scene`. */
export interface CanvasSceneResponse {
  requestId: string;
  scene: SceneSummary;
}

/** S2+ operation shape. Stub only for S1. */
export type ExcalidrawOperation =
  | {
      kind: 'create';
      elementType: ExcalidrawElementType;
      x: number;
      y: number;
      width: number;
      height: number;
      text?: string;
      strokeColor?: string;
      backgroundColor?: string;
      strokeWidth?: number;
    }
  | { kind: 'update'; id: string; changes: Partial<Record<string, unknown>> }
  | { kind: 'delete'; ids: string[] }
  | {
      kind: 'align';
      ids: string[];
      alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
    }
  | { kind: 'group' | 'ungroup'; ids: string[] }
  | { kind: 'clearCanvas' }
  | { kind: 'replaceScene'; elements: Array<{ id: string; type: string }> }
  | {
      kind: 'importScene';
      source:
        | { type: 'file'; path: string }
        | { type: 'session'; sessionId: string };
    }
  | {
      kind: 'reorganizeLayout';
      ids: string[];
      layout: 'grid' | 'tree' | 'flow' | 'auto';
    };

/** S4+ proposal shape. Stub only for S1. */
export interface ExcalidrawProposal {
  proposalId?: string;
  mode?: 'diagram_patch' | 'review_options';
  summary?: string;
  operations?: ExcalidrawOperation[];
}

/** S3+ apply result shape. Stub only for S1. */
export type ApplyResult =
  | { status: 'applied'; sceneVersion: number; affectedIds: string[] }
  | { status: 'proposeRequired'; reason: string }
  | { status: 'ambiguous'; matches: string[] }
  | { status: 'unsupported'; reason: string };

/** S5+ undo result shape. Stub only for S1. */
export type UndoResult =
  | { status: 'undone'; via: 'native' | 'snapshot'; sceneVersion: number }
  | { status: 'nothingToUndo' };

/** S2+ HUD status pill states. */
export type CanvasHUDState =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'proposalPending'
  | 'saved';

/** S2+ payload sent to the renderer to update the HUD. */
export interface CanvasHUDPayload {
  state: CanvasHUDState;
}

/** S2+ canvas voice-session state exposed by the controller. */
export interface ExcalidrawSessionState {
  isActive: boolean;
  startedAt?: number;
  hudState: CanvasHUDState;
}
