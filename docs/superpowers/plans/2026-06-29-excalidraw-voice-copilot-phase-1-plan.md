# Excalidraw Voice Copilot — Phase 1 Implementation Plan

**Date:** 2026-06-29  
**Status:** Approved for implementation  
**Scope:** End-to-end voice-driven Excalidraw canvas in Bud — create, edit, review/propose, undo, autosave.

This plan is derived from `docs/superpowers/specs/2026-06-29-excalidraw-voice-copilot-design.md` and the current Bud architecture.

---

## 1. Goal and Non-Goals

**Goal:**
Deliver a working Phase 1 Excalidraw-first voice copilot inside Bud. The user presses a configurable hotkey, a dedicated canvas window opens/focuses, and Bud holds a continuous voice conversation that can create sketchnotes, edit existing elements, and review/propose changes via temporary ghost elements. Small safe edits apply immediately; destructive, large, or ambiguous edits require spoken confirmation through the proposal flow. Bud talks back naturally; the UI is voice-first with only a passive HUD.

**Non-Goals (Phase 1):**
- No control of excalidraw.com — we embed `@excalidraw/excalidraw`.
- No real-time collaboration.
- No primary approve/decline buttons — confirmation is spoken.
- No domain-specific diagram templates.
- No mouse automation to draw.
- No reuse of the existing transparent annotation overlay as the canvas.
- No packaged offline font/assets in Phase 1 (dev build may use the npm package; packaging is Phase 2).
- No full export/save-as UI (`.excalidraw`, PNG, SVG) — only basic autosave + recent-session index.
- No `importScene` execution — the operation is represented and returns `{ status: 'unsupported' }` until Phase 2.

---

## 2. Repo Facts / Current Constraints

- **Electron main process** is the policy owner today (`app/src/main/main.ts`).
- **Renderer processes** are plain HTML/JS loaded with `BrowserWindow.loadFile` (`overlay`, `panel`, `recorder`). The build is `tsc` only.
- **Preload:** `app/src/main/preload.ts` exposes `window.budAPI`. A dedicated preload for the canvas must be added and kept separate.
- **Tool registration precedent:** `createDrawAnnotationTools` (`app/src/main/annotations/createDrawAnnotationTool.ts`) returns both a Vercel AI SDK `tool()` and a `RealtimeToolBridge` `ToolExecutor` wrapping the same `AnnotationController`.
- **Controller precedent:** `AnnotationController` (`app/src/main/annotations/AnnotationController.ts`) is a main-process controller that sends commands to a renderer over IPC.
- **Prompt wiring precedent:** `ANNOTATION_PROMPT_INSTRUCTIONS` (`app/src/main/annotations/annotationPrompt.ts`) is appended to `BUD_SYSTEM_PROMPT` in `agentPrompts.ts` and to `ORCHESTRATOR_SYSTEM_PROMPT` in `orchestrator/orchestratorPrompt.ts`.
- **Global hotkey:** `app/src/main/globalHotkey.ts` currently handles Ctrl+Alt push-to-talk and Ctrl+Alt+M mute toggle via `uiohook-napi` with a `globalShortcut` fallback.
- **Settings:** `app/src/main/settings.ts` uses nested merges for `modal` and `local` blocks.
- **Package/build:** `app/package.json` uses `tsc` only; adding React + Excalidraw requires a new Vite-based renderer build.

**Implication:** The biggest new infrastructure is a Vite-bundled React renderer. All other wiring follows existing seams.

---

## 3. Slice Order with Rationale

| Slice | Focus | Rationale |
|-------|-------|-----------|
| S0 | Vite + React + Excalidraw renderer shell | Must exist before any main/renderer IPC can be tested. |
| S1 | Window manager + controller skeleton + `readScene` IPC | Establishes the main/renderer boundary and the compact scene summary contract. |
| S2 | Hotkey + canvas-scoped session toggle | Makes the surface reachable by the user and defines session lifecycle. |
| S3 | `applyOperation` + deterministic safety gate | Enables immediate safe edits and blocks the risky ones. |
| S4 | Propose/confirm/cancel + ghost elements | Adds the review/confirm flow, the core product differentiator. |
| S5 | Undo + snapshot ring | Makes mistakes recoverable in a voice-first loop. |
| S6 | Autosave + lightweight recent sessions | Preserves user work across restarts. |
| S7 | Dual tool registration + prompt wiring | Connects the canvas to both Realtime voice and chat/Orchestrator. |

