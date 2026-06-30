/**
 * Deterministic safety gate for Excalidraw immediate operations.
 *
 * All decisions are based on operation kind + configured thresholds + current
 * scene context. LLM/tool callers cannot bypass the gate.
 */

import type {
  ExcalidrawOperation,
  SafetyDecision,
  SceneSummary,
} from './excalidrawTypes';
import type { ExcalidrawSettings } from '../settings';

export interface SafetyContext {
  scene: SceneSummary;
  settings: ExcalidrawSettings;
}

export interface SafetyClassification {
  decision: SafetyDecision;
  reason?: string;
  notFoundIds?: string[];
  affectedIds?: string[];
  affectedCount?: number;
}

/**
 * Resolve target ids for operations that accept an optional `ids` field.
 * If ids are omitted, the current selection is used.
 */
function resolveTargetIds(op: ExcalidrawOperation, selection: string[]): string[] | null {
  if (op.kind === 'create' || op.kind === 'clearCanvas' || op.kind === 'replaceScene' || op.kind === 'importScene') {
    return null;
  }
  if ('ids' in op && Array.isArray(op.ids)) {
    return op.ids;
  }
  return selection;
}

/** Build a set of ids that are present in the current scene summary. */
function sceneIdSet(scene: SceneSummary): Set<string> {
  return new Set(scene.elements.map((el) => el.id));
}

function isImmediateSafeUpdate(op: Extract<ExcalidrawOperation, { kind: 'update' }>): boolean {
  const allowed = new Set<keyof import('./excalidrawTypes').ElementChanges>([
    'strokeColor',
    'backgroundColor',
    'fillStyle',
    'strokeWidth',
    'strokeStyle',
    'roughness',
    'opacity',
    'x',
    'y',
    'width',
    'height',
    'angle',
    'text',
  ]);
  for (const key of Object.keys(op.changes)) {
    if (!allowed.has(key as keyof import('./excalidrawTypes').ElementChanges)) return false;
  }
  return true;
}

export function classifyOperation(op: ExcalidrawOperation, context: SafetyContext): SafetyClassification {
  const { scene, settings } = context;
  const maxElements = settings.safetyThresholds.maxElementsPerImmediateApply;
  const ids = resolveTargetIds(op, scene.selection);

  if (ids !== null && ids.length === 0) {
    return {
      decision: 'not_found',
      reason: 'No explicit ids provided and no current selection to resolve targets.',
      notFoundIds: [],
      affectedIds: [],
      affectedCount: 0,
    };
  }

  switch (op.kind) {
    case 'create': {
      return {
        decision: 'immediate',
        affectedIds: op.id ? [op.id] : [],
        affectedCount: 1,
      };
    }

    case 'update': {
      const targets = ids!;
      const sceneIds = sceneIdSet(scene);
      const missing = targets.filter((id) => !sceneIds.has(id));
      if (missing.length > 0) {
        return {
          decision: 'not_found',
          reason: `Ids not found in scene: ${missing.join(', ')}`,
          notFoundIds: missing,
          affectedIds: [],
          affectedCount: 0,
        };
      }
      if (!isImmediateSafeUpdate(op)) {
        return {
          decision: 'requires_confirmation',
          reason: 'Update contains fields outside the immediate-safe allow-list.',
          affectedIds: targets,
          affectedCount: targets.length,
        };
      }
      if (targets.length > maxElements) {
        return {
          decision: 'requires_confirmation',
          reason: `Update affects ${targets.length} elements, exceeding immediate threshold of ${maxElements}.`,
          affectedIds: targets,
          affectedCount: targets.length,
        };
      }
      return {
        decision: 'immediate',
        affectedIds: targets,
        affectedCount: targets.length,
      };
    }

    case 'delete': {
      const targets = ids!;
      const sceneIds = sceneIdSet(scene);
      const missing = targets.filter((id) => !sceneIds.has(id));
      if (missing.length > 0) {
        return {
          decision: 'not_found',
          reason: `Delete targets not found: ${missing.join(', ')}`,
          notFoundIds: missing,
          affectedIds: [],
          affectedCount: 0,
        };
      }
      // S3: all deletes are deferred to the proposal/confirmation flow.
      return {
        decision: 'requires_confirmation',
        reason: `Delete affects ${targets.length} element(s); destructive operations require confirmation in S3.`,
        affectedIds: targets,
        affectedCount: targets.length,
      };
    }

    case 'align':
    case 'distribute':
    case 'group':
    case 'ungroup': {
      // S3 defers geometry-affecting operations to the S4 proposal/confirmation flow.
      const targets = ids ?? [];
      return {
        decision: 'requires_confirmation',
        reason: targets.length > 0
          ? `${op.kind} affects ${targets.length} element(s); geometry/grouping operations require confirmation in S3.`
          : `${op.kind} requires explicit ids or a current selection and is deferred to confirmation in S3.`,
        affectedIds: targets,
        affectedCount: targets.length,
      };
    }

    case 'clearCanvas': {
      return {
        decision: 'requires_confirmation',
        reason: 'clearCanvas is destructive; S3 defers it to the confirmation flow.',
        affectedIds: [],
        affectedCount: scene.elementCount,
      };
    }

    case 'replaceScene': {
      return {
        decision: 'requires_confirmation',
        reason: 'replaceScene is not allowed as an immediate operation in S3.',
        affectedIds: [],
        affectedCount: scene.elementCount,
      };
    }

    case 'reorganizeLayout': {
      const targets = ids ?? [];
      return {
        decision: 'requires_confirmation',
        reason: targets.length > 0
          ? `reorganizeLayout affects ${targets.length} element(s); layout changes require confirmation in S3.`
          : 'Canvas-wide reorganizeLayout is not supported as an immediate S3 operation.',
        affectedIds: targets,
        affectedCount: targets.length || scene.elementCount,
      };
    }

    case 'importScene': {
      return {
        decision: 'unsupported',
        reason: 'importScene is not implemented in Phase 1 S3; use the export/save-as flow.',
        affectedIds: [],
        affectedCount: 0,
      };
    }

    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      return {
        decision: 'unsupported',
        reason: 'Unknown operation kind.',
        affectedIds: [],
        affectedCount: 0,
      };
    }
  }
}
