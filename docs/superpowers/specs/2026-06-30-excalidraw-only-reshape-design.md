# Excalidraw-Only Reshape Design

**Date:** 2026-06-30
**Status:** Approved
**Scope:** Reshape Bud from a Windows desktop companion into an AI-native, cross-platform (win/mac/linux) voice assistant focused solely on Excalidraw. Delete all non-Excalidraw surfaces, tools, and providers; keep only the Excalidraw canvas, the Cartesia voice path, and exactly four tools. Application + docs changes.

## 1. Goal

Make Bud an Excalidraw-only voice copilot that runs on any OS. Everything not serving Excalidraw voice interaction is deleted. The product surface is the embedded Excalidraw canvas plus a floating pill/panel for voice state and text chat. Voice is powered by the Cartesia STT → Orchestrator → TTS pipeline. The agent has exactly four tools: `websearch`, `excalidraw`, `memorytool`, and `spawnagent`.

This is a hard prune, not a side mode. Computer Use, screen vision, element pointing, the OpenAI Realtime WebRTC path, the Modal/Ollama/AssemblyAI providers, and the Windows/apps/troubleshooting tools are removed entirely. Git history preserves them; they are recoverable.

## 2. Non-Goals

- **No Computer Use / vision / screen annotation / element pointing.** Removed entirely.
- **No OpenAI Realtime WebRTC path or SDP server.** Cartesia is the only voice backend.
- **No Modal / Ollama / AssemblyAI / Local providers.** Removed.
- **No Windows/apps/troubleshooting/fileReader/notify tools.** Removed.
- **No legacy push-to-talk recorder or ffmpeg pipeline.** Removed.
- **No external excalidraw.com control.** Bud keeps its own embedded canvas (unchanged from Phase 1).
- **No collaboration.** Single-user, local only.
- **No deep rewrite of working subsystems.** `excalidraw/`, `orchestrator/`, and the Cartesia session classes are kept as-is; only their wiring and dead helpers change.

## 3. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Electron, cross-platform (win/mac/linux) | Least churn; Phase 1 Excalidraw embedding already works in Electron; `globalShortcut`/`Tray`/`alwaysOnTop` are cross-platform |
| Voice backend | Cartesia only (STT → Orchestrator → TTS) | User's WIP lives here; drops the OpenAI Realtime WebRTC path and SDP server |
| UI surfaces | Excalidraw Canvas + Floating Pill/Chat Panel + Tray + global hotkey; drop Companion Overlay | Excalidraw work needs no cursor pointing; voice state routes to the pill |
| Tool set | Exactly 4: `websearch`, `excalidraw`, `memorytool`, `spawnagent` | Focused scope; everything else is YAGNI |
| Excalidraw integration | Official `@excalidraw/excalidraw` React component, imperative API via secure preload/IPC | Confirmed best practice by Excalidraw docs; Phase 1 already does this |
| Font hosting | Self-host via `window.EXCALIDRAW_ASSET_PATH` | Offline/desktop reliability; no CDN dependency |
| `spawnagent` semantics | Async background worker (fork `worker.ts`), returns taskId | Renamed from `spawnWorker`; same model |
| Worker tool subset | `{searchWeb, memory}` only | Forked worker cannot reach `ExcalidrawController`/canvas; `excalidraw` and nested `spawnagent` excluded |
| Voice state routing | `UISink` interface replaces `overlayManager` | Decouples Cartesia manager from the deleted overlay; pill/panel receives state |
| Image tool handling | Remove `normalizeToolResult`/`resizeBase64Image`/`stripImageData` from Cartesia manager | No image tools remain; dead code |
| Packaging | electron-builder win nsis + mac dmg + linux AppImage | True cross-platform distribution |
| Native deps | Drop `nut-js`, `screenshot-desktop`, `uiohook-napi`, `ffmpeg-installer`, `assemblyai`, `mammoth`, `pdf-parse`, `ollama-ai-provider-v2`, `sharp` (verify) | Only needed by deleted subsystems; `better-sqlite3` (bus) stays with electron-rebuild |
| Branch strategy | New branch `bud-excalidraw-only` from current detached HEAD; commit WIP first, then deletions | Preserves the 12 uncommitted Cartesia/excalidraw edits as the starting point; git keeps deleted code recoverable |
| Execution approach | A — surgical prune + slim fresh `main.ts` | Lowest risk; preserves tested modules; readable bootstrap |