---

## 4. Detailed Slices

### S0 — Build infra + blank embedded Excalidraw renderer

**Demo outcome:** `npm run dev` opens a new interactive "Bud Canvas" `BrowserWindow` that mounts a blank `@excalidraw/excalidraw` canvas. The user can draw manually. Main process logs `canvas renderer loaded`.

**Files to create:**
- `app/vite.canvas.config.ts` — Vite config that builds `app/src/renderer/canvas/index.html` → `app/dist/renderer/canvas/`.
- `app/src/renderer/canvas/tsconfig.json` — JSX `react-jsx`, ES2022, module resolution for the bundler.
- `app/src/renderer/canvas/index.html` — entry HTML that loads the Vite bundle.
- `app/src/renderer/canvas/main.tsx` — React root mount.
- `app/src/renderer/canvas/App.tsx` — hosts `<Excalidraw>` and captures the `ExcalidrawAPI` handle.

**Files to modify:**
- `app/package.json`:
  - Add deps: `@excalidraw/excalidraw`, `react`, `react-dom`.
  - Add dev deps: `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`.
  - Add script `"build:canvas": "vite build --config vite.canvas.config.ts"`.
  - Update `"build"`: `"tsc && npm run build:canvas"`.
  - Update `"dev"` and `"package"` to run `build:canvas` before Electron.
- `app/tsconfig.json`:
  - Exclude `src/renderer/canvas/**/*` from the main `tsc` build so JSX and the bundler do not conflict.

**Interfaces/contracts:**
- Vite build output path: `app/dist/renderer/canvas/index.html`.
- Renderer logs `window.__BUD_CANVAS_READY__` or equivalent; no `contextBridge` surface yet.

**Validation commands / manual QA:**
- `cd app && npm install && npm run build:canvas && npm run dev`.
- Manually call `excalidrawWindowManager.openOrFocus()` (dev helper) or load the window from a temporary main-process call.
- Confirm Excalidraw mounts, can be drawn on, and no runtime errors.

**Risks / steering notes:**
- This is the highest-risk slice because Bud has no bundler today. Keep the canvas renderer fully isolated; do not migrate existing renderers.
- Use `@excalidraw/excalidraw` from npm; do not load excalidraw.com in a `BrowserWindow`.
- Offline font packaging is intentionally deferred; expect network font loading in dev. Track as a Phase 2 packaging task.

---

### S1 — Canvas window manager + controller skeleton + `readScene` IPC

**Demo outcome:** Main process can call `excalidrawWindowManager.openOrFocus()` and `excalidrawController.readScene()` returns a compact `SceneSummary` from the renderer without full scene JSON.

**Files to create:**
- `app/src/main/excalidraw/ExcalidrawWindowManager.ts` — interactive `BrowserWindow` lifecycle (create, show/focus, send, destroy).
- `app/src/main/excalidraw/ExcalidrawController.ts` — skeleton controller with `readScene()`.
- `app/src/main/excalidraw/excalidrawTypes.ts` — shared types: `SceneSummary`, `ExcalidrawOperation`, `ExcalidrawProposal`, `ApplyResult`, `UndoResult`.
- `app/src/main/canvasPreload.ts` — dedicated preload exposing `window.budCanvasAPI`.
- `app/src/renderer/canvas/ipc.ts` — renderer-side handlers for `requestScene` and `scene-change` publish.

**Files to modify:**
- `app/src/main/main.ts`:
  - Import and instantiate `ExcalidrawWindowManager` and `ExcalidrawController` inside `app.whenReady()`.
  - Pass `sendToCanvas` / `getCanvasWindow` callbacks to the controller.
- `app/src/renderer/canvas/App.tsx`:
  - Import and initialize the IPC surface via `window.budCanvasAPI`.

