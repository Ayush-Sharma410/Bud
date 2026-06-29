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
| Session interaction | User-configurable hotkey toggles a continuous voice session | Press once: open/focus canvas + start copilot session. Press again: end session, leave sketch intact |
| Persistence | Hybrid: autosave local sessions + optional export/save-as | Low-friction local recovery; later export to `.excalidraw`, PNG, SVG |
| Safety | Hybrid: small safe edits apply immediately; destructive/large/ambiguous edits require spoken confirmation | Keeps conversational flow while preventing accidental data loss |
| Review/brainstorm | Visual proposals, not immediate edits | Pending changes render as ghost elements; explanations render as canvas-local overlay annotations |
| UI | Minimal passive floating HUD; voice-first confirmation | No primary buttons; "apply" / "cancel" / "change it" are spoken |
| Voice response | Bud talks back naturally | Voice-first output, not text-first |
| V1 footprint | Single-user / local only | No collaboration complexity in V1 |
| Architecture | Option 2: deep main-process `ExcalidrawController` with high-level command primitives | Policy lives in the main process; renderer stays thin and policy-free |
| Undo | Native Excalidraw undo (one logical update per voice command) + controller snapshot ring fallback | Excalidraw exposes no public undo/redo API except `history.clear`; snapshot ring is the rollback safety net |

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
- `readScene(): Promise<SceneSummary>` — request the current scene from the renderer and return a compact summary (see §6.2).
- `applyOperation(op): Promise<ApplyResult>` — run the deterministic safety gate; if the op is safe-and-small, commit it immediately via IPC and return the result.
- `proposeOperation(op): Promise<Proposal>` — render the op as ghost elements + an explanation annotation without committing; return a proposal with an ID, diff/summary, and TTL.
- `confirmProposal(id): Promise<ApplyResult>` — commit the pending proposal as a real scene update.
- `cancelProposal(id): Promise<void>` — drop the pending ghost elements.
- `undo(): Promise<UndoResult>` — trigger native Excalidraw undo for the last Bud-applied logical update; fall back to the snapshot ring if native undo is unavailable.
- `exportScene(opts)` / `saveSessionAs(opts)` — orchestrate export/save-as (`.excalidraw`, PNG, SVG) via the renderer.
- Enforce the deterministic safety gate (§7) over model judgement.
- Own proposal state: pending proposals keyed by ID, each with a diff/summary and a TTL; auto-expire stale proposals.
- Batch a single voice command into one logical scene update so native undo aligns with voice commands.
- Maintain the snapshot ring (rollback safety net) and drive autosave/recent sessions.
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
- Render the **ghost layer**: proposed elements as translucent overlays (not committed to the Excalidraw scene) plus canvas-local annotation overlays for explanations/highlights.
- Contain **no** safety/policy logic.

### 5.8 Settings Extension

Extend `AppSettings` / `SettingsManager` (`app/src/main/settings.ts`) with an `excalidraw` block, following the existing nested-merge pattern used for `modal` / `local`:

```ts
excalidraw: {
  toggleHotkey: string;          // e.g. 'CommandOrControl+Alt+E' — user-configurable
  saveDirectory: string;         // workspace dir for autosaved sessions
  autosaveIntervalMs: number;    // default 5000
  theme: 'light' | 'dark' | 'auto';
  safetyThresholds: {
    maxElementsPerImmediateApply: number;   // above this → require confirmation
    maxElementsPerDelete: number;           // above this → require confirmation
  };
}
```

### 5.9 `main.ts` Wiring

Follow the existing seams:
- Construct `ExcalidrawWindowManager` and `ExcalidrawController` during `app.whenReady()` (alongside `annotationController`).
- Construct `createExcalidrawTools(controller)` and register: (a) the `ToolExecutor[]` with `realtimeVoiceManager.registerTools(...)`, and (b) the Vercel `tool()` map inside the `tools` object in `executeChatCompletion` (and any chat/Orchestrator construction site), exactly as `drawAnnotation` is wired today.
- Register the toggle hotkey via `GlobalHotkey` (extend its options with an `onCanvasToggle` callback, mirroring `onMuteToggle`). Default `CommandOrControl+Alt+E`; user-configurable via settings.
- Append `EXCALIDRAW_PROMPT_INSTRUCTIONS` to `BUD_SYSTEM_PROMPT` and `ORCHESTRATOR_SYSTEM_PROMPT` where assembled, mirroring how annotation instructions are added.
- Clear pending proposals/ghosts on Realtime `speech.started` and `interruption` events, mirroring `annotationController.clearAnnotations()` today.