## 4. Architecture (after reshape)

### 4.1 High-Level Flow

```
Mic → panel renderer (cartesia-realtime AudioWorklet)
   → CartesiaRealtimeVoiceManager
        → CartesiaSTTSession  ──turn.end transcript──►  OrchestratorAgent
        │                                                (AI SDK streamText + 4 tools)
        │   ◄──text chunks──  OrchestratorAgent
        → CartesiaTTSSession  ──audio chunks──►  panel playback
        → UISink ──voice state + events──►  pill/panel

ExcalidrawController (main) ↔ canvas renderer (official @excalidraw/excalidraw)
        via canvasPreload IPC (updateScene / restore / scene-change publish)

Tray · GlobalHotkey · Settings · Bus  surround the above

spawnagent → forks worker.ts (searchWeb + memory only; reports via bus)
```

### 4.2 Components Retained

- **`excalidraw/`** — `ExcalidrawController`, `ExcalidrawWindowManager`, `excalidrawTypes`, `safetyGate`, `SnapshotRing`, `SessionStore`, `createExcalidrawTools`, `excalidrawPrompts`, and all tests. Unchanged.
- **`orchestrator/`** — `OrchestratorAgent`, `OrchestratorEventBus`, `RetryToolExecutor`, `ToolResultEnricher`, `TTSMarkerParser`, `orchestratorPrompt`, and tests. Unchanged.
- **Cartesia voice** — `CartesiaRealtimeVoiceManager`, `CartesiaSTTSession`, `CartesiaTTSSession`, `cartesiaTypes`. Kept; manager edited to drop `overlayManager` and image helpers.
- **`realtime/RealtimeToolBridge.ts`** — kept (used by Cartesia manager). `ToolExecutor` interface retained.
- **Shell** — `bus.ts`, `globalHotkey.ts`, `tray.ts`, `settings.ts` (slimmed), `llmProvider.ts`, `preload.ts`, `canvasPreload.ts`, `logger.ts`.
- **Renderer** — `canvas/*` (Excalidraw React app), `panel/{index.html, cartesia-realtime.js, realtime-worklet.js}`.
- **Worker** — `worker/worker.ts` (rewritten to stateless subset).

### 4.3 New / Edited Surfaces

- **`UISink` interface** (new, small) — `{ sendState(state: CartesiaVoiceState): void; sendToUI(channel: string, data: any): void }`. Implemented by the panel/pill wiring in `main.ts`; passed into `CartesiaRealtimeVoiceManagerOptions` in place of `overlayManager`.
- **`main.ts`** — rewritten fresh as a ~200-line bootstrap. Owns: app lifecycle, single-instance lock, `.env` load, tray, panel window, canvas window, `ExcalidrawController` + `ExcalidrawWindowManager`, `OrchestratorAgent`, `CartesiaRealtimeVoiceManager` (with `UISink`), tool registration (4 tools), global hotkey (canvas session toggle + mute), settings, IPC handlers for chat + canvas. Drops all imports of deleted modules.
- **`CartesiaRealtimeVoiceManager`** — replace `overlayManager` field with `uiSink: UISink`; route `setVoiceState` + `emitToUI` through it; delete `normalizeToolResult`, `resizeBase64Image`, `stripImageData`, and the `nativeImage` import (no image tools).
- **`tools/spawnAgent.ts`** — renamed from `spawnWorker.ts`; `createSpawnWorkerTool` → `createSpawnAgentTool`; default `WORKER_TOOLS_ALLOWED` becomes `['searchWeb', 'memory']`; description updated.
- **`worker/worker.ts`** — rewritten to use only `searchWeb` + `memory` tools (no windows/apps/excalidraw/nested spawn). Keeps OpenAI SDK + `better-sqlite3` bus protocol.
- **`tools/index.ts`** — exports only `searchWeb`, `createMemoryTool`, `createSpawnAgentTool`; plus `createExcalidrawTools` stays in `excalidraw/`.
- **`settings.ts`** — drop Modal/Ollama/vision/local provider config; keep hotkey, mute, model, Cartesia config.
- **`package.json`** — cross-platform `build` targets; dependency prune (see §7).
- **`CONTEXT.md`** — rewritten for the Excalidraw-focused cross-platform product.

