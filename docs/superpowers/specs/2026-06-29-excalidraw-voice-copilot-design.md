# Excalidraw Voice Copilot Design

**Date:** 2026-06-29
**Status:** Approved
**Scope:** New Excalidraw-first product surface for Bud — voice-driven creation, editing, review, and brainstorming on an embedded Excalidraw canvas. Documentation-only; no application code changes in this spec.

## 1. Goal

Make Bud an Excalidraw-first voice copilot: the user presses a hotkey, an embedded Excalidraw canvas opens/focuses, and Bud holds a continuous voice conversation that creates, edits, reviews, and brainstorms sketchnotes by voice. Bud interprets intent through its LLM layer and drives the canvas through a small set of high-level tools backed by a main-process controller. The user never touches a settings sidebar or a row of approve/decline buttons in the normal flow — confirmation, cancellation, and revision happen by voice.

This is a product direction, not a side mode: Bud's Excalidraw surface is the primary interactive surface for general sketchnoting. It is not optimized only for architecture maps, product diagrams, or flowcharts.

## 2. Non-Goals

- **No external excalidraw.com control in V1.** Bud embeds its own Excalidraw canvas; it does not drive the excalidraw.com web app.
- **No real-time collaboration.** V1 is single-user / local only. Sharing and multi-user editing stay future.
- **No heavy default chat/sidebar interface.** Bud is voice-first. A minimal floating HUD shows passive status only; there are no primary Approve/Decline buttons in the normal flow.
- **No domain-specific lock-in.** The tool surface is general-purpose Excalidraw sketchnoting, not specialized for software architecture, mind maps, or any one diagram family.
- **No canvas editing via mouse automation.** Bud does not move the OS pointer or synthesize clicks to draw. All canvas mutations go through the Excalidraw API/scene, not through `computerUse`/`ActionExecutor`.
- **No reuse of the screen annotation overlay as the canvas.** The existing transparent click-through `OverlayManager`/`AnnotationController` system remains a separate subsystem for pointing at the user's screen. The Excalidraw canvas is its own interactive `BrowserWindow`.

## 3. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Canvas ownership | Bud-owned embedded Excalidraw | Full control of scene, lifecycle, and persistence; no dependency on excalidraw.com session state or auth |
| Product shape | Excalidraw-first Bud, not "Bud with a side mode" | The canvas is the primary surface; voice copilot is the primary interaction |
| Scope | General sketchnoting | Avoid premature specialization; LLM interprets intent broadly |
| Session interaction | User-configurable hotkey toggles a continuous voice session | Default `CommandOrControl+Shift+Space` (Ctrl+Shift+Space on Windows/Linux, ⌘+Shift+Space on macOS), stored in settings and user-remappable. Press once: open/focus canvas + start copilot session. Press again: end session, leave sketch intact |
| Persistence | Hybrid: autosave local sessions + optional export/save-as | Low-friction local recovery; later export to `.excalidraw`, PNG, SVG |
| Safety | Hybrid: small safe edits apply immediately; destructive/large/ambiguous edits require spoken confirmation | Keeps conversational flow while preventing accidental data loss |
| Review/brainstorm | Visual proposals, not immediate edits | Pending changes render as temporary Excalidraw elements marked `ghost`/`proposalId` in `customData` with translucent/dashed styling; overlay annotations point/highlight but store no proposal state |
| UI | Minimal passive floating HUD; voice-first confirmation | No primary buttons; "apply" / "cancel" / "change it" are spoken |
| Voice response | Bud talks back naturally | Voice-first output, not text-first |
| V1 footprint | Single-user / local only | No collaboration complexity in V1 |
| Architecture | Option 2: deep main-process `ExcalidrawController` with high-level command primitives | Policy lives in the main process; renderer stays thin and policy-free |
| Undo | Native Excalidraw undo (one logical update per voice command) + controller snapshot ring fallback | Controller focuses the canvas window and sends the platform-appropriate `CommandOrControl+Z` undo and `CommandOrControl+Y` / `CommandOrControl+Shift+Z` redo accelerators, verifies a `sceneVersion`/`onChange` delta, and falls back to snapshot restore if native undo yields no change. Snapshot ring keeps the last 50 Bud-applied ops or 30 minutes, whichever comes first (V1 defaults). Excalidraw exposes no public undo/redo API except `history.clear` |

## 4. Architecture

### 4.1 High-Level Flow

```
User voice
   │
   ▼
Bud LLM layer (gpt-realtime-2 WebRTC  /  OrchestratorAgent + Cartesia fallback)
   │  interprets intent, chooses a tool
   ▼
Excalidraw tools (createExcalidrawTools)
   │  dual-registered: Realtime ToolBridge  +  Vercel AI SDK (chat)
   ▼
ExcalidrawController (main process)
   │  safety gate · proposal state · batching · snapshot ring · autosave · import/export
   ▼
IPC (request/response + scene-change publish)
   ▼
Embedded Excalidraw renderer (BrowserWindow, React)
   │  hosts <Excalidraw> · captures ExcalidrawAPI · minimal HUD · ghost layer · canvas annotations
   ▼
voice + HUD feedback
```

