/**
 * Bud — Tool Result Enricher
 *
 * Normalizes tool results into a consistent shape for the UI tool-result event.
 * (Screenshot and shell-stdout enrichment were removed with Computer Use and the
 * Windows tool — only generic normalization remains. The model itself receives
 * the raw tool result from the AI SDK; this only shapes the UI payload.)
 */

export interface EnrichedResult {
  success: boolean;
  detail: string;
  content?: any[];
  error?: string;
  [key: string]: any;
}

export async function enrichToolResult(_toolName: string, rawResult: any): Promise<EnrichedResult> {
  return normalizeResult(rawResult);
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
    content: raw.content,
    error: raw.error,
  };
}