**Interfaces/contracts:**
```ts
// ExcalidrawWindowManager
openOrFocus(): Promise<BrowserWindow>;
sendToCanvas(channel: string, data: any): void;
getWindow(): BrowserWindow | null;
destroy(): void;

// ExcalidrawController
readScene(): Promise<SceneSummary>;

// IPC channels
// main -> renderer invoke
'canvas:requestScene' -> SceneSummary
// renderer -> main publish
'canvas:scene-change' -> { sceneVersion: number; elementCount: number }
```

`SceneSummary` shape (compact, no full element JSON):
```ts
interface SceneSummary {
  sceneVersion: number;
  elementCount: number;
  canvasSize: { width: number; height: number };
  selection: string[];
  elements: Array<{
    id: string;
    type: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'text' | 'freedraw' | 'image';
    text?: string;
    x: number; y: number;
    width: number; height: number;
    strokeColor?: string;
    backgroundColor?: string;
  }>;
}
```

**Validation commands / manual QA:**
- Unit test: mock the ExcalidrawAPI and assert `readScene()` omits full JSON and includes `sceneVersion`.
- Manual QA: open the canvas from the dev console, call `controller.readScene()`, and verify the returned summary.

**Risks / steering notes:**
- Use `ipcMain.handle` / `ipcRenderer.invoke` for request/response. Add a small correlation/timeout helper later if rapid voice turns expose races.
- Wait for `did-finish-load` before sending IPC; queue early messages if needed.

---

### S2 — Configurable hotkey + canvas-scoped voice session toggle

**Demo outcome:** Pressing the default hotkey (`CommandOrControl+Shift+Space`) opens/focuses the canvas and starts a copilot session; the HUD shows "listening". Pressing again ends the session but leaves the sketch intact. If Bud was globally muted, the first press unmutes; ending restores the previous mute state.

**Files to create:**
- `app/src/renderer/canvas/HUD.tsx` — minimal floating status pill (listening / speaking / proposal pending / saved).

**Files to modify:**
- `app/src/main/globalHotkey.ts`:
  - Add `onCanvasToggle?: () => void` to options.
  - Register `CommandOrControl+Shift+Space` in the uiohook listener (track Shift + Space while modifiers held). In the `globalShortcut` fallback use `globalShortcut.register('CommandOrControl+Shift+Space', ...)`. Log a warning if registration fails.
- `app/src/main/settings.ts`:
  - Add nested `excalidraw` block with defaults:
    ```ts
    excalidraw: {
      toggleHotkey: 'CommandOrControl+Shift+Space',
      saveDirectory: string,              // default: app.getPath('userData')/excalidraw-sessions
      autosaveIntervalMs: 5000,
      theme: 'auto',
      safetyThresholds: {
        maxElementsPerImmediateApply: 5,
        maxElementsPerDelete: 3,
      },
      snapshotRing: {
        maxOperations: 50,
        maxAgeMs: 1_800_000, // 30 min
      },
    }
    ```
  - Nested-merge `excalidraw` in `loadSettings` and `saveSettings`.
- `app/src/main/excalidraw/ExcalidrawController.ts`:
  - Add `startSession()`, `endSession()`, `isSessionActive`, `toggleSession()`.
  - On start: call `windowManager.openOrFocus()`, unmute Realtime if muted (via injected callback), publish HUD state.
  - On end: restore prior mute state if it was changed, keep window open, publish HUD state.
- `app/src/main/main.ts`:
  - Pass `onCanvasToggle: () => controller.toggleSession()` to `GlobalHotkey`.
  - Pass `toggleMute: () => realtimeVoiceManager?.toggleMute()` to the controller so it can unmute/restore.

**Interfaces/contracts:**
```ts
// GlobalHotkey options
onCanvasToggle?: () => void;

// ExcalidrawController
toggleSession(): Promise<boolean>; // returns new isSessionActive
getSessionState(): { isActive: boolean; startedAt?: number };

// HUD channel
'canvas:hud' -> { state: 'idle' | 'listening' | 'speaking' | 'proposalPending' | 'saved' }
```