### 4.2 Process Responsibilities

**Main process owns all policy.** The renderer is deliberately thin and contains no business or safety logic.

- `ExcalidrawWindowManager` creates/focuses the dedicated interactive `BrowserWindow` and owns its lifecycle.
- `ExcalidrawController` owns scene operations, safety classification, proposal state, batching, the undo/snapshot ring, autosave/recent sessions, and import/export orchestration.
- `createExcalidrawTools` dual-registers the same controller-backed tools for both the Realtime path (`RealtimeToolBridge` `ToolExecutor`) and the chat/Orchestrator path (Vercel AI SDK `tool()`).

**Renderer is thin.** The canvas `BrowserWindow` hosts the React `<Excalidraw>` component, captures the `ExcalidrawAPI` handle, exposes request/response IPC, publishes `onChange` scene updates back to the main process, and renders the minimal HUD, the ghost element layer, and canvas-local overlay annotations. It applies exactly what the controller tells it to apply and reports back what it sees.

### 4.3 Listening Model — Reconciliation with Always-On Bud

Bud's Realtime Voice Pipeline is always-on by default (continuous `getUserMedia` → WebRTC → `gpt-realtime-2`). The copilot hotkey therefore toggles a **canvas-scoped session**, not the raw microphone:

- **Press once:** (re)focus the embedded Excalidraw window and start a copilot session. Starting the session means the conversation context becomes canvas-bound (canvas-scoped history + the Excalidraw tool set is the active tool surface). If Bud is globally muted, pressing the hotkey unmutes into the copilot session.
- **Press again:** end the copilot session. Bud stops holding the canvas-bound conversation context (and restores the prior mute state if the hotkey had unmuted). The Excalidraw window and the sketch are left intact.

This honors the product decision ("starts listening/conversation" … "ends Bud listening/session but leaves the sketch/canvas intact") without contradicting Bud's always-on microphone model: what toggles is the session/context, and muting follows the user's global state. The semantic tension is tracked in Risks.

### 4.4 New Module Locations

All files below are new. None exist in the current tree.

```
app/src/main/excalidraw/ExcalidrawWindowManager.ts
app/src/main/excalidraw/ExcalidrawController.ts
app/src/main/excalidraw/excalidrawTypes.ts
app/src/main/excalidraw/createExcalidrawTools.ts
app/src/main/excalidraw/excalidrawPrompts.ts
app/src/main/canvasPreload.ts
app/src/renderer/canvas/               (React + Excalidraw renderer + HUD/ghost/annotation layers)
```

## 5. Components

### 5.1 `ExcalidrawWindowManager.ts`

Creates and focuses the dedicated interactive Excalidraw `BrowserWindow`. Mirrors the lifecycle pattern of `OverlayManager` but for a *focusable, interactive* window (not click-through, not transparent).

**Responsibilities:**
- Create the canvas window on first open (or on app ready). Load the React renderer entry.
- `openOrFocus()`: show + focus the window without destroying the existing sketch. If the window was hidden, restore it.
- Keep the window alive across session toggles so the sketch survives "end session".
- Provide `getWindow()` and `sendToCanvas(channel, data)` helpers for the controller, mirroring `OverlayManager.sendToOverlay`.
- Destroy on `before-quit`.

The window uses a dedicated preload (`canvasPreload.ts`) with its own `contextBridge` surface; it does **not** share the overlay/panel `preload.ts` API.

### 5.2 `ExcalidrawController.ts`

Single source of truth for canvas policy and scene operations in the main process. Mirrors the `AnnotationController` precedent (main-process controller, IPC to a renderer, clear lifecycle methods) but is substantially deeper because it owns safety, proposals, snapshots, and persistence.