## 5. Tool Set (exactly 4)

1. **`websearch`** — `searchWeb.ts`. Exa API (`POST https://api.exa.ai/search`). Env `EXA_API_KEY`. Returns up to 5 results.
2. **`excalidraw`** — the bundle from `createExcalidrawTools.ts`: `excalidraw_readScene`, `excalidraw_applyOperation`, `excalidraw_proposeOperation`, `excalidraw_confirmProposal`, `excalidraw_cancelProposal`, `excalidraw_undo`. Backed by `ExcalidrawController`. Registered for both voice (Realtime ToolBridge) and chat (OrchestratorAgent).
3. **`memorytool`** — `memoryTool.ts` factory `createMemoryTool(memoryDir)`. JSON files under `userData/memory`. Operations: save / get / append / search.
4. **`spawnagent`** — `spawnAgent.ts` factory `createSpawnAgentTool(getPanelWindow)`. Forks `worker.ts` with a taskId; returns immediately; reports progress/completion/failure via the `bus`. Worker tools = `{searchWeb, memory}`. No nested spawn, no excalidraw.

## 6. Voice Pipeline (Cartesia)

Panel renderer captures mic via `realtime-worklet.js` → sends base64 PCM to main → `CartesiaRealtimeVoiceManager.handleAudioChunk` → `CartesiaSTTSession.sendAudioChunk`. STT emits `turn.start` / `turn.update` / `turn.end`. On `turn.end`, the transcript is passed to `OrchestratorAgent.run({ request, signal })`. The orchestrator streams text chunks (`bus.on('text')`) and calls `bus.on('tts', text)` to feed `CartesiaTTSSession.sendText` on the current TTS context; `done` flushes it. TTS audio chunks go to the panel renderer for playback.

Interruption: STT `turn.start` during an active response aborts the orchestrator turn (`turnAbortController.abort()`), cancels the TTS context (`cancelContext`), and drops in-flight audio chunks for the cancelled context id. Voice states (`idle`, `speech-detected`, `processing`, `responding`, `muted`, `fallback`) are routed to the pill via `UISink.sendState`.

Fallback: STT/TTS `failed` or `reconnectFailed` triggers `triggerFallback` → state `fallback` + `onFallbackTriggered` callback (no legacy pipeline to fall back to in this reshape — fallback is a visible degraded state, not a second engine).

## 7. Cross-Platform & Packaging

`package.json` `build` block:

```json
"build": {
  "appId": "com.bud.excalidraw",
  "productName": "Bud",
  "win":    { "target": "nsis",     "icon": "assets/icon.ico" },
  "mac":    { "target": "dmg",      "icon": "assets/icon.icns" },
  "linux":  { "target": "AppImage", "icon": "assets/icon.png" },
  "directories": { "output": "release" }
}
```

> Note: only `assets/icon.ico` exists today. Add `assets/icon.icns` (mac) and `assets/icon.png` (linux) before packaging those targets; electron-builder falls back to a default icon if missing.