**Validation commands / manual QA:**
- Unit test: settings nested-merge for `excalidraw` defaults and overrides.
- Manual QA: press default hotkey → canvas appears and HUD shows listening; press again → HUD returns to idle, sketch remains. Edit `settings.json` to remap `excalidraw.toggleHotkey`, restart, and confirm the new accelerator is used.

**Risks / steering notes:**
- `CommandOrControl+Shift+Space` may collide with OS shortcuts on some platforms. The implementation must warn and allow remap via settings.
- The hotkey toggles a **canvas-scoped session/context**, not the raw microphone. Be explicit in user-facing copy so it does not feel inconsistent with Bud's always-on listening model.

---

### S3 — `applyOperation` + safety gate

**Demo outcome:** Voice commands like "draw a blue rectangle" or "make that box red" apply immediately. Destructive/large/ambiguous commands ("delete everything", "clear the canvas", "reorganize the layout") are rejected by the deterministic safety gate and return a `proposeRequired` / `ambiguous` / `unsupported` status without mutating the scene.

**Files to create:**
- `app/src/main/excalidraw/safetyGate.ts` — deterministic classifier.
- `app/src/main/excalidraw/safetyGate.test.ts` — unit tests using the repo's plain-node test style.

**Files to modify:**
- `app/src/main/excalidraw/excalidrawTypes.ts`:
  - Add `ExcalidrawOperation` union and `ApplyResult`.
- `app/src/main/excalidraw/ExcalidrawController.ts`:
  - Implement `applyOperation(op): Promise<ApplyResult>`.
  - Run the safety gate; immediate-safe ops commit via `sendToCanvas('canvas:applyScene', { operations, sceneVersion })`.
  - Return structured statuses (`applied`, `proposeRequired`, `ambiguous`, `unsupported`).
  - For `importScene`, return `{ status: 'unsupported', reason: 'import is Phase 2; use export/save-as flow' }`.
- `app/src/main/canvasPreload.ts`:
  - Add `applyScene(operations)` invoke channel.
- `app/src/renderer/canvas/ipc.ts`:
  - Apply operations through the captured `ExcalidrawAPI` (`updateScene`).
  - Publish `canvas:scene-change` after each apply.

**Interfaces/contracts:**
```ts
type ExcalidrawOperation =
  | { kind: 'create'; elementType: ExcalidrawElementType; x; y; width; height; text?; strokeColor?; backgroundColor?; strokeWidth? }
  | { kind: 'update'; id: string; changes: Partial<ExcalidrawElement> }
  | { kind: 'delete'; ids: string[] }
  | { kind: 'align'; ids: string[]; alignment: 'left'|'center'|'right'|'top'|'middle'|'bottom' }
  | { kind: 'group' | 'ungroup'; ids: string[] }
  | { kind: 'clearCanvas' }
  | { kind: 'replaceScene'; elements: ExcalidrawElement[] }
  | { kind: 'importScene'; source: { type: 'file'; path: string } | { type: 'session'; sessionId: string } }
  | { kind: 'reorganizeLayout'; ids: string[]; layout: 'grid'|'tree'|'flow'|'auto' };

type ApplyResult =
  | { status: 'applied'; sceneVersion: number; affectedIds: string[] }
  | { status: 'proposeRequired'; reason: string }
  | { status: 'ambiguous'; matches: string[] }
  | { status: 'unsupported'; reason: string };

// Safety gate
classify(op: ExcalidrawOperation, context: { elementCount: number; settings: AppSettings['excalidraw'] })
  : 'immediate' | 'proposal' | 'confirmRequired' | 'ambiguous' | 'unsupported'
```

**Validation commands / manual QA:**
- `cd app && npx ts-node src/main/excalidraw/safetyGate.test.ts` — assert:
  - small `create`/`update` → immediate
  - `clearCanvas`, `replaceScene`, `reorganizeLayout` → confirmRequired/proposeRequired
  - bulk `delete` above threshold → confirmRequired
  - `importScene` → unsupported
