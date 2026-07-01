# Bud

An AI-native, cross-platform (Windows / macOS / Linux) Electron voice copilot for Excalidraw. Bud listens to the user's voice, sees the Excalidraw canvas, responds with spoken answers, and draws, edits, and organizes diagrams on the user's behalf. Forked from the macOS app Clicky, rebuilt from scratch.

## Language

**Bud**:
The desktop voice copilot app. A system tray and floating top-bar application that listens to the user's voice, reasons over the Excalidraw canvas, responds with spoken answers, and drives the canvas through tools. Runs on Windows, macOS, and Linux.
_Avoid_: Clicky, assistant, agent

**Excalidraw Canvas**:
The primary work surface — an embedded instance of the official `@excalidraw/excalidraw` React component running in a dedicated BrowserWindow. Bud reads its scene state and mutates it through the imperative Excalidraw API over a secure preload/IPC bridge. Self-hosted fonts and assets via `window.EXCALIDRAW_ASSET_PATH`.
_Avoid_: whiteboard, drawing board, canvas window

**Floating Pill**:
The collapsed, always-on-top, minimal black bar at the top-center of the screen. Indicates the active mode (listening, speaking, muted, fallback) and expands into the Chat Agent Panel when clicked.
_Avoid_: status bar, system island, floating notch

**Chat Agent Panel**:
The expanded view of the Floating Pill that provides a text chat interface, file drag-and-drop, and tool-based tasks using the Vercel AI SDK. Shares the same Orchestrator and tools as the voice path.
_Avoid_: settings window, control panel, chat window

**Voice Pipeline**:
The primary voice path: microphone capture → Cartesia streaming STT → Orchestrator (LLM reasoning + tool calls) → Cartesia streaming TTS → audio playback. A single, linear, request-response loop — no WebRTC, no server-side session, no stateful real-time connection. Replaces the former OpenAI Realtime pipeline.
_Avoid_: realtime pipeline, voice engine, speech pipeline

**Cartesia STT**:
Streaming speech-to-text over a WebSocket to Cartesia (`CartesiaSTTSession`). Transcribes the user's utterance in real time; the final transcript is handed to the Orchestrator.
_Avoid_: transcriber, speech recognizer

**Cartesia TTS**:
Streaming text-to-speech over a WebSocket to Cartesia (`CartesiaTTSSession`, Sonic models). Receives Orchestrator output token-by-token and plays audio back with low latency. Supports interruption — when the user starts speaking, playback stops immediately.
_Avoid_: synthesizer, voice output

**Orchestrator**:
The LLM reasoning core (`OrchestratorAgent`) that sits between STT and TTS. Receives the transcript (or chat message), holds conversation history, calls tools, streams a text response, and emits TTS markers. Two-model split: a fast preamble model for triage and a main model for reasoning. Wraps tool calls with retry via `RetryToolExecutor`.
_Avoid_: brain, controller, LLM router

**Tools**:
The four capabilities Bud exposes to the Orchestrator: `searchWeb`, `excalidraw` (a bundle of six canvas sub-tools), `memoryTool`, and `spawnAgent`. Tools are registered in `tools/index.ts` and execute asynchronously; results are enriched by `ToolResultEnricher` before being returned to the model.
_Avoid_: functions, plugins, actions

**Excalidraw Tools**:
The six canvas sub-tools bundled under the `excalidraw` tool: `create-element`, `update-element`, `delete-element`, `group-elements`, `read-scene`, and `apply-diff`. Each maps to an imperative API call on the embedded Excalidraw instance through the preload/IPC bridge.
_Avoid_: drawing commands, canvas actions

**Memory Tool**:
A persistent key-value memory backed by SQLite (`better-sqlite3`) that Bud uses to recall user preferences, past diagrams, and context across sessions. Exposed as `memory_save`, `memory_get`, and `memory_search`.
_Avoid_: notes, knowledge base

**Spawn Agent**:
An async background worker tool (`spawnAgent`, renamed from `spawnWorker`) that forks a constrained worker with its own LLM loop and a reduced toolset (`searchWeb` + `memory` only — it cannot reach the canvas). Used for long-running research or multi-step lookups that should not block the main conversation. Reports progress back to the Orchestrator via the worker event bus.
_Avoid_: worker, subprocess, background job

**Tray**:
The system tray icon and menu (`TrayManager`) that shows status, toggles mute, opens settings, and quits. Cross-platform via Electron's `Tray` API.
_Avoid_: system tray icon, menu bar item

**Global Hotkey**:
The global keyboard shortcut (default Ctrl+Alt+M / Cmd+Alt+M) that toggles the microphone on and off. Implemented via Electron's `globalShortcut` — no native hook library. When muted, audio is not captured and the Floating Pill shows a red border with "Muted".
_Avoid_: hotkey, shortcut, keyboard shortcut

**Mute Toggle**:
The act of toggling the microphone via the Global Hotkey or tray menu. When muted, the Floating Pill shows a red border with "Muted".
_Avoid_: mute button, mic toggle

**Settings**:
A self-contained settings model (`SettingsManager`) persisted to JSON. Holds only `model`, `muteHotkey`, and `excalidraw` config. Voice (Cartesia) and LLM credentials are read from environment variables, not settings.
_Avoid_: preferences, config panel

**Interaction**:
A single voice exchange: Bud detects speech end via STT, processes the utterance through the Orchestrator, and speaks the response back via TTS. The user can interrupt Bud mid-response by speaking — playback stops and the new utterance is processed.
_Avoid_: session, conversation, request

## Architecture

**Voice Loop**:
Microphone `getUserMedia` (renderer) → audio chunks streamed to main process → Cartesia STT WebSocket → final transcript → Orchestrator (`OrchestratorAgent`) reasons + calls tools → streams text response → Cartesia TTS WebSocket plays audio back. Interruption: when STT detects speech during TTS playback, playback is cancelled and the new utterance takes over.

**Excalidraw Embedding**:
The official `@excalidraw/excalidraw` React component is bundled by Vite (`vite.canvas.config.ts`) into static assets loaded by a dedicated BrowserWindow. A preload script (`canvasPreload.ts`) exposes a narrow, validated IPC API; the main-process `ExcalidrawController` calls through it to read scene state and apply mutations. Fonts and assets are self-hosted via `window.EXCALIDRAW_ASSET_PATH` — no CDN dependency.

**Tool Execution**:
All four tools implement a common async executor interface. The Orchestrator calls them via `ToolExecutor`; results pass through `ToolResultEnricher` (a pure normalizer — no image processing) before returning to the model. Spawn Agent workers run their own `OrchestratorAgent` loop with the reduced toolset and report progress over the worker event bus.

**Cross-Platform**:
Electron renderer + main process run identically on Windows, macOS, and Linux. The only platform-specific bits are the global hotkey default (Ctrl vs Cmd), tray icon format, and native module rebuild (`better-sqlite3`) handled by `electron-builder install-app-deps` on `postinstall`. No platform-specific input automation, screen capture, or overlay code remains.
