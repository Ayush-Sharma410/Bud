# Cartesia Realtime Voice Path

## Goal

Add a Cartesia-powered realtime voice path to Bud. Cartesia provides the low-latency speech-to-text (STT) and text-to-speech (TTS) layers over WebSocket. Bud keeps the reasoning layer and all existing tools (`windows`, `computerUse`, etc.) by running a streaming LLM call through the Vercel AI SDK and the existing `RealtimeToolBridge`.

This lives on the `experiment/cartesia-realtime` branch and is built side-by-side with the existing OpenAI WebRTC realtime path.

## Context

The current realtime implementation in `app/src/main/realtime/` is a single WebRTC peer connection to OpenAI's `gpt-realtime-2` model. That model handles audio input, transcription, reasoning, tool calling, and audio output in one round-trip.

Cartesia does not expose a single model that replaces `gpt-realtime-2`. Instead it exposes:

- `/stt/turns/websocket` — realtime STT with built-in turn detection.
- `/tts/websocket` — streaming TTS with contexts and continuations.
- `/agents/stream/{agentId}` — a hosted voice-agent WebSocket that brings its own LLM and tools.

To keep Bud's tools, we cannot use the hosted agent path as a black box. We use Cartesia only for audio I/O and keep the LLM + tool layer inside Bud.

## Architecture

```
Mic
  ↓
Renderer AudioWorklet (pcm_s16le, 16 kHz, ~100 ms chunks)
  ↓ IPC
Main: CartesiaSTTSession → Cartesia STT WebSocket (/stt/turns/websocket)
  ↓ turn.end transcript
CartesiaRealtimeVoiceManager
  ↓ streaming LLM call
Vercel AI SDK + RealtimeToolBridge + Bud tools
  ↓ text chunks
CartesiaTTSSession → Cartesia TTS WebSocket (/tts/websocket)
  ↓ audio chunks
Renderer Web Audio playback
```

The manager is intentionally separate from `RealtimeVoiceManager` so it can model Cartesia's two-WebSocket flow without emulating OpenAI's data-channel event surface.

## New Files

| File | Purpose |
| ---- | ------- |
| `app/src/main/realtime/cartesiaTypes.ts` | Shared types: config, state, STT/TTS events. |
| `app/src/main/realtime/CartesiaSTTSession.ts` | Manages STT WebSocket; emits turn events. |
| `app/src/main/realtime/CartesiaTTSSession.ts` | Manages TTS WebSocket; streams text, emits audio chunks. |
| `app/src/main/realtime/CartesiaRealtimeVoiceManager.ts` | Orchestrates STT → LLM → TTS, state, interruptions, tools. |
| `app/src/main/realtime/executeRealtimeCompletion.ts` | Reusable streaming LLM with tools, extracted from chat-panel logic. |
| `app/src/renderer/panel/cartesia-realtime.js` | Renderer-side mic capture, TTS playback, and IPC bridge. |

## State Machine

```
idle → listening        (turn.start)
listening → processing  (turn.end)
processing → responding (first LLM text chunk)
responding → idle       (TTS done + no pending tool calls)
responding → listening  (turn.start interruption)
any → muted             (user toggles mute)
any → fallback          (connection / LLM failure)
```

## Data Flow

1. **Start.** `CartesiaRealtimeVoiceManager.start()` opens the STT and TTS WebSockets and tells the renderer to begin mic capture.
2. **Audio input.** The renderer AudioWorklet produces `pcm_s16le` chunks at 16 kHz and sends them to main via IPC. `CartesiaSTTSession` forwards them as binary WebSocket messages.
3. **Speech start.** On `turn.start`, the manager sets state to `speech-detected`, cancels the active TTS context, stops renderer playback, and emits an `interruption` event.
4. **Speech end.** On `turn.end`, the manager receives the definitive transcript, sets state to `processing`, and starts `executeRealtimeCompletion` with the transcript as the latest user message.
5. **LLM streaming.** As text chunks arrive, the manager forwards them to `CartesiaTTSSession` with `continue: true` for intermediate chunks and `continue: false` for the final chunk. The manager also emits `realtime-response-chunk` to the panel.
6. **Tool calls.** When the LLM calls a tool, `executeRealtimeCompletion` pauses text streaming, `RealtimeToolBridge` executes the tool, the result is returned to the LLM, and streaming resumes.
7. **Audio output.** `CartesiaTTSSession` receives base64 audio chunks from Cartesia and forwards them to the renderer for Web Audio playback.
8. **Done.** When TTS finishes and no tool calls are pending, the manager returns to `idle` and emits `realtime-response-done`.

