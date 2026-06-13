# Cursor Annotation Design

**Date:** 2026-06-14  
**Scope:** Enable Bud's agent (Realtime voice + Chat Agent Panel) to point, draw, and write on screen through the custom cursor overlay.  
**Status:** Design approved.

## 1. Goal

Let the agent annotate the user's screen to teach or guide them: point at UI elements, draw arrows between elements, circle or highlight regions, and drop text labels. Annotations appear on the transparent companion overlay and fade out automatically after each response.

## 2. Non-Goals

- Freeform pen/ink strokes drawn by the cursor in real time.
- Persistent annotations that survive across turns.
- User-initiated drawing or whiteboard mode.
- Changing system cursor icons or injecting input events.

## 3. Architecture Overview

A new annotation subsystem is added alongside the existing overlay. Both the Realtime voice agent and the Chat Agent Panel invoke the same `drawAnnotation` tool. The tool is backed by a main-process `AnnotationController` that validates arguments, converts coordinates, and pushes normalized overlay coordinates to the renderer. The overlay renderer draws simple SVG/DOM annotations and manages their fade-out lifecycle.

```
Realtime response          Chat response
     │                          │
     ▼                          ▼
 drawAnnotation()           drawAnnotation()
     │                          │
     └──────────┬───────────────┘
                ▼
      AnnotationController (main process)
      - parse/validate args
      - convert screenshot pixels → virtual-screen coords
      - manage fade-out lifecycle
                │
                ▼
      IPC: draw-annotations → overlay/index.html
                │
                ▼
      AnnotationRenderer (DOM/SVG)
      - draw arrows, circles, rectangles, labels, points
      - animate in / fade out
```

## 4. Components

### 4.1 `app/src/main/annotations/AnnotationController.ts`

Single source of truth for annotation state in the main process.

**Responsibilities:**
- Expose `render(args: DrawAnnotationArgs): Promise<AnnotationResult>`.
- Validate and normalize each annotation item.
- Convert screenshot-pixel coordinates to overlay virtual-screen coordinates.
- Send `draw-annotations` IPC messages to the overlay window.
- Schedule automatic clear after the response; expose `clearAnnotations()` for interruptions and new turns.

### 4.2 `app/src/main/annotations/annotationTypes.ts`

Shared TypeScript types:

```ts
export type AnnotationType = 'point' | 'arrow' | 'circle' | 'rectangle' | 'label';

export interface Annotation {
  type: AnnotationType;
  screenIndex?: number;
  x: number;
  y: number;
  // arrow: (x,y) is tail, (endX,endY) is head
  endX?: number;
  endY?: number;
  // circle: (x,y) is center
  radius?: number;
  // rectangle: (x,y) is center
  width?: number;
  height?: number;
  // label: (x,y) is top-left anchor of the pill
  text?: string;
  // point: (x,y) is dot center
  label?: string;
}

export interface DrawAnnotationArgs {
  annotations: Annotation[];
}

export interface AnnotationResult {
  success: boolean;
  count?: number;
  error?: string;
}
```

### 4.3 `app/src/main/annotations/createDrawAnnotationTool.ts`

Factory that returns both:
- A Vercel AI SDK `tool()` for the Chat Agent Panel.
- A `ToolExecutor` object for the Realtime Tool Bridge.

Both wrap the same `AnnotationController.render()` call.

### 4.4 `app/src/renderer/overlay/annotationRenderer.js`

Small renderer-side module imported by `overlay/index.html`.

**Responsibilities:**
- Listen for `draw-annotations` IPC events.
- Render annotations as absolutely positioned SVG/DOM elements.
- Handle entrance animations and timed fade-out.
- Expose `renderAnnotations(items)` and `clearAnnotations()`.

### 4.5 `app/src/main/annotations/annotationPrompt.ts`

Short instruction paragraph appended to both `BUD_SYSTEM_PROMPT` and `COMPANION_PROMPT` telling the agents when and how to call `drawAnnotation`.

### 4.6 Modified Files

- `app/src/main/main.ts`: import and register `drawAnnotation` with both realtime and chat tool sets.
- `app/src/main/preload.ts`: add `onDrawAnnotations` IPC listener.
- `app/src/renderer/overlay/index.html`: add `#annotations` container, import `annotationRenderer.js`, and wire `window.budAPI.onDrawAnnotations(...)`.

## 5. Tool Schema

```json
{
  "type": "object",
  "properties": {
    "annotations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["point", "arrow", "circle", "rectangle", "label"]
          },
          "screenIndex": {
            "type": "integer",
            "description": "0-based index of the screen from the most recent captureScreen result. Defaults to the primary/cursor screen."
          },
          "x": { "type": "number", "description": "X coordinate in screenshot pixels. Anchor depends on type: arrow tail, circle/rectangle center, label top-left, point center." },
          "y": { "type": "number", "description": "Y coordinate in screenshot pixels. Anchor depends on type: arrow tail, circle/rectangle center, label top-left, point center." },
          "endX": { "type": "number", "description": "For arrow: x coordinate of the arrow head." },
          "endY": { "type": "number", "description": "For arrow: y coordinate of the arrow head." },
          "radius": { "type": "number", "description": "For circle: radius in screenshot pixels." },
          "width": { "type": "number", "description": "For rectangle: width in screenshot pixels." },
          "height": { "type": "number", "description": "For rectangle: height in screenshot pixels." },
          "text": { "type": "string", "description": "For label: text to display." },
          "label": { "type": "string", "description": "For point: short 1-3 word description." }
        },
        "required": ["type", "x", "y"]
      }
    }
  },
  "required": ["annotations"]
}
```