**Responsibilities:**
- `readScene(): Promise<SceneSummary>` — request the current scene from the renderer and return a compact summary (see §6.2). Ghost-marked elements are omitted.
- `applyOperation(op): Promise<ApplyResult>` — run the deterministic safety gate; if the op is immediate-safe-small (§7), commit it immediately via IPC and return `{ status: 'applied', ... }`. If the op is destructive/large/ambiguous, do not commit — return `{ status: 'proposeRequired' | 'ambiguous' | 'unsupported' }` so the model re-routes through `proposeOperation`.
- `proposeOperation(proposal: ExcalidrawProposal): Promise<ExcalidrawProposal>` — validate the payload, assign a `proposalId`, run the safety gate to set `safetyLevel`, render the proposal as ghost elements (in-scene Excalidraw elements marked in `customData` with `{ proposalId, ghost: true }` and translucent/dashed styling) plus any `overlayAnnotations`, and return the proposal with `proposalId`, `diffSummary`, `safetyLevel`, and TTL populated. Does not commit. See §6.4.
- `confirmProposal(id, optionId?): Promise<ApplyResult>` — commit a pending proposal as a real scene update. For `mode: 'diagram_patch'`, commits the proposal's `operations`. For `mode: 'review_options'`, `optionId` is required; the selected option's `operations` are converted into a `diagram_patch` and committed. Without `optionId` on a `review_options` proposal, return `{ status: 'selectOption' }`. V1 commits only `diagram_patch` payloads; `review_options` is always converted to one selected `diagram_patch` before apply.
- `cancelProposal(id): Promise<void>` — drop the pending ghost elements and proposal state.
- `undo(): Promise<UndoResult>` — trigger native Excalidraw undo for the last Bud-applied logical update: focus the canvas `BrowserWindow`, send the platform-appropriate `CommandOrControl+Z` undo accelerator, verify a `sceneVersion`/`onChange` delta, and fall back to restoring the most recent snapshot-ring entry if native undo yields no scene change. Redo uses `CommandOrControl+Y` or `CommandOrControl+Shift+Z`, whichever the embedded Excalidraw build supports.
- `exportScene(opts)` / `saveSessionAs(opts)` — orchestrate export/save-as (`.excalidraw`, PNG, SVG) via the renderer.
- Enforce the deterministic safety gate (§7) over model judgement; the model never self-certifies an action as safe.
- Own proposal state: pending proposals keyed by `proposalId`, each with a `diffSummary`, `safetyLevel`, and TTL; auto-expire stale proposals; only one logical proposal is active at a time (a new proposal supersedes the old one).
- Batch a single voice command into one logical scene update so native undo aligns with voice commands.
- Maintain the snapshot ring (rollback safety net): keep the last 50 Bud-applied operations or the last 30 minutes, whichever comes first (V1 defaults, configurable later). Ghost additions are not counted as Bud-applied operations. Drive autosave/recent sessions.
- Subscribe to renderer `onChange` scene publishes to keep its in-memory scene fresh for concurrent-user-drawing merge (§10).

### 5.3 `excalidrawTypes.ts`

Shared TypeScript types for operations, proposals, scene summaries, and IPC payloads. See §6 for the shapes.

### 5.4 `createExcalidrawTools.ts`

Factory that returns both a Vercel AI SDK `tool()` map and a set of `RealtimeToolBridge` `ToolExecutor` objects, all wrapping the same `ExcalidrawController` methods. This mirrors `createDrawAnnotationTools` (`{ vercelTool, realtimeExecutor }`) exactly, generalized to the full tool surface in §6.1.

Both paths call the same controller methods — there is one implementation. The paths differ only in how results are consumed: Realtime tool results may be truncated and are spoken back by the model; chat results render in the Chat Agent Panel. The compact scene summary (§6.2) exists primarily to stay under Realtime truncation limits.

### 5.5 `excalidrawPrompts.ts`

System-prompt instructions appended to both `BUD_SYSTEM_PROMPT` (Realtime) and `ORCHESTRATOR_SYSTEM_PROMPT` (chat), mirroring `annotationPrompt.ts`. Tells the model when to read the scene, when to apply vs. propose, how to reference elements, and how to phrase confirmation requests. Documents the voice confirmation vocabulary ("apply", "cancel", "change it", "undo that").

### 5.6 `canvasPreload.ts`

Dedicated preload for the canvas window. Exposes a `window.budCanvasAPI` `contextBridge` surface with request/response IPC (`requestScene`, `applyScene`, `renderGhosts`, `clearGhosts`, `renderCanvasAnnotation`, `exportScene`) and scene-change publish (`onSceneChange`). Kept separate from `preload.ts` so the overlay/panel API surface is not polluted with canvas-only channels.

### 5.7 `app/src/renderer/canvas/*` (React renderer)

A new React-based renderer that mounts `@excalidraw/excalidraw`'s `<Excalidraw>` component. This is a **new build surface**: existing Bud renderers (`overlay`, `panel`, `recorder`) are plain HTML/JS loaded via `BrowserWindow.loadFile`, and the build is `tsc`-only with no bundler. Hosting React + Excalidraw requires a bundler (Vite or equivalent) and offline-packaged Excalidraw fonts/assets. See §9 (Build Infrastructure) and Risks.

