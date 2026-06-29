/**
 * Bud — Action Parser
 *
 * Parses [ACTION:type(args):label] tags from VLM step-execution responses.
 * Each tag maps to a physical desktop action (click, type, press, etc.).
 *
 * Same parsing pattern as pointingParser.ts — extract a tag from the end
 * of a VLM response and return a structured object.
 */

// --- Action Types ---

export type ActionType =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'launch'
  | 'shell'
  | 'done';

export type ScrollDirection = 'up' | 'down';

// --- Parsed Action (Discriminated Union) ---

export type ParsedAction =
  | { type: 'click'; x: number; y: number; label: string }
  | { type: 'double_click'; x: number; y: number; label: string }
  | { type: 'right_click'; x: number; y: number; label: string }
  | { type: 'type'; text: string; label: string }
  | { type: 'press'; key: string; label: string }
  | { type: 'scroll'; x: number; y: number; direction: ScrollDirection; amount: number; label: string }
  | { type: 'wait'; ms: number; label: string }
  | { type: 'launch'; target: string; label: string }
  | { type: 'shell'; command: string; label: string }
  | { type: 'done'; summary: string; label: string };

// --- Parser ---

/**
 * Parse an [ACTION:type(args):label] tag from a VLM response.
 *
 * Examples:
 *   [ACTION:click(450,52):address bar]
 *   [ACTION:type("console.aws.amazon.com"):url input]
 *   [ACTION:press("Ctrl+T"):new tab]
 *   [ACTION:scroll(500,400,down,3):scroll page]
 *   [ACTION:wait(2000):loading]
 *   [ACTION:launch("chrome"):app launch]
 *   [ACTION:done("navigated to aws"):task complete]
 *   [ACTION:double_click(200,300):icon]
 *   [ACTION:right_click(800,600):context menu]
 */
export function parseAction(response: string): ParsedAction | null {
  // Match [ACTION:type(args):label] — the tag should be the primary content
  const pattern = /\[ACTION:(\w+)\(([^)]*)\)(?::([^\]]*))?\]/;
  const match = response.match(pattern);

  if (!match) return null;

  const actionType = match[1];
  const argsRaw = match[2];
  const label = match[3]?.trim() || '';

  try {
    switch (actionType) {
      case 'click':
        return parseCoordinateAction('click', argsRaw, label);
      case 'double_click':
        return parseCoordinateAction('double_click', argsRaw, label);
      case 'right_click':
        return parseCoordinateAction('right_click', argsRaw, label);
      case 'type':
        return { type: 'type', text: stripQuotes(argsRaw), label };
      case 'press':
        return { type: 'press', key: stripQuotes(argsRaw), label };
      case 'scroll':
        return parseScrollAction(argsRaw, label);
      case 'wait':
        return { type: 'wait', ms: parseInt(argsRaw, 10) || 1000, label };
      case 'launch':
        return { type: 'launch', target: stripQuotes(argsRaw), label };
      case 'shell':
        return { type: 'shell', command: stripQuotes(argsRaw), label };
      case 'done':
        return { type: 'done', summary: stripQuotes(argsRaw), label };
      default:
        console.warn(`⚠️ Unknown action type: ${actionType}`);
        return null;
    }
  } catch (err) {
    console.warn(`⚠️ Failed to parse action: ${response}`, err);
    return null;
  }
}

// --- Helpers ---

function parseCoordinateAction(
  type: 'click' | 'double_click' | 'right_click',
  argsRaw: string,
  label: string
): ParsedAction {
  const parts = argsRaw.split(',').map((s) => s.trim());
  const x = parseInt(parts[0], 10);
  const y = parseInt(parts[1], 10);

  if (isNaN(x) || isNaN(y)) {
    throw new Error(`Invalid coordinates: ${argsRaw}`);
  }

  return { type, x, y, label };
}

function parseScrollAction(argsRaw: string, label: string): ParsedAction {
  const parts = argsRaw.split(',').map((s) => s.trim());
  const x = parseInt(parts[0], 10);
  const y = parseInt(parts[1], 10);
  const direction = (parts[2] || 'down') as ScrollDirection;
  const amount = parseInt(parts[3], 10) || 3;

  if (isNaN(x) || isNaN(y)) {
    throw new Error(`Invalid scroll coordinates: ${argsRaw}`);
  }
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`Invalid scroll direction: ${direction}`);
  }

  return { type: 'scroll', x, y, direction, amount, label };
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
