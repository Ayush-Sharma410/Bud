# Bud

A Windows desktop companion that lets a user control and interact with their computer through voice commands. Forked from the macOS app Clicky, rebuilt from scratch for Windows using Electron.

## Language

**Bud**:
The Windows desktop companion app. A system tray and floating top-bar application that listens to the user's voice, sees their screen, responds with spoken answers, and provides a text-based chat agent. Can point at UI elements on screen.
_Avoid_: Clicky, assistant, agent

**Floating Pill**:
The collapsed, always-on-top, minimal black bar located at the top-center of the screen. Indicates the active mode (listening, speaking, muted, or fallback) and expands into the Chat Agent Panel when clicked.
_Avoid_: status bar, system island, floating notch

**Chat Agent Panel**:
The expanded view of the Floating Pill that provides a text chat interface, file drag-and-drop, and triggers tool-based tasks using the Vercel AI SDK.
_Avoid_: settings window, control panel, chat window

**Realtime Voice Pipeline**:
The primary voice path powered by `gpt-realtime-2`, OpenAI's state-of-the-art reasoning voice model. A WebRTC peer connection from the Electron renderer (Chromium) to the OpenAI Realtime API that handles speech understanding, internal reasoning, function calling, streaming audio responses, and interruptions in a single round-trip. Replaces the old STT → GPT → TTS chain. Audio is captured natively by WebRTC via `getUserMedia` — no temporary files, no ffmpeg, no manual PCM encoding, no separate STT or TTS requests. The model reasons internally before speaking or calling tools, enabling better instruction following and more precise tool use.
_Avoid_: realtime mode, voice engine, speech pipeline

**Realtime Session**:
The WebRTC connection to the OpenAI Realtime API. The peer connection lives in the renderer process; the main process coordinates via IPC. An embedded HTTP server on localhost handles SDP exchange. Maintains server-side conversation state, handles session lifecycle, data channel events, and reconnection with exponential backoff. Disconnects after 5 minutes of inactivity and reconnects on next speech detection.
_Avoid_: websocket, connection, socket

**Realtime Tool Bridge**:
The adapter layer that translates OpenAI Realtime function call events into existing Bud tool executions. Forwards calls to the same tool implementations used by the Chat Agent Panel — does not duplicate business logic. All tool calls are async; the Realtime session never blocks waiting for results.
_Avoid_: tool adapter, function mapper

**Realtime Voice Manager**:
The orchestrator that owns the Realtime Session, tool registration, and reconnection logic. Audio capture and playback are handled natively by WebRTC in the renderer — no manual audio transport needed. This is the new primary voice entrypoint.
_Avoid_: voice controller, audio manager

**Always-On Listening**:
Bud's default listening mode. The WebRTC peer connection streams audio continuously to the Realtime Session. Bud responds to all detected speech. The user can mute via Ctrl+Alt+M or the tray menu. The Floating Pill shows real-time state: gray (idle), red border (speech detected), blue (responding), red (muted), yellow (fallback).
_Avoid_: always listening, wake word, hotword

**Mute Toggle**:
The global hotkey (Ctrl+Alt+M) that toggles the microphone on and off. When muted, audio is not streamed to the Realtime Session and the Floating Pill shows a red border with "Muted" label.
_Avoid_: mute button, mic toggle

