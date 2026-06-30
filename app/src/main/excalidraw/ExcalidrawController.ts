import { randomUUID } from 'crypto';
import { ExcalidrawWindowManager } from './ExcalidrawWindowManager';
import { classifyOperation } from './safetyGate';
import { SnapshotRing } from './SnapshotRing';
import type {
  ApplyResult,
  CanvasApplyRequest,
  CanvasApplyResponse,
  CanvasClearGhostsRequest,
  CanvasGhostResponse,
  CanvasHUDPayload,
  CanvasHUDState,
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
  ExcalidrawOperation,
  ExcalidrawProposal,
  ExcalidrawSessionState,
  FullSceneSnapshot,
  ProposalOption,
  ProposalResult,
  SceneSummary,
  UndoResult,
} from './excalidrawTypes';

import type { AppSettings } from '../settings';

export interface ExcalidrawControllerOptions {
  windowManager: ExcalidrawWindowManager;
  /** Callback that returns whether the realtime voice pipeline is currently muted. */
  getMuted?: () => boolean;
  /** Callback that toggles realtime mute. Should return the new muted state. */
  toggleMute?: () => boolean;
  /** Callback that returns the current app settings. Used for safety thresholds. */
  getSettings?: () => AppSettings;
  timeoutMs?: number;
}