## Audio Formats

- **STT input:** `pcm_s16le`, 16 kHz, mono, sent in ~100 ms chunks.
- **TTS output:** `pcm_s16le` or `pcm_f32le`, 24 kHz, mono, raw base64 chunks. `pcm_s16le` is preferred to match the STT encoding and simplify renderer decoding.

## Interruption Handling

- The STT `turn.start` event is the earliest signal that the user has started speaking.
- On interruption:
  1. Cancel the current TTS context via Cartesia's cancel request.
  2. Stop renderer audio sources immediately.
  3. Discard any buffered but unplayed audio.
  4. Reset the LLM stream if possible; otherwise let it finish but do not forward new text to TTS.
  5. Emit `interruption` and transition to `listening`.

## Error Handling and Fallback

- **Reconnection:** Both STT and TTS sessions reconnect with exponential backoff (1 s, 2 s, 4 s) on transient failures.
- **Max retries:** After 3 failed attempts, the manager transitions to the `fallback` state and invokes the existing legacy pipeline.
- **Keepalive:** Send WebSocket ping frames every 60 s to avoid Cartesia's 180 s inactivity timeout.
- **LLM failure:** If `executeRealtimeCompletion` errors, the manager speaks a short error message via TTS and returns to `idle`.

## Tool Integration

`CartesiaRealtimeVoiceManager` registers the same `ToolExecutor[]` objects used by `RealtimeVoiceManager` and passes their definitions to `executeRealtimeCompletion`. Tool execution is asynchronous; the manager tracks pending tool calls and only returns to `idle` when the LLM stream is complete and all tool results have been consumed.

Image results from tools (e.g., `captureScreen`) are resized and injected back into the LLM conversation as user image messages, mirroring the behavior in `RealtimeVoiceManager`.

## Configuration

Environment variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `CARTESIA_API_KEY` | — | Server-side API key for Cartesia. |
| `CARTESIA_TTS_MODEL` | `sonic-3.5` | TTS model ID. |
| `CARTESIA_TTS_VOICE_ID` | — | Voice ID for TTS output. |
| `CARTESIA_STT_MODEL` | `ink-2` | STT model ID. |
| `CARTESIA_STT_SAMPLE_RATE` | `16000` | STT input sample rate. |
| `OPENAI_API_KEY` | — | LLM reasoning layer. |
| `OPENAI_MODEL` | `gpt-5.1` | LLM model for tool/reasoning calls. |

## UI Integration

`CartesiaRealtimeVoiceManager` emits the same channels that the panel and overlay already consume:

- `state-change` — `idle`, `listening`, `speech-detected`, `processing`, `responding`, `muted`, `fallback`.
- `realtime-transcript` — user transcript text.
- `realtime-response-chunk` — incremental assistant text.
- `realtime-response-text` — final assistant text.
- `realtime-response-done` — response complete.
- `realtime-tool-result` — tool call name and result.
- `mute-state` — muted boolean.

## Testing Plan

- **Unit:** Parse STT events (`turn.start`, `turn.update`, `turn.end`, `error`) and TTS events (`chunk`, `done`, `error`) correctly.
- **Manual:**
  1. Start Bud, enable Cartesia realtime path.
  2. Speak a simple command and confirm transcript + audio response.
  3. Interrupt during a response and confirm playback stops.
  4. Speak a command that uses the `windows` tool and confirm the tool executes.
  5. Disconnect network, confirm reconnection attempts, then fallback state.

## Open Questions

- Should the Cartesia path reuse the same message history as the chat panel, or maintain a separate realtime-only history? Decision: separate history for the experiment to avoid cross-contamination.
- Should `turn.update` events be shown in the UI as live captions? Decision: emit them as `realtime-transcript` updates for visual feedback, but only act on `turn.end`.