### Agent Instructions

- Coordinates are in **screenshot pixel space**, top-left origin, matching the most recent `captureScreen` result.
- `screenIndex` is 0-based and defaults to the screen the cursor is on.
- Call `drawAnnotation` only when pointing/drawing genuinely helps explain something on screen.
- Keep annotations sparse — 1–3 items per turn is usually enough.
- Combine primitives to clarify: e.g., a `circle` plus an `arrow` plus a `label`.

## 6. Coordinate Mapping

1. Agent supplies `(x, y)` in the screenshot pixel space of the captured screen.
2. `AnnotationController` looks up the matching `Electron.Display` by `screenIndex`.
3. Compute scale factor = `display.bounds.width / screenshotWidth`.
4. Convert to virtual-screen coordinates:
   - `overlayX = display.bounds.x + x * scaleFactor`
   - `overlayY = display.bounds.y + y * scaleFactor`
5. Send `{ x: overlayX, y: overlayY, ... }` to the overlay renderer.

The overlay window already spans all displays (`OverlayManager.getCombinedBounds`), so virtual-screen coordinates map directly to absolute positions inside the overlay.

## 7. Lifecycle

- **Created:** when `drawAnnotation` is called.
- **Animated in:** 200ms scale from 0.8 → 1.0 and opacity 0 → 1.
- **Held:** stays visible while the agent is responding and while audio is playing.
- **Cleared:**
  - when the response finishes and audio playback ends, or
  - after a maximum of 10 seconds, whichever comes first, or
  - immediately on user interruption / new turn.

A new `drawAnnotation` call always replaces the current annotation set; annotations do not accumulate across turns.

## 8. Renderer Details

The overlay renderer adds a new container:

```html
<div id="annotations" style="position:fixed; inset:0; pointer-events:none; z-index:900;"></div>
```

Each annotation becomes an absolutely positioned SVG element:

- **Point:** a small pulsing blue dot (12px) centered on `(x,y)` with a drop shadow.
- **Arrow:** an SVG `<line>` with a `<polygon>` arrowhead.
- **Circle:** an SVG `<circle>` centered on `(x,y)` with a 2px blue stroke, no fill, subtle glow.
- **Rectangle:** an SVG `<rect>` centered on `(x,y)` with a 2px blue stroke, rounded corners, no fill.
- **Label:** a small dark pill with white text and a thin blue border. `(x,y)` is the top-left anchor of the pill.

All primitives share:
- Blue accent color matching the cursor (`#4285F4`).
- Entrance animation: scale 0.8 → 1.0 and opacity 0 → 1 over 200ms.
- Exit animation: opacity 1 → 0 over 300ms before DOM removal.

## 9. Error Handling & Edge Cases

- **Invalid coordinates:** clamp `x`/`y` to the computed screen bounds rather than failing. Log a warning.
- **Unknown annotation type:** skip that item, return success for the rest, and log the unknown type.
- **Missing capture context:** the tool still executes. The agent prompt instructs the model to call `captureScreen` first when it needs to annotate.
- **Overlay not ready:** if the overlay window is destroyed or hidden, `AnnotationController` silently drops the annotation and logs a warning.
- **Multi-monitor DPI scaling:** use `display.bounds` (screen scale factor already applied by Electron) for the overlay, and scale from screenshot pixels using the screenshot's reported width vs. display width.
- **User interruption:** `RealtimeVoiceManager` emits `interruption`; this is wired to `AnnotationController.clearAnnotations()` so stale annotations do not survive into the next turn.
- **Chat vs. realtime race:** annotations are per-turn; a new `drawAnnotation` call replaces the current set.

## 10. Testing Plan

- **Unit test coordinate conversion:** feed known screenshot/display dimensions into `AnnotationController` and assert virtual-screen output coordinates.
- **Unit test tool schema validation:** ensure invalid annotation types are skipped, missing optional fields use defaults, and out-of-range coordinates are clamped.
- **Renderer test:** load `overlay/index.html` in a test harness, simulate `draw-annotations` IPC events, and verify SVG elements appear with correct attributes and fade out after the timeout.
- **Integration test:** register the tool with a mock `RealtimeToolBridge`, invoke `drawAnnotation`, and confirm the overlay IPC channel receives the expected normalized annotations.
- **Manual QA scenarios:**
  - Realtime agent circles a button while explaining.
  - Chat agent draws an arrow between two UI elements.
  - Annotation clears on new voice input.
  - Annotation renders correctly on a secondary monitor.

## 11. Open Questions / Decisions

- **Annotation clear timeout:** default 10 seconds; can be made configurable in settings later if needed.
- **Color theming:** currently fixed to the cursor blue (`#4285F4`). Theming can be added later without changing the architecture.