interface PendingScene {
  resolve: (scene: SceneSummary) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingApply {
  resolve: (result: ApplyResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingSnapshot {
  resolve: (snapshot: FullSceneSnapshot) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingUndo {
  requestId: string;
  baselineVersion: number;
  resolve: (result: UndoResult) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface PendingRestore {
  resolve: (result: UndoResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRedo extends PendingUndo {}

/**
 * Main-process controller for the embedded Excalidraw canvas.
 *
 * S1 responsibilities:
 * - Open/focus the canvas window.
 * - Request and return a compact `SceneSummary` from the renderer.
 * - Cache the latest scene summary published by the renderer.
 *
 * S2 responsibilities:
 * - Toggle a canvas-scoped continuous voice session on the configured hotkey.
 * - Open/focus the canvas on start, unmute Realtime if muted, restore mute on end.
 * - Keep the canvas window open when the session ends.
 * - Publish a minimal HUD state to the renderer.
 *
 * S3 responsibilities:
 * - Apply small, safe Excalidraw mutations immediately through `applyOperation`.
 * - Classify operations with the deterministic safety gate and return structured
 *   results (applied / requires_confirmation / unsupported / not_found / error).
 * - Send controller-approved patches to the renderer via `canvas:apply-scene`.
 *
 * S4 responsibilities:
 * - Create pending visual proposals via `proposeOperation`.
 * - Render translucent/dashed ghost elements in the renderer for review.
 * - Commit stored proposals through a controller-internal confirmed apply path.
 * - Cancel or supersede proposals and clear their ghosts.
 */
export class ExcalidrawController {
  private windowManager: ExcalidrawWindowManager;
  private getMuted?: () => boolean;
  private toggleMute?: () => boolean;
  private getSettings?: () => AppSettings;
  private timeoutMs: number;
  private pendingScenes = new Map<string, PendingScene>();
  private pendingApplies = new Map<string, PendingApply>();
  private pendingSnapshots = new Map<string, PendingSnapshot>();
  private latestScene: SceneSummary | null = null;

  // S5 snapshot ring (Bud-applied operations only)
  private snapshotRing = new SnapshotRing();
  private pendingUndo: PendingUndo | null = null;
  private pendingRedo: PendingRedo | null = null;
  private pendingRestore: PendingRestore | null = null;

  // S2 session state
  private isSessionActive = false;
  private sessionStartedAt?: number;
  private restoredMuteState = false;
  private hudState: CanvasHUDState = 'idle';

  // S4 in-memory proposal store (local-only for this slice)
  private proposals = new Map<string, ExcalidrawProposal>();
  private activeProposalId: string | null = null;
  private defaultProposalTtlMs = 600_000; // 10 minutes

  constructor(options: ExcalidrawControllerOptions) {
    this.windowManager = options.windowManager;
    this.getMuted = options.getMuted;
    this.toggleMute = options.toggleMute;
    this.getSettings = options.getSettings;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Inject or replace the settings provider after app startup. */
  setSettingsProvider(getSettings: () => AppSettings): void {
    this.getSettings = getSettings;
  }

  /** Open the canvas window, or bring it to the foreground if it already exists. */
  async openCanvas(): Promise<void> {
    await this.windowManager.openOrFocus();
  }

  /** Alias used by callers that want to emphasize focusing an existing canvas. */
  async focusCanvas(): Promise<void> {
    await this.windowManager.openOrFocus();
  }

  /**
   * Ask the renderer for a compact scene summary and return it.
   * Creates/focuses the window first and enforces a request timeout.
   */
  async readScene(): Promise<SceneSummary> {
    await this.windowManager.openOrFocus();

    return new Promise<SceneSummary>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingScenes.delete(requestId);
        reject(new Error(`readScene timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingScenes.set(requestId, { resolve, reject, timer });

      this.windowManager.sendToCanvas('canvas:request-scene', {
        requestId,
      } as CanvasSceneRequest);
    });
  }

  /** Handle a renderer response to a prior `readScene()` request. */
  handleSceneResponse(response: CanvasSceneResponse): void {
    const pending = this.pendingScenes.get(response.requestId);
    if (!pending) {
      console.warn(`⚠️ ExcalidrawController: unmatched scene response ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingScenes.delete(response.requestId);
    pending.resolve(response.scene);
  }

  /** Receive periodic scene summaries published by the renderer on every change. */
  onSceneChange(scene: SceneSummary): void {
    this.latestScene = scene;

    // S5: a pending undo/redo is considered successful when the scene version
    // changes from the baseline captured just before the command was sent.
    if (this.pendingUndo && !this.pendingUndo.settled && scene.sceneVersion !== this.pendingUndo.baselineVersion) {
      this.settleNativeUndo(scene.sceneVersion);
    }
    if (this.pendingRedo && !this.pendingRedo.settled && scene.sceneVersion !== this.pendingRedo.baselineVersion) {
      this.settleNativeRedo(scene.sceneVersion);
    }
  }

  /** Return the most recently observed scene summary, if any. */
  getLatestScene(): SceneSummary | null {
    return this.latestScene;
  }

  /**
   * Apply a high-level, controller-approved Excalidraw operation.
   *
   * 1. Classifies the operation through the deterministic safety gate.
   * 2. For immediate-safe ops, sends a controller-generated patch to the
   *    renderer via `canvas:apply-scene` and waits for `canvas:apply-response`.
   * 3. For destructive/large/ambiguous/unsupported ops, returns the
   *    corresponding structured status without mutating the scene.
   */
  async applyOperation(op: ExcalidrawOperation): Promise<ApplyResult> {
    const scene = this.latestScene ?? (await this.readScene());
    const settings = this.getExcalidrawSettings();
    const classification = classifyOperation(op, { scene, settings });

    if (classification.decision === 'requires_confirmation') {
      return { status: 'requires_confirmation', reason: classification.reason ?? 'Operation requires confirmation.' };
    }
    if (classification.decision === 'unsupported') {
      return { status: 'unsupported', reason: classification.reason ?? 'Operation is not supported in S3.' };
    }
    if (classification.decision === 'not_found') {
      return { status: 'not_found', ids: classification.notFoundIds ?? [], reason: classification.reason ?? 'Target elements not found.' };
    }
    if (classification.decision === 'error') {
      return { status: 'error', reason: classification.reason ?? 'Safety gate error.' };
    }

    // Resolve any omitted target ids against the current selection before applying.
    const resolvedOp = this.resolveOperationTargets(op, scene);
    if (!resolvedOp) {
      return { status: 'not_found', ids: [], reason: 'No target ids provided and no current selection to resolve targets.' };
    }

    return this.commitOperations([resolvedOp]);
  }

  /**
   * Controller-internal confirmed apply path.
   *
   * Bypasses the safety gate and is only used to commit operations that have
   * already been stored inside a proposal. Captures a pre-mutation full-scene
   * snapshot before applying so the operation can be undone later.
   */
  private async commitOperations(operations: ExcalidrawOperation[]): Promise<ApplyResult> {
    await this.windowManager.openOrFocus();

    // S5: capture the scene before we mutate it. Failures are logged but do not
    // block the apply; the snapshot fallback simply won't be available.
    await this.captureSnapshotForUndo();

    return new Promise<ApplyResult>((resolve, _reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingApplies.delete(requestId);
        resolve({
          status: 'error',
          reason: `applyOperation timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);

      this.pendingApplies.set(requestId, { resolve, reject: () => {}, timer });

      const request: CanvasApplyRequest = { requestId, operations };
      this.windowManager.sendToCanvas('canvas:apply-scene', request);
    });
  }

  /**
   * Request a private full-scene snapshot from the renderer and push it onto
   * the undo ring. This is only used internally by the controller.
   */
  private async captureSnapshotForUndo(): Promise<void> {
    try {
      const snapshot = await this.requestSnapshot();
      const settings = this.getExcalidrawSettings();
      this.snapshotRing.push(snapshot, {
        maxOperations: settings.snapshotRing.maxOperations,
        maxAgeMs: settings.snapshotRing.maxAgeMs,
      });
    } catch (err: any) {
      console.warn('⚠️ ExcalidrawController: failed to capture pre-mutation snapshot:', err?.message || err);
    }
  }

  /**
   * Ask the renderer for a full internal scene snapshot (elements + appState).
   * This snapshot is never returned to LLM/tool callers.
   */
  async requestSnapshot(): Promise<FullSceneSnapshot> {
    await this.windowManager.openOrFocus();

    return new Promise<FullSceneSnapshot>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingSnapshots.delete(requestId);
        reject(new Error(`requestSnapshot timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingSnapshots.set(requestId, { resolve, reject, timer });

      this.windowManager.sendToCanvas('canvas:request-snapshot', {
        requestId,
      } as CanvasSnapshotRequest);
    });
  }

  /** Handle a renderer response to a prior `requestSnapshot()` call. */
  handleSnapshotResponse(response: CanvasSnapshotResponse): void {
    const pending = this.pendingSnapshots.get(response.requestId);
    if (!pending) {
      console.warn(`⚠️ ExcalidrawController: unmatched snapshot response ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingSnapshots.delete(response.requestId);
    pending.resolve(response.snapshot);
  }

  /** Handle a renderer response to a prior `applyOperation(...)` request. */
  handleApplyResponse(response: CanvasApplyResponse): void {
    const pending = this.pendingApplies.get(response.requestId);
    if (!pending) {
      console.warn(`⚠️ ExcalidrawController: unmatched apply response ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingApplies.delete(response.requestId);
    pending.resolve(response.result);
  }

  // --- S4: proposal lifecycle ---

  /**
   * Create a pending visual proposal instead of committing an operation immediately.
   *
   * - Rejects unsupported/invalid/not_found operations deterministically.
   * - Accepts operations that the S3 safety gate would defer to confirmation.
   * - Supersedes any existing active proposal.
   * - Sends `canvas:render-ghosts` to the renderer.
   * - Does not accept raw scene JSON (`replaceScene`) or import operations.
   */
  async proposeOperation(
    op: ExcalidrawOperation,
    opts?: {
      ttlMs?: number;
      summary?: string;
      mode?: 'diagram_patch' | 'review_options';
      reason?: string;
      options?: ProposalOption[];
    },
  ): Promise<ProposalResult> {
    const scene = this.latestScene ?? (await this.readScene());
    const settings = this.getExcalidrawSettings();
    const classification = classifyOperation(op, { scene, settings });

    if (classification.decision === 'unsupported') {
      return { status: 'unsupported', reason: classification.reason ?? 'Operation is not supported.' };
    }
    if (classification.decision === 'not_found') {
      return { status: 'not_found', ids: classification.notFoundIds ?? [], reason: classification.reason ?? 'Target elements not found.' };
    }
    if (classification.decision === 'error') {
      return { status: 'error', reason: classification.reason ?? 'Safety gate error.' };
    }

    if (op.kind === 'replaceScene' || op.kind === 'importScene') {
      return {
        status: 'unsupported',
        reason: 'Proposals do not accept raw scene replacement or import operations.',
      };
    }

    const resolvedOp = this.resolveOperationTargets(op, scene);
    if (!resolvedOp) {
      return { status: 'not_found', ids: [], reason: 'No target ids could be resolved for the proposal.' };
    }

    // Supersede any existing active proposal before creating the new one.
    await this.cancelProposal(this.activeProposalId ?? '', /* silent */ true);
    this.clearExpiredProposals();

    const proposalId = randomUUID();
    const now = Date.now();
    const ttlMs = opts?.ttlMs ?? this.defaultProposalTtlMs;
    const proposal: ExcalidrawProposal = {
      proposalId,
      mode: opts?.mode ?? 'diagram_patch',
      operations: opts?.mode === 'review_options' && opts?.options?.length ? [] : [resolvedOp],
      options: opts?.options,
      summary: opts?.summary ?? `${op.kind} proposal`,
      reason: opts?.reason ?? classification.reason,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: 'pending',
    };

    this.proposals.set(proposalId, proposal);
    this.activeProposalId = proposalId;

    await this.windowManager.openOrFocus();
    const renderRequest: CanvasRenderGhostsRequest = {
      proposalId,
      mode: proposal.mode,
      operations: proposal.operations,
      options: proposal.options,
      reason: proposal.reason,
      expiresAt: proposal.expiresAt,
    };
    this.windowManager.sendToCanvas('canvas:render-ghosts', renderRequest);
    this.setHUDState('proposalPending');

    return { status: 'pending', proposalId, expiresAt: proposal.expiresAt, reason: proposal.reason };
  }

  /**
   * Commit a stored proposal and remove its ghost elements.
   *
   * For `review_options` proposals, an `optionId` must be supplied; otherwise a
   * `selectOption` result is returned.
   */
  async confirmProposal(proposalId: string, optionId?: string): Promise<ApplyResult> {
    const proposal = this.getActiveProposal(proposalId);
    if (!proposal) {
      return { status: 'not_found', ids: [proposalId], reason: 'Proposal not found or expired.' };
    }

    let operations: ExcalidrawOperation[] = [];
    if (proposal.mode === 'review_options') {
      if (!optionId || !proposal.options?.some((o) => o.optionId === optionId)) {
        return {
          status: 'selectOption',
          proposalId,
          optionIds: proposal.options?.map((o) => o.optionId) ?? [],
        };
      }
      operations = proposal.options.find((o) => o.optionId === optionId)?.operations ?? [];
    } else {
      operations = proposal.operations ?? [];
    }

    if (operations.length === 0) {
      this.cancelProposal(proposalId);
      return { status: 'error', reason: 'Proposal has no operations to apply.' };
    }

    const result = await this.commitOperations(operations);
    proposal.status = 'confirmed';
    this.clearGhostsForProposal(proposalId);
    if (this.activeProposalId === proposalId) {
      this.activeProposalId = null;
    }
    this.setHUDStateFromSession();
    return result;
  }

  /**
   * Cancel a pending proposal and remove its ghost elements without committing.
   */
  async cancelProposal(proposalId: string, silent = false): Promise<ProposalResult> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      if (!silent) {
        return { status: 'not_found', ids: [proposalId], reason: 'Proposal not found.' };
      }
      return { status: 'cancelled', proposalId };
    }

    if (proposal.status !== 'pending') {
      if (!silent) {
        return { status: 'error', reason: `Proposal is ${proposal.status}.` };
      }
      return { status: 'cancelled', proposalId };
    }

    if (Date.now() > proposal.expiresAt) {
      proposal.status = 'expired';
      this.clearGhostsForProposal(proposalId);
      if (this.activeProposalId === proposalId) {
        this.activeProposalId = null;
      }
      return { status: 'not_found', ids: [proposalId], reason: 'Proposal expired.' };
    }

    proposal.status = 'cancelled';
    this.clearGhostsForProposal(proposalId);
    if (this.activeProposalId === proposalId) {
      this.activeProposalId = null;
    }
    this.setHUDStateFromSession();
    return { status: 'cancelled', proposalId };
  }

  /**
   * Voice-compatible "change that" primitive.
   *
   * Cancels the referenced active proposal and creates a new pending proposal
   * from the revised operation.
   */
  async reviseProposal(
    proposalId: string,
    revisedOperation: ExcalidrawOperation,
    opts?: {
      ttlMs?: number;
      summary?: string;
      mode?: 'diagram_patch' | 'review_options';
      reason?: string;
    },
  ): Promise<ProposalResult> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending' || Date.now() > proposal.expiresAt) {
      return { status: 'not_found', ids: [proposalId], reason: 'No active proposal to revise.' };
    }

    await this.cancelProposal(proposalId);
    return this.proposeOperation(revisedOperation, opts);
  }

  /** Expire any pending proposals past their TTL and clear their ghosts. */
  clearExpiredProposals(): void {
    const now = Date.now();
    for (const [id, proposal] of this.proposals) {
      if (proposal.status === 'pending' && now > proposal.expiresAt) {
        proposal.status = 'expired';
        this.clearGhostsForProposal(id);
        if (this.activeProposalId === id) {
          this.activeProposalId = null;
        }
      }
    }
  }

  /**
   * Clear all active/pending proposals without committing.
   *
   * Safe/idempotent when no proposal is active. Expired proposals are marked
   * expired; remaining pending proposals are marked superseded. Ghosts are
   * cleared, the active proposal id is reset, and the HUD returns to the
   * session/idle state.
   */
  clearProposals(): void {
    const now = Date.now();
    let hadPending = false;
    for (const [id, proposal] of this.proposals) {
      if (proposal.status !== 'pending') continue;
      hadPending = true;
      if (now > proposal.expiresAt) {
        proposal.status = 'expired';
      } else {
        proposal.status = 'superseded';
      }
      this.clearGhostsForProposal(id);
      if (this.activeProposalId === id) {
        this.activeProposalId = null;
      }
    }
    if (hadPending) {
      this.setHUDStateFromSession();
    }
  }

  /** Handle a renderer acknowledgement or error for ghost render/clear. */
  handleGhostResponse(response: CanvasGhostResponse): void {
    if (response.status === 'error') {
      console.warn(
        `⚠️ ExcalidrawController: ghost ${response.action} failed for ${response.proposalId}:`,
        response.reason,
      );
    }
  }

  // --- S5: undo / redo -------------------------------------------------------

  /**
   * Undo the last Bud-applied mutation.
   *
   * 1. If the snapshot ring is empty, there is nothing controller-owned to undo.
   * 2. Try Excalidraw's native undo (CommandOrControl+Z) in the renderer.
   * 3. If the scene version does not change within the timeout, fall back to
   *    restoring the most recent controller-managed snapshot.
   */
  async undo(): Promise<UndoResult> {
    if (this.snapshotRing.isEmpty()) {
      return { status: 'nothingToUndo' };
    }

    // Drop any active proposal/ghosts before reverting so ghosts do not become
    // part of the restored scene.
    this.clearProposals();

    await this.windowManager.openOrFocus();
    const baselineVersion = this.latestScene?.sceneVersion ?? (await this.readScene()).sceneVersion;

    return new Promise<UndoResult>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        if (this.pendingUndo?.requestId === requestId) {
          this.pendingUndo = null;
          this.restoreSnapshotFallback(resolve, baselineVersion);
        }
      }, this.timeoutMs);

      this.pendingUndo = {
        requestId,
        baselineVersion,
        resolve,
        timer,
        settled: false,
      };

      this.windowManager.sendToCanvas('canvas:undo-native', {
        requestId,
      } as CanvasUndoNativeRequest);
    });
  }

  /** Handle the renderer's acknowledgement after a native undo attempt. */
  handleUndoNativeResponse(response: CanvasUndoNativeResponse): void {
    if (!this.pendingUndo || this.pendingUndo.requestId !== response.requestId) {
      return;
    }

    if (response.changed === true ||
      (response.sceneVersion !== undefined && response.sceneVersion !== this.pendingUndo.baselineVersion)) {
      this.settleNativeUndo(response.sceneVersion ?? this.latestScene?.sceneVersion ?? this.pendingUndo.baselineVersion);
      return;
    }

    // The renderer reported no change. Do not settle yet — wait for the next
    // `canvas:scene-change` or the undo timeout. This avoids races where the
    // scene change event arrives after the explicit response.
  }

  private settleNativeUndo(sceneVersion?: number): void {
    const pending = this.pendingUndo;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pendingUndo = null;
    clearTimeout(pending.timer);

    // Remove the snapshot that corresponds to the now-undone operation.
    this.snapshotRing.pop();

    const finalVersion = sceneVersion ?? this.latestScene?.sceneVersion ?? pending.baselineVersion;
    pending.resolve({ status: 'undone', via: 'native', sceneVersion: finalVersion });
  }

  /**
   * Best-effort redo after a successful undo.
   *
   * Uses Excalidraw's native redo shortcut (CommandOrControl+Y or
   * CommandOrControl+Shift+Z). There is no snapshot fallback because controller
   // driven mutations can invalidate Excalidraw's history stack.
   */
  async redo(): Promise<UndoResult> {
    await this.windowManager.openOrFocus();
    const baselineVersion = this.latestScene?.sceneVersion ?? (await this.readScene()).sceneVersion;

    return new Promise<UndoResult>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        if (this.pendingRedo?.requestId === requestId) {
          this.pendingRedo = null;
          resolve({ status: 'nothingToUndo' });
        }
      }, this.timeoutMs);

      this.pendingRedo = {
        requestId,
        baselineVersion,
        resolve,
        timer,
        settled: false,
      };

      this.windowManager.sendToCanvas('canvas:redo-native', {
        requestId,
      } as CanvasRedoNativeRequest);
    });
  }

  /** Handle the renderer's acknowledgement after a native redo attempt. */
  handleRedoNativeResponse(response: CanvasRedoNativeResponse): void {
    if (!this.pendingRedo || this.pendingRedo.requestId !== response.requestId) {
      return;
    }

    if (response.changed === true ||
      (response.sceneVersion !== undefined && response.sceneVersion !== this.pendingRedo.baselineVersion)) {
      this.settleNativeRedo(response.sceneVersion ?? this.latestScene?.sceneVersion ?? this.pendingRedo.baselineVersion);
    }
  }

  private settleNativeRedo(sceneVersion?: number): void {
    const pending = this.pendingRedo;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pendingRedo = null;
    clearTimeout(pending.timer);

    const finalVersion = sceneVersion ?? this.latestScene?.sceneVersion ?? pending.baselineVersion;
    pending.resolve({ status: 'undone', via: 'native', sceneVersion: finalVersion });
  }

  /** Handle the renderer's response to a snapshot restore request. */
  handleRestoreSnapshotResponse(response: CanvasRestoreSnapshotResponse): void {
    const pending = this.pendingRestore;
    if (!pending) {
      console.warn(`⚠️ ExcalidrawController: unmatched restore-snapshot response ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRestore = null;

    if (response.result.status === 'restored') {
      pending.resolve({
        status: 'undone',
        via: 'snapshot',
        sceneVersion: response.result.sceneVersion ?? this.latestScene?.sceneVersion ?? 0,
      });
    } else {
      pending.resolve({ status: 'error', reason: response.result.reason || 'Snapshot restore failed.' });
    }
  }

  private restoreSnapshotFallback(resolve: (result: UndoResult) => void, _baselineVersion: number): void {
    const snapshot = this.snapshotRing.pop();
    if (!snapshot) {
      resolve({ status: 'nothingToUndo' });
      return;
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      this.pendingRestore = null;
      resolve({ status: 'error', reason: `restoreSnapshot timed out after ${this.timeoutMs}ms` });
    }, this.timeoutMs);

    this.pendingRestore = { resolve, reject: () => {}, timer };

    this.windowManager.sendToCanvas('canvas:restore-snapshot', {
      requestId,
      snapshot,
    } as CanvasRestoreSnapshotRequest);
  }

  /** Return a copy of the in-memory proposals for introspection/testing. */
  getProposals(): Map<string, ExcalidrawProposal> {
    return new Map(this.proposals);
  }

  private getActiveProposal(proposalId: string): ExcalidrawProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;
    if (proposal.status !== 'pending') return null;
    if (Date.now() > proposal.expiresAt) {
      proposal.status = 'expired';
      this.clearGhostsForProposal(proposalId);
      if (this.activeProposalId === proposalId) {
        this.activeProposalId = null;
      }
      return null;
    }
    return proposal;
  }

  private clearGhostsForProposal(proposalId: string): void {
    const request: CanvasClearGhostsRequest = { proposalId };
    this.windowManager.sendToCanvas('canvas:clear-ghosts', request);
  }

  private resolveOperationTargets(op: ExcalidrawOperation, scene: SceneSummary): ExcalidrawOperation | null {
    const needsIds = ['update', 'delete', 'align', 'distribute', 'group', 'ungroup', 'reorganizeLayout'].includes(
      op.kind,
    );
    if (!needsIds) return op;

    const ids = (op as any).ids ?? scene.selection;
    if (!Array.isArray(ids) || ids.length === 0) {
      return null;
    }
    return { ...op, ids } as ExcalidrawOperation;
  }

  private getExcalidrawSettings() {
    return (
      this.getSettings?.().excalidraw ?? {
        toggleHotkey: 'CommandOrControl+Shift+Space',
        saveDirectory: '',
        autosaveIntervalMs: 5000,
        theme: 'auto',
        safetyThresholds: { maxElementsPerImmediateApply: 5, maxElementsPerDelete: 3 },
        snapshotRing: { maxOperations: 50, maxAgeMs: 1_800_000 },
      }
    );
  }

  // --- S2: canvas-scoped voice session toggle ---

  /** Toggle the canvas voice session on/off. Returns the new active state. */
  async toggleSession(): Promise<boolean> {
    if (this.isSessionActive) {
      await this.endSession();
    } else {
      await this.startSession();
    }
    return this.isSessionActive;
  }

  /** Open/focus the canvas and start a continuous voice session scoped to it. */
  async startSession(): Promise<void> {
    await this.openCanvas();

    this.isSessionActive = true;
    this.sessionStartedAt = Date.now();

    if (!this.getMuted || !this.toggleMute) {
      console.warn('⚠️ Excalidraw voice session started without realtime mute callbacks — canvas will not control listening state');
      this.restoredMuteState = false;
    } else {
      const currentlyMuted = this.getMuted();
      if (currentlyMuted) {
        this.restoredMuteState = true;
        this.toggleMute();
        console.log('🎙️ Excalidraw voice session unmuted Realtime');
      } else {
        this.restoredMuteState = false;
      }
    }

    this.setHUDState('listening');
    console.log('🎨 Excalidraw voice session started');
  }

  /**
   * End the canvas voice session while keeping the canvas window and sketch open.
   * Restores the mute state if the session had to unmute Realtime.
   */
  async endSession(): Promise<void> {
    this.isSessionActive = false;
    this.sessionStartedAt = undefined;

    if (this.restoredMuteState && this.getMuted && this.toggleMute) {
      const currentlyMuted = this.getMuted();
      if (!currentlyMuted) {
        this.toggleMute();
        console.log('🎙️ Excalidraw voice session restored Realtime mute');
      }
    }
    this.restoredMuteState = false;

    this.setHUDState('idle');
    console.log('🎨 Excalidraw voice session ended');
  }

  /** Return the current session state (active + HUD). */
  getSessionState(): ExcalidrawSessionState {
    return {
      isActive: this.isSessionActive,
      startedAt: this.sessionStartedAt,
      hudState: this.hudState,
    };
  }

  /** Send a HUD state update to the canvas renderer if the window is alive. */
  private setHUDState(state: CanvasHUDState): void {
    this.hudState = state;
    const payload: CanvasHUDPayload = { state };
    this.windowManager.sendToCanvas('canvas:hud', payload);
  }

  private setHUDStateFromSession(): void {
    this.setHUDState(this.isSessionActive ? 'listening' : 'idle');
  }
}