- Manual QA: via chat/Orchestrator or a dev console call, send `applyOperation({ kind: 'create', ... })` and see the shape appear; send `applyOperation({ kind: 'clearCanvas' })` and see it rejected.

**Risks / steering notes:**
- The safety gate must be deterministic and based on operation kind + configured thresholds, never on model self-certification.
- Before applying, the controller should call `readScene()` to get the latest `sceneVersion` and avoid clobbering concurrent manual drawing.
- Batch one voice command into a single `applyScene` IPC call so one native undo maps to one voice command.

---

### S4 — Propose / confirm / cancel + ghost elements

**Demo outcome:** "What if we add two boxes to the right?" renders translucent/dashed ghost boxes. Saying "apply" commits them as real elements; saying "cancel" removes them; saying "change it" drops the old proposal and creates a revised one. Review alternatives (`review_options`) render distinct ghost sets; selecting one by voice commits only that option.

**Files to create:**
- `app/src/main/excalidraw/proposalLifecycle.test.ts` — unit tests for propose/confirm/cancel/supersede.

**Files to modify:**
- `app/src/main/excalidraw/excalidrawTypes.ts`:
  - Add proposal shapes:
    ```ts
    type ExcalidrawProposal = {
      proposalId?: string;
      mode: 'diagram_patch' | 'review_options';
      summary: string;
      operations?: ExcalidrawOperation[];
      options?: ProposalOption[];
      overlayAnnotations?: AnnotationRequest[];
      safetyLevel?: 'proposal' | 'confirmRequired';
      diffSummary?: string;
      ttlMs?: number;
      expiresAt?: number;
    };

    type ProposalOption = { id: string; title: string; rationale: string; operations: ExcalidrawOperation[] };
    type AnnotationRequest = { kind: 'point'|'highlight'|'label'; targetElementId?: string; text?; x?; y? };
    type ApplyResult = ... | { status: 'selectOption'; proposalId: string; optionIds: string[] };
    ```
- `app/src/main/excalidraw/ExcalidrawController.ts`:
  - Implement `proposeOperation(proposal): Promise<ExcalidrawProposal>`:
    - Validate payload.
    - Assign `proposalId` (uuid).
    - Run safety gate to set `safetyLevel`.
    - Compute `diffSummary`.
    - Set TTL (default e.g. 10 min).
    - Supersede any active proposal.
    - Send `sendToCanvas('canvas:renderGhosts', { proposalId, mode, operations/options, overlayAnnotations })`.
  - Implement `confirmProposal(id, optionId?): Promise<ApplyResult>`:
    - For `diagram_patch`: commit operations as a real `applyScene` update.
    - For `review_options`: require `optionId`; convert selected option to `diagram_patch` and commit; return `selectOption` if missing.
    - Clear ghosts after commit.
  - Implement `cancelProposal(id): Promise<void>`:
    - Drop proposal state and send `canvas:clearGhosts`.
  - Add TTL expiry check (interval or on each operation).
- `app/src/main/canvasPreload.ts`:
  - Add `renderGhosts(payload)`, `clearGhosts(proposalId?)` channels.
- `app/src/renderer/canvas/App.tsx`:
  - Render ghost elements in-scene with `customData: { proposalId, ghost: true, optionId? }`.
  - Apply translucent/dashed styling.
  - Render overlay annotations in a separate absolute-positioned layer over the canvas.
  - Omit ghosts from `requestScene` summaries.

**Interfaces/contracts:**
```ts
// Controller
proposeOperation(proposal: ExcalidrawProposal): Promise<ExcalidrawProposal>;
confirmProposal(proposalId: string, optionId?: string): Promise<ApplyResult>;
cancelProposal(proposalId: string): Promise<void>;
clearProposals(): void; // used by Realtime speech.started / interruption

// IPC channels
'canvas:renderGhosts' -> GhostPayload
'canvas:clearGhosts' -> { proposalId?: string }
```

