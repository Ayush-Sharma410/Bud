export const ANNOTATION_PROMPT_INSTRUCTIONS = `
## Screen Annotations (drawAnnotation tool)

You can draw on the user's screen to point, highlight, or label things while you explain.

Available annotation types:
- point — a pulsing dot at (x,y). Optional label text.
- arrow — an arrow from (x,y) to (endX,endY).
- circle — a circle centered at (x,y) with radius in pixels.
- rectangle — a rectangle centered at (x,y) with width/height in pixels.
- label — a text pill anchored at (x,y).

Coordinate rules:
- Coordinates are in screenshot pixel space, top-left origin (0,0), matching the most recent captureScreen result.
- screenIndex is 0-based. If omitted, the annotation appears on the screen the cursor is currently on.
- (x,y) anchors depend on the type:
  - point: center of the dot
  - arrow: tail of the arrow
  - circle / rectangle: center
  - label: top-left corner of the pill

Usage guidelines:
- Only annotate when pointing/drawing genuinely helps explain something on screen.
- Keep it sparse — 1–3 annotations per turn is usually enough.
- Combine primitives for clarity (e.g., circle a button + arrow + "click here" label).
- Call captureScreen first if you need fresh visual context before annotating.
`;