**Renderer responsibilities:**
- Mount `<Excalidraw initialData=...>` and capture the `ExcalidrawAPI` handle on mount.
- Expose request/response IPC: answer `requestScene` with a compact summary, apply `applyScene` updates via the Excalidraw API, render/clear ghost elements, render/clear canvas-local annotations, and run exports.
- Publish `onChange` scene updates to the main process so the controller's in-memory scene stays fresh while the user draws manually.
- Render the minimal floating HUD (passive status: listening / speaking / proposal pending / saved).
- Render **ghost elements**: proposed elements are added to the Excalidraw scene as temporary elements marked in `customData` with `{ proposalId, ghost: true }` and translucent/dashed styling (for `review_options`, each option's elements also carry their `optionId`). Omit ghost-marked elements from `requestScene` summaries until confirmed. Canvas-local **overlay annotations** (point/highlight/label) render in a separate overlay and do not store proposal state.
- Contain **no** safety/policy logic.

### 5.8 Settings Extension

Extend `AppSettings` / `SettingsManager` (`app/src/main/settings.ts`) with an `excalidraw` block, following the existing nested-merge pattern used for `modal` / `local`:

```ts
excalidraw: {
  toggleHotkey: string;          // default 'CommandOrControl+Shift+Space' (Ctrl+Shift+Space on Windows/Linux, ⌘+Shift+Space on macOS) — user-configurable; Bud warns at registration if the accelerator is already bound
  saveDirectory: string;         // workspace dir for autosaved sessions
  autosaveIntervalMs: number;    // default 5000
  theme: 'light' | 'dark' | 'auto';
  safetyThresholds: {
    maxElementsPerImmediateApply: number;   // above this → require confirmation
    maxElementsPerDelete: number;           // above this → require confirmation
  };
  snapshotRing: {
    maxOperations: number;       // default 50 — cap on retained Bud-applied operations
    maxAgeMs: number;            // default 1_800_000 (30 min) — cap on retained history age
  };
}
```

### 5.9 `main.ts` Wiring

Follow the existing seams:
- Construct `ExcalidrawWindowManager` and `ExcalidrawController` during `app.whenReady()` (alongside `annotationController`).
- Construct `createExcalidrawTools(controller)` and register: (a) the `ToolExecutor[]` with `realtimeVoiceManager.registerTools(...)`, and (b) the Vercel `tool()` map inside the `tools` object in `executeChatCompletion` (and any chat/Orchestrator construction site), exactly as `drawAnnotation` is wired today.
- Register the toggle hotkey via `GlobalHotkey` (extend its options with an `onCanvasToggle` callback, mirroring `onMuteToggle`). Default `CommandOrControl+Shift+Space` (resolves to Ctrl+Shift+Space on Windows/Linux, ⌘+Shift+Space on macOS); user-configurable via `excalidraw.toggleHotkey`. If the accelerator is already bound by the OS or another Bud hotkey, log a warning and let the user remap it in settings.
- Append `EXCALIDRAW_PROMPT_INSTRUCTIONS` to `BUD_SYSTEM_PROMPT` and `ORCHESTRATOR_SYSTEM_PROMPT` where assembled, mirroring how annotation instructions are added.
- Clear pending proposals/ghosts on Realtime `speech.started` and `interruption` events, mirroring `annotationController.clearAnnotations()` today.

## 6. Tool / Operation Surface

### 6.1 Tools

Prefer a small set of high-level tools over many low-level calls:

| Tool | Purpose |
|------|---------|
| `excalidraw_readScene` | Return a compact scene summary (IDs, text, type, bounds, selection, scene version). Avoid raw full JSON by default. |
| `excalidraw_applyOperation` | Handle small, safe, clear, reversible create/edit operations immediately. |
| `excalidraw_proposeOperation` | Create ghost elements + overlay annotations without committing. Used for review/brainstorming, ambiguous improvements, presenting alternatives (`review_options`), and any destructive/large op that must not apply directly (`diagram_patch` with `safetyLevel: 'confirmRequired'`). See §6.4. |
| `excalidraw_confirmProposal` | Commit a pending proposal by ID. |
| `excalidraw_cancelProposal` | Drop a pending proposal by ID. |
| `excalidraw_undo` | Voice-first "undo that". |
| `excalidraw_export` / `excalidraw_save` | Export/save-as to `.excalidraw`, PNG, SVG. |

A future `excalidraw_getElement` (full properties for one element by ID) is a Phase 2+ expansion to fight context bloat; it is **not** in V1.

### 6.2 `readScene` Compact Summary

Returned to the model instead of raw scene JSON so Realtime tool results stay under truncation limits:

```ts
interface SceneSummary {
  sceneVersion: number;          // Excalidraw scene version, for staleness checks
  elementCount: number;
  canvasSize: { width: number; height: number };
  selection: string[];           // selected element IDs
  elements: Array<{
    id: string;
    type: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'text' | 'freedraw' | 'image';
    text?: string;               // only for text/label-bearing elements
    x: number; y: number;
    width: number; height: number;
    strokeColor?: string;
    backgroundColor?: string;
  }>;
}
```

Full per-element JSON (points, bindings, fonts, etc.) is omitted by default and reachable later via `excalidraw_getElement`.

### 6.3 `applyOperation` Operation Union

```ts
type ExcalidrawOperation =
  | { kind: 'create'; elementType: ExcalidrawElementType; x: number; y: number; width: number; height: number;
      text?: string; strokeColor?: string; backgroundColor?: string; strokeWidth?: number; }
  | { kind: 'update'; id: string; changes: Partial<ExcalidrawElement>; }
  | { kind: 'delete'; ids: string[]; }
  | { kind: 'align'; ids: string[]; alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'; }
  | { kind: 'group' | 'ungroup'; ids: string[]; }
  | { kind: 'clearCanvas' }
  | { kind: 'replaceScene'; elements: ExcalidrawElement[] }
  | { kind: 'importScene'; source: { type: 'file'; path: string } | { type: 'session'; sessionId: string } }
  | { kind: 'reorganizeLayout'; ids: string[]; layout: 'grid' | 'tree' | 'flow' | 'auto' };
```

The `clearCanvas`, `replaceScene`, `importScene`, and `reorganizeLayout` variants are destructive/large by definition and are always classified `confirmRequired` by the safety gate (§7); they never apply via `applyOperation` and must flow through `proposeOperation` → `confirmProposal`. `importScene` is represented in the V1 operation union and safety table for completeness, but its implementation is Phase 2: in V1 the controller returns `{ status: 'unsupported', reason: 'import is Phase 2; use export/save-as flow' }` rather than executing it.

### 6.4 `proposeOperation` + Ghost Elements

`proposeOperation` takes a typed `ExcalidrawProposal` payload and returns the same shape with controller-assigned metadata populated. V1 supports exactly two proposal modes:

- `mode: 'diagram_patch'` — a single set of `operations` to preview. This is the only mode `confirmProposal` can commit in V1.
- `mode: 'review_options'` — a list of alternative `options`, each a named `diagram_patch`. The user selects one by voice (for example, "option two" or "the flow layout one"); the controller converts the selected option into a `diagram_patch` and commits it. `review_options` is never committed directly.

```ts
type ExcalidrawProposal = {
  proposalId?: string;                        // assigned by the controller; omitted on input, present on returned proposals
  mode: 'diagram_patch' | 'review_options';
  summary: string;                            // short human-readable description
  operations?: ExcalidrawOperation[];         // required when mode === 'diagram_patch'
  options?: ProposalOption[];                 // required when mode === 'review_options'
  overlayAnnotations?: AnnotationRequest[];   // display-only; do not store proposal state
  safetyLevel?: 'proposal' | 'confirmRequired';
  diffSummary?: string;                       // computed short diff; populated by the controller
  ttlMs?: number;
  expiresAt?: number;                         // epoch ms
};

type ProposalOption = {
  id: string;
  title: string;
  rationale: string;
  operations: ExcalidrawOperation[];
};

type AnnotationRequest = {
  kind: 'point' | 'highlight' | 'label';
  targetElementId?: string;                   // element to point at / highlight
  text?: string;                              // label text
  x?: number; y?: number;                     // canvas coords for free-form point/label
};

type ApplyResult =
  | { status: 'applied'; sceneVersion: number; affectedIds: string[] }
  | { status: 'proposeRequired'; reason: string }
  | { status: 'ambiguous'; matches: string[] }
  | { status: 'unsupported'; reason: string }
  | { status: 'selectOption'; proposalId: string; optionIds: string[] };

type UndoResult =
  | { status: 'undone'; via: 'native' | 'snapshot'; sceneVersion: number }
  | { status: 'nothingToUndo' };
```

**Ghost elements.** The controller assigns a `proposalId`, runs the safety gate to set `safetyLevel`, and tells the renderer to render the proposal's elements as **ghost elements**: temporary Excalidraw scene elements marked in `customData` with `{ proposalId, ghost: true }` and translucent/dashed styling. For `review_options`, each option's ghost elements also carry their `optionId` so the renderer can style and label them distinctly. `overlayAnnotations` (point/highlight/label) render in a separate canvas-local annotation overlay and **do not store proposal state** — they only point at or highlight existing or ghost elements. Ghost elements are excluded from `readScene` summaries until confirmed, so the model does not mistake them for committed elements.

**Confirm/cancel.** On `confirmProposal(id, optionId?)`, the controller resolves the proposal to a single `diagram_patch`, commits that patch as a real scene update, and clears the ghosts. For `mode: 'review_options'`, `optionId` is required; without it the controller returns `{ status: 'selectOption' }` and does not mutate the scene. On `cancelProposal(id)`, the ghost elements are removed from the scene and the proposal state is dropped. A new proposal supersedes any active one.

Ghost additions are not counted as Bud-applied operations for snapshot-ring or native-undo accounting; only confirmed commits are.

### 6.5 Representative Tool Schema

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "enum": ["create", "update", "delete", "align", "group", "ungroup", "clearCanvas", "replaceScene", "importScene", "reorganizeLayout"] },
        "elementType": { "type": "string", "enum": ["rectangle", "ellipse", "diamond", "arrow", "line", "text", "freedraw"] },
        "id": { "type": "string", "description": "Target element ID for update/delete/align/group." },
        "ids": { "type": "array", "items": { "type": "string" }, "description": "Target element IDs for delete/align/group." },
        "x": { "type": "number" }, "y": { "type": "number" },
        "width": { "type": "number" }, "height": { "type": "number" },
        "text": { "type": "string" },
        "strokeColor": { "type": "string" }, "backgroundColor": { "type": "string" }
      },
      "required": ["kind"]
    }
  },
  "required": ["operation"]
}
```

(`excalidraw_proposeOperation` takes the `ExcalidrawProposal` shape from §6.4, not the bare operation above; `excalidraw_applyOperation` takes the `operation` object shown here.)

### 6.6 Agent Instructions (excerpt, full text in `excalidrawPrompts.ts`)

- Call `excalidraw_readScene` before editing when you don't have a fresh scene; scenes go stale while the user draws.
- Prefer `excalidraw_applyOperation` for small, clear, reversible changes.
- Use `excalidraw_proposeOperation` for review/brainstorming ("what's missing?"), ambiguous improvements, when multiple options exist (use `mode: 'review_options'`), and for any destructive/large change (`clearCanvas` / `replaceScene` / `reorganizeLayout` / `importScene` / bulk delete) which must never go through `applyOperation`.
- Resolve ambiguous element references by proposing or asking — never guess-and-apply.
- After a proposal, wait for the user to say "apply", "cancel", or "change it" before committing.
- "undo that" → call `excalidraw_undo`.

## 7. Safety / Confirmation Policy

The controller enforces a **deterministic safety gate** over model judgement. The model never decides whether its own action is safe.

**Apply immediately (no confirmation):**
- Add a shape, text, arrow, or freedraw stroke.
- Rename the selected element.
- Recolor / restyle a small set.
- Align / nudge a small set.

**Visual proposal (no commit):**
- Review/brainstorming ("what's missing?", "give me ideas").
- Ambiguous improvements where multiple outcomes are reasonable.
- Presenting alternatives.

**Require spoken confirmation (always route through `proposeOperation` with `safetyLevel: 'confirmRequired'`; the spoken "apply" is the confirmation):**
- Delete many elements (above `safetyThresholds.maxElementsPerDelete`).
- `clearCanvas` — clear the canvas.
- `replaceScene` — replace or overwrite the whole diagram.
- `reorganizeLayout` — reorganize a whole diagram's layout.
- `importScene` — overwrite/import a session or file that replaces current content. The operation is represented in V1 for completeness, but its implementation is Phase 2; in V1 the controller returns `{ status: 'unsupported' }` until the import flow lands.

**Mechanism.** `applyOperation` commits only immediate-safe-small ops; for any risky/large/ambiguous op it returns `{ status: 'proposeRequired' }` (or `{ status: 'ambiguous' }`) without mutating the scene, forcing the model to re-route through `proposeOperation`. Both the "Visual proposal" and "Require spoken confirmation" buckets flow through `proposeOperation` → `confirmProposal`; they differ only in `safetyLevel` (`'proposal'` vs. `'confirmRequired'`) and in how the HUD/speech presents them. `confirmRequired` proposals are spoken with their impact named explicitly (for example, "this will clear the canvas — say apply to confirm").

**Ambiguous references** (e.g., "delete the box" when several boxes exist, or a natural-language reference that matches no element uniquely) must trigger a clarification question or a proposal — never a blind apply. The controller rejects ambiguous-target operations with a structured "ambiguous" result so the model can re-ask.

### Confirmation Lifecycle

- A pending proposal has: a unique `proposalId`, a short diff/summary, a `mode`, and a TTL (auto-expire if the user moves on).
- `diagram_patch` proposals resolve by a later voice turn: "apply" → `confirmProposal(id)`; "cancel" → `cancelProposal(id)`; "change it" / "actually, make it …" → the model revises and re-proposes (the old proposal is cancelled).
- `review_options` proposals require option selection before commit: for example, "option two" / "the flow layout one" resolves to `confirmProposal(id, optionId)`; "cancel" still calls `cancelProposal(id)`; a revision request cancels the old proposal and creates a new one.
- Only one logical proposal is active at a time; a new proposal supersedes the old one.

## 8. Persistence

Hybrid persistence:

- **Autosave:** the controller periodically snapshots the current scene into the Bud workspace `saveDirectory` (default interval 5s, configurable). Sessions are lightweight: a session id, name (derived from first text or timestamp), last-modified, and the `.excalidraw` scene file.
- **Recent sessions:** a small recent-sessions index in settings/userData, surfaced as a lightweight recent list (Phase 1 keeps it minimal; a recent-sessions UI is Phase 2).
- **Optional export/save-as:** `.excalidraw` (native scene JSON), PNG, and SVG. `.excalidraw` is the Phase 2 minimum; PNG and SVG are Phase 2 stretch targets that may slip to a later point release.
- Ending a copilot session does **not** discard the sketch; autosave continues to preserve it across app restarts.

## 9. UI / HUD

- Minimal floating HUD rendered inside the canvas window (not the global overlay). It is **passive/status-oriented**: shows listening / speaking / proposal-pending / saved state.
- No primary Approve/Decline buttons in the normal flow. Confirmation, cancellation, and revision happen by voice ("apply", "cancel", "change it").
- Pending proposals are communicated visually via the ghost layer + a short status line ("proposal pending: add 2 boxes"), not via modal dialogs.
- Bud talks back naturally; the HUD complements speech, it does not replace it.

## 10. Build Infrastructure

The React + Excalidraw renderer is a new build surface:

- Add a bundler (Vite recommended) to build the `renderer/canvas` entry to a bundle the `BrowserWindow` can load. Existing renderers remain plain HTML/JS.
- Package `@excalidraw/excalidraw` and its fonts/assets for offline use (the canvas must work without a network round-trip to a CDN). This is a Phase 2 packaging task; Phase 1 may use the npm asset directly during development.
- The main process remains `tsc`-built; only the canvas renderer needs the new bundler.
- Extend `electron-builder` config to include the built canvas bundle and offline fonts/assets in the packaged app.

## 11. Phases

### Phase 1 — End-to-end copilot loop

- Embedded Excalidraw canvas opens/focuses by hotkey.
- Continuous voice session toggles by hotkey.
- Create general sketchnotes from voice.
- Edit selected or referenced elements.
- Review the canvas and show a visual proposal (ghost + annotation).
- Apply / cancel / revise a proposal by voice.
- Voice "undo that" via native Excalidraw undo + snapshot-ring fallback (V1 defaults: 50 ops / 30 min).
- Basic autosave + recent-session persistence.

Phase 1 deliberately includes all three slices — **create, edit, and review/propose** — because Bud's LLM layer interprets intent; splitting them would force artificial tool boundaries and a worse first experience.

### Phase 2 — Product hardening

- `importScene` implementation (operation is represented in V1 but returns `{ status: 'unsupported' }` until this lands).
- Snapshot ring tuning beyond the V1 defaults (50 ops / 30 min) for large-scene memory cost.
- Safety thresholds / confirmation policy finalized and configurable.
- Recent-sessions UI.
- Export/save-as: `.excalidraw`, PNG, SVG.
- Better ambiguous-reference clarification.
- Packaged renderer build + offline fonts/assets.

### Phase 3 — Expansion

- Richer layout/diagram transforms.
- Templates / style presets.
- Image/file elements.
- Better brainstorm variants.
- Optional dedicated Canvas Agent if a single shared controller becomes a bottleneck.
- Collaboration / sharing remains future, not V1.

## 12. Validation Criteria

- Hotkey starts and ends the copilot session and opens/focuses the canvas without losing the sketch.
- Voice create works for general diagrams/sketchnotes.
- Voice edit works for the selection and for natural-language references when unambiguous.
- Review produces a visual proposal without committing.
- Alternatives (`review_options`) render as distinct ghost sets; the user selects one by voice and only that option commits.
- Voice "apply" / "cancel" / "change it" controls proposals; no primary buttons are required.
- The safety gate confirms destructive, large, or ambiguous actions before they commit.
- "undo that" works after a Bud-applied action.
- Local recent sessions survive an app restart.
- Export/save-as at least `.excalidraw` lands in Phase 2.

## 13. Risks

- **Excalidraw API / history limitation.** The public Excalidraw API exposes no undo/redo except `history.clear`. V1 triggers undo by focusing the canvas window and sending the platform-appropriate `CommandOrControl+Z` accelerator, then verifying a `sceneVersion`/`onChange` delta; if native undo yields no change, the controller restores the most recent snapshot-ring entry (last 50 Bud-applied ops or 30 min, V1 defaults). The one-logical-update-per-voice-command strategy keeps native history entries aligned with voice commands. Ghost elements (in-scene, `customData.ghost=true`) may create history entries when added; the controller does not count ghost additions as Bud-applied operations and re-renders the active proposal's ghosts from in-memory proposal state if a native undo inadvertently removes them. If a stable public undo/redo API appears, prefer it.
- **Main/renderer process boundary.** Request/response IPC over the canvas window must be reliable under focus changes, window hide/show, and rapid voice turns. Need a request/response correlation layer (ids + timeouts) and defined behavior when the window is gone.
- **Renderer build infrastructure.** React + Excalidraw + a bundler + offline fonts is new ground for this repo (today: `tsc`-only, plain HTML/JS renderers). This is the largest non-policy risk for Phase 1/2.
- **Concurrency with user drawing.** The user can draw manually while Bud edits. The controller must keep a fresh scene (via `onChange` publishes) and merge/refresh before each apply to avoid clobbering in-progress user strokes.
- **Large scene context bloat / truncation.** Realtime tool results can be truncated. Compact `readScene` summaries mitigate this; a future `excalidraw_getElement` detail tool is the Phase 2+ escape valve.
- **Ambiguous element references and stable IDs.** Natural-language references ("the box on the left") must map to element IDs deterministically. IDs must be stable across reads within a session; the controller should refuse ambiguous matches rather than guess.
- **Dual voice paths with different semantics.** Realtime and chat/Orchestrator share one controller but consume results differently (spoken-and-truncatable vs. panel-rendered). The compact summary shape must serve both; the controller must not assume one consumer.
- **Scope separation from the existing annotation overlay.** The screen `AnnotationController`/`OverlayManager` points at the user's screen in screen coordinates. Canvas-local annotations live in the canvas renderer in canvas coordinates. These two systems must not be conflated.
- **Always-on vs. session-toggle semantics.** The copilot hotkey toggles a canvas-scoped session, not the raw mic (see §4.3). The semantic mapping must be obvious to the user; otherwise "end session" will feel inconsistent with Bud's always-on nature.

## 14. Future Decisions (post-V1)

The V1 requirements listed below are decided (see referenced sections); only out-of-scope, post-V1 tuning remains. There are no unresolved V1 questions.

- **Default hotkey — decided for V1.** Default `CommandOrControl+Shift+Space` (Ctrl+Shift+Space on Windows/Linux, ⌘+Shift+Space on macOS), stored in `excalidraw.toggleHotkey`, user-configurable, and warned on collision at registration (§5.8, §5.9). Post-V1: revisit per-platform defaults if collision reports cluster on a given OS.
- **Ghost implementation — decided for V1.** Ghosts are temporary in-scene Excalidraw elements marked in `customData` with `{ proposalId, ghost: true }` and translucent/dashed styling; overlay annotations point/highlight but store no proposal state (§5.2, §5.7, §6.4). Post-V1: none.
- **Native undo trigger — decided for V1.** The controller focuses the canvas `BrowserWindow`, sends the platform-appropriate `CommandOrControl+Z` undo accelerator, verifies a `sceneVersion`/`onChange` delta, and falls back to snapshot restore if native undo yields no change (§5.2, §13). Post-V1: if Excalidraw ships a stable public undo/redo API, prefer it over keyboard synthesis.
- **Snapshot ring depth — decided for V1.** Keep the last 50 Bud-applied operations or the last 30 minutes, whichever comes first (V1 defaults, configurable later) (§5.2, §5.8). Post-V1: Phase 2 tunes depth for large-scene memory cost.
- **`excalidraw_getElement` detail tool.** Deferred to Phase 2+ as the context-bloat escape valve (§6.1).
- **Recent-sessions UI.** Phase 2; V1 keeps only a minimal recent index (§8).
- **Collaboration / sharing.** Future, not V1 (§2).

## 15. Testing Plan

- **Unit — safety gate:** feed create/update/delete/clearCanvas/replaceScene/reorganizeLayout/importScene ops and assert: immediate-apply for small create/update; `proposeRequired` (not commit) for clearCanvas/replaceScene/reorganizeLayout and bulk delete above threshold; `unsupported` for importScene in V1; classification matches configured thresholds.
- **Unit — proposal lifecycle (`diagram_patch`):** propose → confirm commits; propose → cancel drops ghosts; propose → supersede cancels the old one; TTL expiry drops stale proposals; `confirmRequired` proposals commit only on explicit `confirmProposal`.
- **Unit — proposal lifecycle (`review_options`):** proposing `mode: 'review_options'` renders one ghost set per option; `confirmProposal(id)` without `optionId` returns `{ status: 'selectOption' }` and does not commit; `confirmProposal(id, optionId)` commits only the selected option's operations as a `diagram_patch`; unselected options are cleared.
- **Unit — ghost marking:** ghost elements carry `customData.ghost=true` and `customData.proposalId`; `readScene` omits ghost-marked elements; `overlayAnnotations` do not carry proposal state.
- **Unit — ambiguous references:** operations with non-unique targets return a structured "ambiguous" result and do not mutate the scene.
- **Unit — readScene compactness:** assert the summary omits full per-element JSON and includes stable IDs, selection, and scene version.
- **Integration — dual registration:** register the tools with a mock `RealtimeToolBridge` and a mock Vercel `tool()` harness; invoke each tool and confirm both paths route to the same controller method.
- **Renderer — ghosts:** load the canvas renderer in a test harness, drive propose/confirm/cancel IPC, and verify ghost elements are in-scene with `customData.ghost=true`, are omitted from `requestScene`, and are removed on cancel / converted to real elements on confirm.
- **Unit — undo:** after a Bud-applied commit, `undo()` focuses the canvas window, sends the undo accelerator, detects a `sceneVersion` delta, and returns `{ via: 'native' }`; when native undo yields no delta, `undo()` restores the latest snapshot-ring entry and returns `{ via: 'snapshot' }`; with no Bud-applied history, it returns `{ status: 'nothingToUndo' }`.
- **IPC — request/response reliability:** simulate window hide/show and rapid turns; assert requests time out cleanly and do not leak when the window is gone.
- **Manual QA:**
  - Hotkey opens/focuses canvas, starts session, ends session, sketch survives.
  - Voice create a general sketchnote; voice edit the selection; voice edit by natural reference when unambiguous.
  - Review → ghost proposal appears; "apply" commits; "cancel" clears; "change it" re-proposes.
  - Destructive action ("delete everything") requires spoken confirmation.
  - "undo that" reverts the last Bud-applied action.
  - Restart app; recent session is recoverable.