**Validation commands / manual QA:**
- Unit tests: `propose -> confirm` commits; `propose -> cancel` clears ghosts; new proposal supersedes old; `review_options` without `optionId` returns `selectOption`; with `optionId` commits only selected option.
- Manual QA:
  - Voice "what if we add two boxes?" → ghosts appear → "apply" → real elements.
  - Voice "give me two layout options" → two ghost sets → "option two" → only that set commits.
  - Inspect scene JSON to confirm `customData.ghost === true` on proposals and ghosts are excluded from `readScene`.

**Risks / steering notes:**
- Ghosts are in-scene Excalidraw elements; adding them may create native history entries. Do not count ghost additions as Bud-applied operations. If a native undo accidentally removes ghosts, re-render the active proposal's ghosts from in-memory proposal state.
- Keep only one active proposal at a time. A new proposal must cancel the previous one.
- Overlay annotations (point/highlight/label) are display-only and must not store proposal state.

---

### S5 — Undo + snapshot ring

**Demo outcome:** After a Bud-applied edit, saying "undo that" reverts it. If native Excalidraw undo produces no scene change, the controller restores the last snapshot from the ring and returns `via: 'snapshot'`.

**Files to create:**
- `app/src/main/excalidraw/SnapshotRing.ts` — ring buffer of recent scenes.
- `app/src/main/excalidraw/SnapshotRing.test.ts` — unit tests for count/age eviction.

**Files to modify:**
- `app/src/main/excalidraw/excalidrawTypes.ts`:
  - Add `UndoResult`:
    ```ts
    type UndoResult =
      | { status: 'undone'; via: 'native' | 'snapshot'; sceneVersion: number }
      | { status: 'nothingToUndo' };
    ```
- `app/src/main/excalidraw/ExcalidrawController.ts`:
  - After every Bud-applied commit (not ghost render), push `{ sceneVersion, elements, timestamp }` to the snapshot ring.
  - Implement `undo(): Promise<UndoResult>`:
    1. If no Bud-applied history, return `nothingToUndo`.
    2. Focus the canvas window.
    3. Send platform-appropriate `CommandOrControl+Z` accelerator.
    4. Wait for `canvas:scene-change`; verify `sceneVersion` decreased/changed.
    5. If no delta within timeout, restore the most recent snapshot via `applyScene({ replaceScene: snapshot.elements })` and return `via: 'snapshot'`.
  - Implement `redo()` as best-effort using `CommandOrControl+Y` or `CommandOrControl+Shift+Z`, with no snapshot fallback.
- `app/src/main/canvasPreload.ts`:
  - Add `undo()` / `redo()` channels (or use the generic `sendUndoAccelerator` approach in main).

**Interfaces/contracts:**
```ts
// SnapshotRing
push(snapshot: { sceneVersion: number; elements: ExcalidrawElement[]; timestamp: number }): void;
peek(): Snapshot | undefined;
evict(maxOperations: number, maxAgeMs: number): void;

// Controller
undo(): Promise<UndoResult>;
redo(): Promise<UndoResult>;
```

**Validation commands / manual QA:**
- Unit tests: snapshot ring eviction by count and age.
- Manual QA:
  - Voice-create a shape, then "undo that" → shape disappears, controller reports `via: 'native'`.
  - Simulate native undo failure (e.g., user already undid manually) → controller restores snapshot and reports `via: 'snapshot'`.

**Risks / steering notes:**
- Excalidraw exposes no public undo API except `history.clear`. Keyboard synthesis is the chosen V1 approach; prefer a public API if one becomes available.
- Window focus is required before sending the accelerator. Add a small delay and verify the `sceneVersion` delta; do not assume undo succeeded.
- Redo support is best-effort because the Excalidraw history stack may be invalidated by controller-driven mutations.

---

### S6 — Autosave + lightweight recent sessions

**Demo outcome:** The current scene is autosaved every 5 seconds to a workspace directory. A lightweight index of recent sessions survives an app restart and is queryable via `get-status` / settings.

**Files to create:**
- `app/src/main/excalidraw/SessionStore.ts` — load/save `excalidraw-sessions.json` in userData.
- `app/src/main/excalidraw/SessionStore.test.ts` — unit tests for add/evict.

