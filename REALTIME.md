# Bud Realtime Voice Migration Plan

## Objective

Migrate Bud from the current:

Push-To-Talk → AudioRecorder → STT → GPT → Tools → TTS → Playback

pipeline to a hybrid architecture based on OpenAI Realtime while preserving all existing desktop automation capabilities.

The goal is to achieve near-instant voice interactions (sub-2 second perceived latency) while keeping the current AgentManager, tool ecosystem, background workers, memory system, and computer-use functionality.

**Transport: WebRTC** — The Realtime session uses WebRTC (not WebSocket) for lower latency, native audio handling, and better performance in the Electron renderer (Chromium).

---

## Important Constraints

DO NOT rewrite the entire application.

DO NOT remove:

* AgentManager
* CompanionManager
* Background task bus
* Existing tool implementations
* Memory system
* ComputerUse system
* SpawnWorker architecture

The migration should be incremental.

We are introducing a new Realtime voice layer that sits on top of the existing orchestration layer.

---

# Existing Architecture

Current flow:

User Voice
→ AudioRecorder
→ ffmpeg WebM→WAV conversion
→ OpenAI STT
→ executeChatCompletion()
→ Tool Calls
→ GPT response
→ OpenAI TTS
→ Playback

Problems:

* Multiple network round trips
* Full transcript required before reasoning starts
* Full response required before TTS starts
* TTS blocks response completion
* Excessive latency for simple voice commands

---

# Target Architecture (WebRTC)

Realtime Voice Layer

User Voice
→ Renderer (Chromium) RTCPeerConnection
→ WebRTC Data Channel + Media Streams
→ OpenAI Realtime API

Realtime Session
├── Speech Understanding (server-side VAD)
├── Function Calling (via data channel)
├── Streaming Audio Responses (native WebRTC audio)
├── Interruptions (Realtime interruption events)
└── Turn Detection (semantic VAD)

↓

RealtimeToolBridge

↓

Existing Bud Tools

↓

AgentManager

↓

Background Workers

---

# Architecture Details

## WebRTC Flow

1. Main process starts embedded HTTP server (`RealtimeSDPServer`) on localhost
2. Renderer receives connect command via IPC with SDP endpoint URL
3. Renderer creates `RTCPeerConnection`, adds mic track, creates data channel
4. Renderer sends SDP offer to local HTTP server
5. Main process forwards offer + session config to OpenAI `/v1/realtime/calls`
6. OpenAI returns SDP answer, forwarded back to renderer
7. WebRTC connection established — audio flows natively, events via data channel

## Key Components

### RealtimeSDPServer.ts (Main Process)
- Embedded HTTP server on localhost
- Receives SDP offer from renderer
- Forwards to OpenAI with session config and API key
- Returns SDP answer to renderer

### RealtimeWebRTC.js (Renderer)
- `RTCPeerConnection` management
- Microphone capture via `getUserMedia`
- Data channel for Realtime events
- Native audio playback via `<audio>` element
- No manual PCM encoding/decoding needed

### RealtimeSession.ts (Main Process)
- Coordinates with renderer via IPC
- Receives server events from data channel (via IPC)
- Sends client events to data channel (via IPC)
- Handles reconnection, inactivity timeout

### RealtimeVoiceManager.ts (Main Process)
- Owns RealtimeSession
- Routes tool calls to RealtimeToolBridge
- Manages voice state
- Forwards events to UI

---

# Implementation Strategy

Implement in 3 phases.

---

# PHASE 1

Create Realtime Infrastructure (WebRTC)

Create:

src/main/realtime/

* RealtimeSDPServer.ts
* RealtimeSession.ts
* RealtimeToolBridge.ts
* RealtimeVoiceManager.ts
* realtimeTypes.ts

src/renderer/panel/

* realtime-webrtc.js

---

## RealtimeSDPServer.ts

Responsibilities:

* Embedded HTTP server on localhost
* Receive SDP offer from renderer
* Forward to OpenAI `/v1/realtime/calls` with session config
* Return SDP answer to renderer

---

## RealtimeSession.ts

Responsibilities:

* Coordinate WebRTC via IPC to renderer
* Receive server events from data channel
* Send client events to data channel
* Handle reconnects
* Handle interruptions

---

## RealtimeToolBridge.ts

Purpose:

Adapt Realtime function calls to existing Bud tools.

---

## RealtimeVoiceManager.ts

Responsibilities:

* Own RealtimeSession
* Register tools
* Route tool calls
* Manage voice state

---

# PHASE 2

Replace Voice Recording Path

Old AudioRecorder pipeline (kept as fallback):

MediaRecorder
→ WebM
→ ffmpeg
→ WAV
→ STT

New WebRTC pipeline (primary):

Microphone (renderer)
→ getUserMedia
→ RTCPeerConnection
→ WebRTC audio transport (native)

No temporary files, no ffmpeg, no STT requests, no manual PCM encoding.

---

# PHASE 3

Hybrid Routing

Use Realtime for:

* conversational requests
* Spotify commands
* window management
* memory retrieval
* notifications
* lightweight searches

Use AgentManager for:

* desktop automation
* browser automation
* multi-step workflows
* screen-based reasoning
* long-running tasks

---

# Tool Design Rules

Fast Tools:

* apps
* windows
* memory
* notify

Execute immediately.

---

Slow Tools:

* computerUse
* spawnWorker

Return quickly.

Assistant should say:

"I'll take care of that in the background."

Then launch AgentManager or worker task.

Do not block the conversation.

---

# Response Rules

Bud is a voice assistant.

Responses should:

* be concise
* be spoken-first
* usually under 15 words
* avoid long explanations
* prioritize action over narration

---

# Compatibility Requirements

The following systems must continue working:

* Existing chat panel
* Existing memory system
* Existing background task bus
* Existing AgentManager
* Existing tool implementations
* Existing overlay UI

The migration should add Realtime support without breaking current functionality.

---

# Deliverables

Phase 1:

* RealtimeSDPServer.ts
* RealtimeSession.ts (WebRTC via IPC)
* RealtimeToolBridge.ts
* RealtimeVoiceManager.ts
* realtime-webrtc.js (renderer)

Phase 2:

* WebRTC microphone capture in renderer
* Native audio playback via WebRTC
* SDP exchange via embedded HTTP server

Phase 3:

* Tool registration
* Tool execution bridge
* Hybrid routing logic
* Background task delegation
