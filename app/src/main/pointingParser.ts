/**
 * Bud — Pointing Parser
 *
 * Parses [POINT:x,y:label:screenN] tags from VLM responses.
 * These tags tell the companion cursor where to fly to on screen.
 *
 * Direct port of: CompanionManager.swift parsePointingCoordinates()
 * (lines 784–822)
 */

export interface PointingParseResult {
  /** Response text with the [POINT:...] tag removed — this is what gets spoken */
  spokenText: string;
  /** Parsed pixel coordinate, or null if "none" or no tag found */
  coordinate: { x: number; y: number } | null;
  /** Short label describing the element (e.g. "run button") */
  elementLabel: string | null;
  /** Which screen the coordinate refers to (1-based), or null for cursor screen */
  screenNumber: number | null;
}

/**
 * Parse a [POINT:x,y:label:screenN] or [POINT:none] tag from the end
 * of a VLM response. Returns the spoken text (tag removed) and the
 * optional coordinate + label + screen number.
 *
 * Tag format examples:
 *   [POINT:none]
 *   [POINT:400,200:save button]
 *   [POINT:400,200:terminal:screen2]
 */
export function parsePointingCoordinates(
  responseText: string
): PointingParseResult {
  // Match [POINT:none] or [POINT:x,y:label] or [POINT:x,y:label:screenN]
  const pattern =
    /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/;

  const match = responseText.match(pattern);

  if (!match) {
    // No tag found at all
    return {
      spokenText: responseText,
      coordinate: null,
      elementLabel: null,
      screenNumber: null,
    };
  }

  // Remove the tag from the spoken text
  const tagIndex = responseText.lastIndexOf(match[0]);
  const spokenText = responseText
    .substring(0, tagIndex)
    .trimEnd();

  // Check if it's [POINT:none] — captured groups will be undefined
  if (!match[1] || !match[2]) {
    return {
      spokenText,
      coordinate: null,
      elementLabel: 'none',
      screenNumber: null,
    };
  }

  const x = parseInt(match[1], 10);
  const y = parseInt(match[2], 10);

  const elementLabel = match[3]?.trim() || null;

  const screenNumber = match[4] ? parseInt(match[4], 10) : null;

  return {
    spokenText,
    coordinate: { x, y },
    elementLabel,
    screenNumber,
  };
}