**Files to modify:**
- `app/src/main/excalidraw/ExcalidrawController.ts`:
  - Add autosave interval.
  - On save: derive session name from first text element or timestamp; write `.excalidraw` JSON to `saveDirectory`; update `SessionStore`.
  - Mark dirty on `canvas:scene-change`; debounce writes (e.g. 1–2 s).
- `app/src/main/settings.ts`:
  - Default `excalidraw.saveDirectory` to `path.join(app.getPath('userData'), 'excalidraw-sessions')`.
- `app/src/main/main.ts`:
  - Optionally expose recent sessions in `get-status` IPC.

**Interfaces/contracts:**
```ts
// SessionStore index shape
interface RecentSessionsIndex {
  sessions: Array<{
    sessionId: string;
    name: string;
    updatedAt: number;
    filePath: string;
  }>;
}

// Autosave defaults
autosaveIntervalMs: 5000;
maxRecentSessions: 20; // evict oldest
```

**Validation commands / manual QA:**
- Unit tests: SessionStore add and evict by max count.
- Manual QA:
  - Draw in canvas, wait 5–10 s, inspect `saveDirectory` for a `.excalidraw` file and `excalidraw-sessions.json`.
  - Restart Bud, call `get-status`, and verify the recent session list includes the saved session.

**Risks / steering notes:**
- Do not write the full scene on every keystroke. Use a dirty flag + debounce.
- Large scenes may increase memory/IO cost; Phase 2 will tune snapshot/autosave intervals.
- Keep the recent index small; a full recent-sessions UI is Phase 2.

---

### S7 — Dual-registration + prompt wiring

**Demo outcome:** Both the Realtime voice pipeline and the chat/Orchestrator can call `excalidraw_*` tools, and both system prompts include the Excalidraw instructions. Pending proposals/ghosts are cleared on Realtime `speech.started` and `interruption`.

**Files to create:**
- `app/src/main/excalidraw/createExcalidrawTools.ts` — mirrors `createDrawAnnotationTools`.
- `app/src/main/excalidraw/excalidrawPrompts.ts` — `EXCALIDRAW_PROMPT_INSTRUCTIONS`.
- `app/src/main/excalidraw/createExcalidrawTools.test.ts` — integration test that both registrations route to the same controller methods.

**Files to modify:**
- `app/src/main/main.ts`:
  - After controller construction: `const excalidrawTools = createExcalidrawTools(excalidrawController);`
  - Add `excalidrawTools.realtimeExecutor` to the `toolExecutors` array passed to `realtimeVoiceManager.registerTools(...)`.
  - Add Realtime event handlers:
    ```ts
    realtimeVoiceManager.on('speech.started', () => excalidrawController.clearProposals());
    realtimeVoiceManager.on('interruption', () => excalidrawController.clearProposals());
    ```
  - In `executeChatCompletion`, add `excalidrawTools.vercelTool` to the `tools` object (e.g., `excalidraw: excalidrawTools.vercelTool`).
- `app/src/main/agentPrompts.ts`:
  - Import `EXCALIDRAW_PROMPT_INSTRUCTIONS` from `./excalidraw/excalidrawPrompts`.
  - Append it to `BUD_SYSTEM_PROMPT`.
- `app/src/main/orchestrator/orchestratorPrompt.ts`:
  - Import `EXCALIDRAW_PROMPT_INSTRUCTIONS`.
  - Append it to `ORCHESTRATOR_SYSTEM_PROMPT`.

**Interfaces/contracts:**
```ts
// createExcalidrawTools
function createExcalidrawTools(controller: ExcalidrawController): {
  vercelTool: Tool;
  realtimeExecutor: ToolExecutor;
};

// Tool names
excalidraw_readScene
excalidraw_applyOperation
excalidraw_proposeOperation
excalidraw_confirmProposal
excalidraw_cancelProposal
excalidraw_undo
// export/save tools are Phase 2 stubs (optional)
```

