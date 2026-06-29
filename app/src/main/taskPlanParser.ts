/**
 * Bud — Computer Use Response Parser
 *
 * Detects and parses the VLM's computer-use response format.
 * The VLM returns either:
 *   - A JSON object { "narration": "...", "action": "computer_use" } → agent task
 *   - Plain conversational text → TTS
 *
 * This module handles the detection and parsing of the computer-use case.
 */

// --- Types ---

export interface AgentGoal {
  /** The VLM's casual acknowledgment (spoken via TTS) */
  narration: string;
}

// --- Quick Detection ---

/**
 * Check whether a VLM response signals computer use rather than conversation.
 * Looks for the JSON { "narration": "...", "action": "computer_use" } format.
 */
export function isComputerUseResponse(response: string): boolean {
  const trimmed = response.trim();
  const jsonStr = extractJSON(trimmed);
  if (!jsonStr) return false;
  return jsonStr.includes('"action"') && jsonStr.includes('"computer_use"');
}

// --- Full Parser ---

/**
 * Parse the VLM's computer-use response into an AgentGoal.
 * Returns null if the response doesn't match the expected format.
 */
export function parseComputerUseResponse(response: string): AgentGoal | null {
  const trimmed = response.trim();

  const jsonStr = extractJSON(trimmed);
  if (!jsonStr) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn('⚠️ Computer use response parse failed: invalid JSON');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.narration !== 'string') {
    console.warn('⚠️ Computer use response missing "narration" field');
    return null;
  }
  if (parsed.action !== 'computer_use') {
    console.warn('⚠️ Computer use response has wrong "action" value');
    return null;
  }

  return {
    narration: parsed.narration,
  };
}

// --- Helpers ---

/**
 * Extract JSON from a response that might be wrapped in markdown code fences.
 */
function extractJSON(text: string): string | null {
  // Try raw text first
  if (text.startsWith('{')) return text;

  // Try extracting from ```json ... ``` or ``` ... ```
  const codeBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  const match = text.match(codeBlockPattern);
  if (match && match[1].trim().startsWith('{')) {
    return match[1].trim();
  }

  return null;
}