**Drop dependencies:** `@nut-tree-fork/nut-js`, `screenshot-desktop`, `uiohook-napi`, `@ffmpeg-installer/ffmpeg`, `assemblyai`, `mammoth`, `pdf-parse`, `ollama-ai-provider-v2`, `sharp` (verify no remaining import — Cartesia manager uses Electron `nativeImage`), `@ai-sdk/groq` (verify). **Keep:** `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `ai`, `@excalidraw/excalidraw`, `openai`, `react`, `react-dom`, `ws`, `zod`, `better-sqlite3`. `better-sqlite3` is native and rebuilt per-platform via electron-rebuild (add to postinstall).

Cross-platform primitives used: `globalShortcut` (hotkey), `Tray` (tray), `alwaysOnTop` (canvas + pill), `nativeImage` (icons). No OS-specific shell scripts remain.

## 8. UI Surfaces

- **Excalidraw Canvas window** — primary, always-on-top, opened/focused by hotkey. Hosts the official `<Excalidraw>` React component + minimal HUD (listening / proposal / saved states).
- **Floating Pill / Chat Panel** — collapsed pill shows voice state; expands to text chat + file drop + transcript + tool-call indicators. Receives Cartesia TTS audio for playback and sends mic PCM to main.
- **Tray** — quit, mute toggle, open canvas, open panel.
- **Hotkeys** — `CommandOrControl+Shift+Space` toggles the canvas voice session; `CommandOrControl+Alt+M` toggles mute. Both user-remappable via settings.

## 9. File Plan

### Keep — `app/src/main`
`main.ts` (rewritten), `bus.ts`, `globalHotkey.ts`, `tray.ts`, `settings.ts` (slimmed), `llmProvider.ts`, `preload.ts`, `canvasPreload.ts`, `excalidraw/*` (all), `orchestrator/*` (all), `realtime/{CartesiaRealtimeVoiceManager,CartesiaSTTSession,CartesiaTTSSession,cartesiaTypes,RealtimeToolBridge}.ts`, `tools/{searchWeb,memoryTool,spawnAgent,index}.ts`, relevant `tests/`.

### Delete — `app/src/main`
`agentManager.ts`, `actionExecutor.ts`, `actionParser.ts`, `actionQueue.ts`, `agentPrompts.ts`, `pointingParser.ts`, `taskPlanParser.ts`, `screenCapture.ts`, `overlay.ts`, `providers/*` (12 files), `annotations/*`, `realtime/{RealtimeSession,RealtimeVoiceManager,RealtimeSDPServer,executeRealtimeCompletion,realtimeTypes}.ts`, `tools/{computerUse,windowsTool,appsTool,troubleshootingTool,fileReaderTool,notify}.ts`, computer-use `tests/`.

### Renderer
Keep: `canvas/*`, `panel/{index.html, cartesia-realtime.js, realtime-worklet.js}`. Delete: `renderer/overlay/*`, `renderer/recorder/*`, `panel/realtime-webrtc.js`.

### Worker
Keep `worker/worker.ts` (rewritten to stateless subset).

### Repo root
Delete: `route.ts` (stray Lautonomy Next.js route), `modal/` (Python serverless), `ASSEMBLYAI.md`, `REALTIME.md`, `TOOLS.md`. Move `excalidraw-phase-1-architecture.html` → `docs/`.

## 10. Branch & WIP Handling

Starting state: detached HEAD at `origin/Bud-excalidraw-v1` with 12 uncommitted modifications on Cartesia + excalidraw files. These edits are desired WIP on the chosen Cartesia path and are preserved as the starting point.

Steps:
1. `git switch -c bud-excalidraw-only` (creates the branch from current detached HEAD, carrying the working-tree changes).
2. Stage and commit the WIP: `chore: snapshot Cartesia + Excalidraw WIP before reshape`.
3. Perform deletions and edits as subsequent focused commits.
4. Git history retains all deleted code on `origin/Bud-excalidraw-v1` and prior commits; "delete for now" is fully recoverable.

## 11. Docs Plan

- **Rewrite `CONTEXT.md`** — new glossary for the Excalidraw-focused cross-platform product. Drop Windows/computer-use/vision/element-pointing/Realtime-WebRTC terms. Refresh: Bud (Excalidraw voice copilot), Floating Pill, Chat Panel, Cartesia Voice Pipeline, Excalidraw Controller, Safety Gate, Snapshot Ring, Session Store, the 4 tools, Mute Toggle, global hotkey.
- **Delete** `ASSEMBLYAI.md`, `REALTIME.md`, `TOOLS.md`.
- **Move** `excalidraw-phase-1-architecture.html` into `docs/` as reference.
- This spec lives at `docs/superpowers/specs/2026-06-30-excalidraw-only-reshape-design.md`.

## 12. Validation

After reshape, the following must pass:
- `npm run build` — main TypeScript build + canvas Vite build.
- `npx tsc --noEmit -p tsconfig.json` — main process type check (no references to deleted modules).
- `npx tsc --noEmit -p src/renderer/canvas/tsconfig.json` — canvas renderer type check.
- Excalidraw unit tests (controller, safety gate, snapshot ring, session store, tools) — unchanged, still pass.
- Smoke: launch on Windows (and ideally mac/linux) → hotkey opens canvas → voice create a shape → propose/confirm → undo → autosave writes a `.excalidraw` file.
- `npm ls` shows no dangling imports of deleted deps.