**Validation commands / manual QA:**
- Integration test: create a mock `RealtimeToolBridge` and a Vercel-style `tool()` harness; invoke `excalidraw_readScene` and `excalidraw_applyOperation` through both paths and assert they call the same controller method and return the same compact summary.
- Manual QA:
  - Start Realtime, press hotkey, say "draw a red rectangle" → rectangle appears.
  - Start a chat turn, ask "add a blue circle" → circle appears.
  - Start a proposal, then interrupt Bud → ghosts clear.

**Risks / steering notes:**
- Realtime tool results may be truncated; keep schemas tight and rely on the compact `SceneSummary`.
- The two prompts differ (Realtime uses `<TTS>` markers, Orchestrator does not); keep the instructions voice-first and UI-agnostic.
- Ensure `clearProposals()` is safe when no proposal is active.

---

## 5. Build / Dependency Changes Summary

### New runtime dependencies (`app/package.json`)
- `@excalidraw/excalidraw`
- `react`
- `react-dom`

### New dev dependencies
- `vite`
- `@vitejs/plugin-react`
- `@types/react`
- `@types/react-dom`

### New build scripts
```json
{
  "build:canvas": "vite build --config vite.canvas.config.ts",
  "build": "tsc && npm run build:canvas",
  "dev": "tsc && npm run build:canvas && electron .",
  "package": "npm run build && electron-builder"
}
```

### New / changed build files
- `app/vite.canvas.config.ts`
- `app/src/renderer/canvas/tsconfig.json`
- `app/tsconfig.json` — exclude `src/renderer/canvas/**/*`
- `app/package.json` — deps, dev deps, scripts

### Packaging note
Phase 1 does **not** package offline Excalidraw fonts/assets. The Vite-bundled renderer uses the npm package, which may load fonts from the network in development. Phase 2 will update `electron-builder` config and the Vite build to bundle offline fonts.

---

## 6. Deferred Phase 2 Items

- `importScene` implementation (currently returns `{ status: 'unsupported' }`).
- Recent-sessions UI inside the canvas window or panel.
- Export / save-as: `.excalidraw`, PNG, SVG.
- Offline packaging of Excalidraw fonts/assets in the renderer bundle.
- Snapshot-ring tuning for large-scene memory cost.
- Safety thresholds UX and policy fine-tuning.
- `excalidraw_getElement` detail tool (per-element full JSON escape valve for context bloat).
- Better ambiguous-reference clarification flow.
- Multi-option proposal styling polish and keyboard accessibility.

---

## 7. Final Phase 1 Acceptance Checklist

- [ ] `npm run build` passes: main `tsc` compiles and canvas Vite bundle builds.
- [ ] `npm run package` succeeds (renderer bundle is included).
- [ ] Default hotkey `CommandOrControl+Shift+Space` opens/focuses the canvas and starts a copilot session; pressing again ends the session but leaves the sketch.
- [ ] Hotkey is user-remappable via `settings.json` under `excalidraw.toggleHotkey`.
- [ ] Voice create works end-to-end for a general sketchnote.
- [ ] Voice edit works on the selection and on unambiguous natural-language references.
- [ ] Review/brainstorm produces a visual ghost proposal without committing.
- [ ] "apply" commits a proposal; "cancel" clears ghosts; "change it" re-proposes.
- [ ] `review_options` renders distinct ghost sets; voice selection commits only the selected option.
- [ ] The deterministic safety gate prevents immediate application of `clearCanvas`, `replaceScene`, `reorganizeLayout`, bulk deletes, and ambiguous targets.
- [ ] "undo that" reverts the last Bud-applied action via native undo or snapshot fallback.
- [ ] Autosave writes the scene to `excalidraw.saveDirectory` every 5 s.
- [ ] Recent sessions index survives an app restart.
- [ ] Tools are reachable from both Realtime voice and chat/Orchestrator.
- [ ] `BUD_SYSTEM_PROMPT` and `ORCHESTRATOR_SYSTEM_PROMPT` include `EXCALIDRAW_PROMPT_INSTRUCTIONS`.
- [ ] Realtime `speech.started` / `interruption` clear pending proposals/ghosts.
- [ ] No application code outside the plan's file list is modified (plan is documentation-only).