**Voice Provider**:
(Deprecated / Legacy) A pluggable backend that handled the full voice loop via STT → GPT → TTS. Two implementations existed: Modal (open-source models on GPU) and Local (Ollama on the user's machine). Now replaced by the Realtime Voice Pipeline. The old code is preserved but unused.
_Avoid_: voice mode, speech engine

**Vision Provider**:
The backend that analyzes screenshots of the user's screen and generates context-aware responses. Runs an open-source VLM on Modal via vLLM with an OpenAI-compatible API.
_Avoid_: screen reader, image analyzer

**Interaction**:
A single voice exchange: Bud is always listening, detects speech via server-side VAD, processes the utterance through the Realtime Voice Pipeline, and speaks the response back. Supports interruptions — the user can speak at any time to cut Bud off.
_Avoid_: session, conversation, request

**Element Pointing**:
The ability for Bud's cursor overlay to fly to and visually highlight a specific UI element on screen, guided by coordinates returned from the Vision Provider.
_Avoid_: cursor animation, pointing mode

**Companion Overlay**:
The transparent, always-on-top window that displays Bud's cursor, response text, and waveform animations. Non-interactive — it never steals focus from the user's active window.
_Avoid_: overlay window, cursor window, HUD

**Push-to-Talk Hotkey**:
(Legacy) The global keyboard shortcut (Ctrl+Alt) that was used to start and stop voice recording in the old pipeline. Still functional as a fallback but no longer the primary interaction mode — Bud now uses Always-On Listening.
_Avoid_: keyboard shortcut, hotkey, shortcut

## Computer Use

**Computer Use**:
Bud's ability to autonomously control the user's Windows desktop — moving the mouse, clicking, typing, and pressing keys — to complete tasks the user requests via voice.
_Avoid_: automation, computer control, RPA

**Agent Task**:
A single unit of autonomous computer use work. Created when the user issues a voice command that requires desktop control. Runs an Agent Loop until complete or aborted. Multiple Agent Tasks can exist concurrently.
_Avoid_: job, workflow, macro

**Task Plan**:
(Deprecated / Not used) The agent determines actions dynamically step-by-step rather than compiling an upfront structured plan.
_Avoid_: script, runbook, recipe

**Agent Loop**:
The repeating cycle that executes actions reactively: capture screenshot → send to VLM with current context and action history → VLM returns the next single action → execute via Action Executor → repeat. Includes built-in verification — the VLM checks if the previous action succeeded before deciding the next one.
_Avoid_: execution loop, control loop, CUA loop

**Action Executor**:
The local module that translates VLM action tags into physical input events on Windows via nut-js. Supports click, double-click, right-click, type, press, scroll, wait, launch, and done.
_Avoid_: robot, input simulator, macro engine

**Action Queue**:
A serialized queue that ensures only one Agent Task actuates (moves the mouse / types) at a time, even when multiple Agent Tasks are running concurrently. Agents can plan and reason in parallel, but physical actions are sequential.
_Avoid_: mutex, lock, semaphore

## Architecture

**Realtime Pipeline (Primary)**:
Microphone `getUserMedia` → WebRTC peer connection (renderer) → OpenAI Realtime API (`gpt-realtime-2` with reasoning) → native WebRTC audio playback. The `gpt-realtime-2` model handles speech understanding, internal reasoning (configurable effort: low/medium/high), function calling, and audio generation in a single pass. Tool calls are routed through the Realtime Tool Bridge to existing Bud tools. All tools execute asynchronously; results are injected back into the Realtime Session for natural follow-up speech. Echo prevention uses browser AEC + Realtime interruption events. Semantic VAD detects speech end for natural turn-taking.

**Legacy Pipeline (Fallback)**:
Push-to-Talk → AudioRecorder → ffmpeg WebM→WAV → STT → executeChatCompletion() → Tool Calls → GPT response → TTS → Playback. Preserved as silent fallback when the Realtime WebRTC connection fails after 3 reconnection attempts. Activated automatically without user intervention.

**Echo Prevention**:
Browser-level acoustic echo cancellation (echoCancellation: true in getUserMedia) combined with Realtime interruption events. When the user speaks during Bud's response, the Realtime Session fires a speech_started event, Bud stops playback immediately, and processes the new utterance. The microphone is never muted during playback.

**Reconnection Strategy**:
Auto-reconnect with exponential backoff (1s, 2s, 4s) for transient WebRTC failures. After 3 failed attempts, silently falls back to the Legacy Pipeline. Visual indicator on the Floating Pill shows fallback state (yellow border). Auto-switches back to Realtime when the connection is restored.
