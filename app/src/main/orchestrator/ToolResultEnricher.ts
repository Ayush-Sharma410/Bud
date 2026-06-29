/**
 * Bud — Tool Result Enricher
 *
 * Adds post-tool context to tool results so the orchestrator model can
 * verify outcomes and recover from errors:
 *   - screenshots after GUI actions
 *   - stdout summaries after shell commands
 *   - structured error context
 */

import { ScreenCapture } from '../screenCapture';

export interface EnrichedResult {
  /** Success flag. */
  success: boolean;
  /** Human-readable detail. */
  detail: string;
  /** Optional image payload for the model. */
  image?: { data: string; mimeType: string };
  /** Optional structured content array for multi-modal messages. */
  content?: any[];
  /** Optional error context. */
  error?: string;
  /** Allow arbitrary tool-specific fields to pass through. */
  [key: string]: any;
}

export async function enrichToolResult(
  toolName: string,
  rawResult: any
): Promise<EnrichedResult> {
  const result = normalizeResult(rawResult);

  // Auto-screenshot after computerUse GUI actions
  if (toolName === 'computerUse') {
    const action = result?.input?.action || result?.action;
    const needsScreenshot =
      action &&
      ['click', 'doubleClick', 'rightClick', 'type', 'press', 'scroll'].includes(action);

    if (needsScreenshot) {
      try {
        const captures = await ScreenCapture.captureAllScreens();
        if (captures && captures.length > 0) {
          return {
            ...result,
            image: { data: captures[0].imageBase64, mimeType: 'image/jpeg' },
          };
        }
      } catch (err) {
        console.warn('⚠️ Could not capture screenshot after computerUse action:', err);
      }
    }
  }

  // Summarize long shell stdout
  if (toolName === 'windowsTool' && result?.stdout && result.stdout.length > 2000) {
    return {
      ...result,
      stdout: summarizeText(result.stdout, 2000),
      detail: result.detail || 'Shell command executed (output summarized)',
    };
  }

  return result;
}

function normalizeResult(raw: any): EnrichedResult {
  if (raw === null || raw === undefined) {
    return { success: true, detail: 'No result returned' };
  }

  if (typeof raw === 'string') {
    return { success: true, detail: raw };
  }

  const success = raw.success !== false;
  const detail =
    raw.detail || raw.message || raw.error || (success ? 'Executed successfully' : 'Execution failed');

  return {
    success,
    detail,
    image: raw.image,
    content: raw.content,
    error: raw.error,
  };
}

function summarizeText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const head = text.slice(0, Math.floor(maxLength * 0.6));
  const tail = text.slice(-Math.floor(maxLength * 0.3));
  return `${head}\n... [${text.length - head.length - tail.length} chars omitted] ...\n${tail}`;
}
