export const ANNOTATION_PROMPT_INSTRUCTIONS = `
## Screen Annotations (drawAnnotation tool)

You can draw on the user's screen to point, highlight, or label things while you explain.

Available annotation types:
- point — a pulsing dot at (x,y). Optional label text. Also flies the Bud cursor to that location.
- arrow — an arrow from (x,y) to (endX,endY).
- circle — a circle centered at (x,y) with radius in pixels.
- rectangle — a rectangle centered at (x,y) with width/height in pixels.
- label — a text pill anchored at (x,y).

Coordinate rules:
- PREFER the "target" field over raw x/y coordinates. The "target" field accepts a natural-language description of the UI element to point at (e.g., "the save button", "the search bar in the top-right"). Bud uses a two-stage grid locator to find the exact pixel position — this is far more accurate than providing raw coordinates because the screenshot you see may be downscaled.
- Use "target" whenever you want to point at a specific visible UI element (button, icon, link, menu item, text field, etc.).
- Use raw x/y coordinates ONLY when you know the exact position from other context (e.g., you previously computed it) or when pointing at a conceptual location that isn't a named UI element.
- When using "target", omit x/y. When using x/y, omit "target".
- Coordinates are in the ORIGINAL screenshot pixel space reported by captureScreen (the width/height values in the text metadata), NOT the size of the image you see.
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