## 6. Tool / Operation Surface

### 6.1 Tools

Prefer a small set of high-level tools over many low-level calls:

| Tool | Purpose |
|------|---------|
| `excalidraw_readScene` | Return a compact scene summary (IDs, text, type, bounds, selection, scene version). Avoid raw full JSON by default. |
| `excalidraw_applyOperation` | Handle small, safe, clear, reversible create/edit operations immediately. |
| `excalidraw_proposeOperation` | Create ghost elements + an explanation annotation without committing. Used for review/brainstorming and ambiguous improvements. |
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
  | { kind: 'group' | 'ungroup'; ids: string[]; };
```

### 6.4 `proposeOperation` + Ghost Elements

`proposeOperation` accepts the same operation union (or a richer "review" payload such as a list of options). The controller assigns a proposal ID, computes a short diff/summary, and tells the renderer to render the proposed elements as **ghost elements**: translucent overlays in the canvas renderer's ghost layer that are **not** committed to the Excalidraw scene. An accompanying canvas-local annotation overlay explains the proposal ("add a box here labeled X", "this arrow could connect A→B"). On `confirmProposal`, the controller issues an `applyOperation` that commits the ghosts as real Excalidraw elements; on `cancelProposal`, the ghost layer is cleared.

Ghost elements are never committed to the Excalidraw scene and never appear in `readScene` until confirmed (the separate-overlay-layer vs. in-scene-flag implementation choice is tracked in §14).

### 6.5 Representative Tool Schema

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "enum": ["create", "update", "delete", "align", "group", "ungroup"] },
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

### 6.6 Agent Instructions (excerpt, full text in `excalidrawPrompts.ts`)

- Call `excalidraw_readScene` before editing when you don't have a fresh scene; scenes go stale while the user draws.
- Prefer `excalidraw_applyOperation` for small, clear, reversible changes.
- Use `excalidraw_proposeOperation` for review/brainstorming ("what's missing?"), ambiguous improvements, or when multiple options exist.
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

**Require spoken confirmation:**
- Delete many elements (above `safetyThresholds.maxElementsPerDelete`).
- Clear the canvas.
- Replace or reorganize a whole diagram.
- Overwrite / import a session that replaces current content.

**Ambiguous references** (e.g., "delete the box" when several boxes exist, or a natural-language reference that matches no element uniquely) must trigger a clarification question or a proposal — never a blind apply. The controller rejects ambiguous-target operations with a structured "ambiguous" result so the model can re-ask.

### Confirmation Lifecycle

- A pending proposal/operation has: a unique `id`, a short diff/summary, and a TTL (auto-expire if the user moves on).
- It can be resolved by a later voice turn: "apply" → `confirmProposal(id)`; "cancel" → `cancelProposal(id)`; "change it" / "actually, make it …" → the model revises and re-proposes (the old proposal is cancelled).
- Only one logical proposal is active at a time; a new proposal supersedes a stale one.

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
- Basic autosave + recent-session persistence.

Phase 1 deliberately includes all three slices — **create, edit, and review/propose** — because Bud's LLM layer interprets intent; splitting them would force artificial tool boundaries and a worse first experience.

### Phase 2 — Product hardening

- Robust undo/snapshot fallback (snapshot ring tuned for real rollback scenarios).
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
- Voice "apply" / "cancel" / "change it" controls proposals; no primary buttons are required.
- The safety gate confirms destructive, large, or ambiguous actions before they commit.
- "undo that" works after a Bud-applied action.
- Local recent sessions survive an app restart.
- Export/save-as at least `.excalidraw` lands in Phase 2.

## 13. Risks

- **Excalidraw API / history limitation.** The public Excalidraw API exposes no undo/redo except `history.clear`. V1 uses the one-logical-update-per-voice-command strategy so native history entries align with voice commands, and the controller snapshot ring is the rollback fallback. If a stable public undo API appears, prefer it.
- **Main/renderer process boundary.** Request/response IPC over the canvas window must be reliable under focus changes, window hide/show, and rapid voice turns. Need a request/response correlation layer (ids + timeouts) and defined behavior when the window is gone.
- **Renderer build infrastructure.** React + Excalidraw + a bundler + offline fonts is new ground for this repo (today: `tsc`-only, plain HTML/JS renderers). This is the largest non-policy risk for Phase 1/2.
- **Concurrency with user drawing.** The user can draw manually while Bud edits. The controller must keep a fresh scene (via `onChange` publishes) and merge/refresh before each apply to avoid clobbering in-progress user strokes.
- **Large scene context bloat / truncation.** Realtime tool results can be truncated. Compact `readScene` summaries mitigate this; a future `excalidraw_getElement` detail tool is the Phase 2+ escape valve.
- **Ambiguous element references and stable IDs.** Natural-language references ("the box on the left") must map to element IDs deterministically. IDs must be stable across reads within a session; the controller should refuse ambiguous matches rather than guess.
- **Dual voice paths with different semantics.** Realtime and chat/Orchestrator share one controller but consume results differently (spoken-and-truncatable vs. panel-rendered). The compact summary shape must serve both; the controller must not assume one consumer.
- **Scope separation from the existing annotation overlay.** The screen `AnnotationController`/`OverlayManager` points at the user's screen in screen coordinates. Canvas-local annotations live in the canvas renderer in canvas coordinates. These two systems must not be conflated.
- **Always-on vs. session-toggle semantics.** The copilot hotkey toggles a canvas-scoped session, not the raw mic (see §4.3). The semantic mapping must be obvious to the user; otherwise "end session" will feel inconsistent with Bud's always-on nature.

## 14. Open Questions

- **Default hotkey.** `CommandOrControl+Alt+E` is proposed; confirm it does not collide with user habits and is reachable on the keyboards Bud targets. User-configurable either way.
- **Ghost layer implementation.** Render ghosts as a separate React overlay layer (recommended) vs. as Excalidraw elements with a custom `isGhost` property excluded from the committed scene. Separate layer keeps the Excalidraw scene clean; decide during Phase 1 prototyping.
- **Native undo trigger.** Whether to synthesize the Excalidraw undo keyboard shortcut in the renderer or wait for a public API call. Phase 1 will prototype the keyboard-shortcut path and keep the snapshot ring as the reliable fallback.
- **Snapshot ring depth.** How many snapshots to keep vs. memory cost for large scenes. Tune in Phase 2.

## 15. Testing Plan

- **Unit — safety gate:** feed create/update/delete/clear/replace ops and assert immediate-apply vs. proposal vs. confirmation-required classification against configured thresholds.
- **Unit — proposal lifecycle:** propose → confirm commits; propose → cancel drops ghosts; propose → supersede cancels the old one; TTL expiry drops stale proposals.
- **Unit — ambiguous references:** operations with non-unique targets return a structured "ambiguous" result and do not mutate the scene.
- **Unit — readScene compactness:** assert the summary omits full per-element JSON and includes stable IDs, selection, and scene version.
- **Integration — dual registration:** register the tools with a mock `RealtimeToolBridge` and a mock Vercel `tool()` harness; invoke each tool and confirm both paths route to the same controller method.
- **Renderer — ghost layer:** load the canvas renderer in a test harness, drive `renderGhosts`/`clearGhosts`/`applyScene` IPC, and verify ghosts do not appear in the committed scene until confirmed.
- **IPC — request/response reliability:** simulate window hide/show and rapid turns; assert requests time out cleanly and do not leak when the window is gone.
- **Manual QA:**
  - Hotkey opens/focuses canvas, starts session, ends session, sketch survives.
  - Voice create a general sketchnote; voice edit the selection; voice edit by natural reference when unambiguous.
  - Review → ghost proposal appears; "apply" commits; "cancel" clears; "change it" re-proposes.
  - Destructive action ("delete everything") requires spoken confirmation.
  - "undo that" reverts the last Bud-applied action.
  - Restart app; recent session is recoverable.
