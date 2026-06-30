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

/** Immediate-safe element creation. */
export interface CreateElementOperation {
  kind: 'create';
  /** Element type to create. S3 supports text, rectangle, ellipse, diamond, arrow, line, freedraw. */
  elementType: 'text' | 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'freedraw';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stable id requested by the controller; renderer will use it exactly. */
  id?: string;
  text?: string;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  angle?: number;
  fillStyle?: 'hachure' | 'cross-hatch' | 'solid' | 'zigzag';
}

/** Allowed fields for an immediate update. Keeps callers from passing arbitrary element JSON. */
export interface ElementChanges {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: 'hachure' | 'cross-hatch' | 'solid' | 'zigzag';
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  roughness?: number;
  opacity?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  text?: string;
}

/** Update explicit elements or the current selection. */
export interface UpdateElementsOperation {
  kind: 'update';
  /** If omitted, the current selection is used. */
  ids?: string[];
  changes: ElementChanges;
}

/** Delete elements. Destructive in S3: always routed to confirmation flow. */
export interface DeleteElementsOperation {
  kind: 'delete';
  /** If omitted, the current selection is used. */
  ids?: string[];
}

/** Align elements. */
export interface AlignElementsOperation {
  kind: 'align';
  ids?: string[];
  alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
}

/** Distribute elements. */
export interface DistributeElementsOperation {
  kind: 'distribute';
  ids?: string[];
  direction: 'horizontal' | 'vertical';
}

/** Group the selected/explicit elements. */
export interface GroupOperation {
  kind: 'group';
  ids?: string[];
}

/** Ungroup the selected/explicit elements. */
export interface UngroupOperation {
  kind: 'ungroup';
  ids?: string[];
}

/** Clear the entire canvas. Destructive in S3: routed to confirmation flow. */
export interface ClearCanvasOperation {
  kind: 'clearCanvas';
}

/** Replace the whole scene. Not accepted from callers in S3. */
export interface ReplaceSceneOperation {
  kind: 'replaceScene';
  elements: Array<{ id: string; type: string }>;
}

/** Import a scene from a file or saved session. Not implemented in S3. */
export interface ImportSceneOperation {
  kind: 'importScene';
  source:
    | { type: 'file'; path: string }
    | { type: 'session'; sessionId: string };
}

/** Reorganize layout. Not immediate in S3. */
export interface ReorganizeLayoutOperation {
  kind: 'reorganizeLayout';
  ids?: string[];
  layout: 'grid' | 'tree' | 'flow' | 'auto';
}

/** S3 high-level operation union. Does not accept raw arbitrary scene JSON. */
export type ExcalidrawOperation =
  | CreateElementOperation
  | UpdateElementsOperation
  | DeleteElementsOperation
  | AlignElementsOperation
  | DistributeElementsOperation
  | GroupOperation
  | UngroupOperation
  | ClearCanvasOperation
  | ReplaceSceneOperation
  | ImportSceneOperation
  | ReorganizeLayoutOperation;

/** S4+ proposal shape. Stub only for S1. */
export interface ExcalidrawProposal {
  proposalId?: string;
  mode?: 'diagram_patch' | 'review_options';
  summary?: string;
  operations?: ExcalidrawOperation[];
}

/** S3 deterministic safety-gate decision. */
export type SafetyDecision =
  | 'immediate'
  | 'requires_confirmation'
  | 'unsupported'
  | 'not_found'
  | 'error';

/** S3+ apply result returned to LLM/tool callers. */
export type ApplyResult =
  | { status: 'applied'; sceneVersion: number; affectedIds: string[]; affectedCount: number }
  | { status: 'requires_confirmation'; reason: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'not_found'; ids: string[]; reason: string }
  | { status: 'error'; reason: string };

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

/** S3 main -> renderer: apply a controller-approved operation batch. */
export interface CanvasApplyRequest {
  requestId: string;
  operations: ExcalidrawOperation[];
}

/** S3 renderer -> main: response to a specific `canvas:apply-scene`. */
export interface CanvasApplyResponse {
  requestId: string;
  result: ApplyResult;
}

/** S2+ canvas voice-session state exposed by the controller. */
export interface ExcalidrawSessionState {
  isActive: boolean;
  startedAt?: number;
  hudState: CanvasHUDState;
}
