# Bud Voice Pipeline — End-to-End

Mindmap of the full voice pipeline, start to finish, with the functions used at
each stage. Use this to navigate while debugging.

Files are under `app/src/main/` unless noted; renderer files are under
`app/src/renderer/panel/`.

Key state flags (all on `CartesiaRealtimeVoiceManager`) to watch while debugging:

- `isListening` — mic capture on/off (driven by `setListening`)
- `isResponseActive` — orchestrator turn in progress (`handleUserTurn` → `done` / interrupt)
- `isSpeaking` — TTS audio being delivered/played (`tts` event → `audio.done` / `flush.done`)
- `pendingToolCalls` — tools in flight
- `ttsContextId` / `ttsSentThisTurn` / `cancelledContextIds` / `lastInterruptedAt`

---

## 0. STARTUP (`main.ts`: `app.whenReady().then`)

- `session.defaultSession.setPermissionRequestHandler` / `setPermissionCheckHandler`
  → auto-grant `'media'` (mic) so `getUserMedia` works off-focus
- `TrayManager` / `ExcalidrawWindowManager` / `ExcalidrawController` / `SettingsManager`
- `new CartesiaRealtimeVoiceManager({ config, uiSink, systemPrompt })`
  - constructor → `setupOrchestratorEventHandlers()` + `setupSTTHandlers()` + `setupTTSHandlers()`
  - creates: `stt = CartesiaSTTSession`, `tts = CartesiaTTSSession`, `toolBridge = RealtimeToolBridge`, `orchestrator = OrchestratorAgent`
- `new OrchestratorAgent({ tools: {}, system })` ← `chatOrchestrator` (separate, text path)
- `new GlobalHotkey({ onCanvasToggle })` ← Electron `globalShortcut` (Ctrl+Shift+Space)
- `togglePanel()` → `new BrowserWindow(panelWindow)`
  - `backgroundThrottling: false`, `setAlwaysOnTop(true, 'screen-saver')`
  - `panelWindow.once('ready-to-show')` → `realtimeVoiceManager.start()`
    - `start()` → `stt.connect()` + `tts.connect()` (WS open; mic still OFF — idle by default)
- `new VoiceInputManager({ onEnterListening, onExitListening, onInterrupt, onModeChange })`
  - `start()` → `import uiohook-napi` → `uIOhook.on('keydown'/'keyup')` + `uIOhook.start()`
  - native GLOBAL keyboard hook — observe-only, never consumes keys

---

## 1. LISTENING ACTIVATION (`VoiceInputManager`) — the only thing that turns the mic ON

`onKeyDown(e)` / `onKeyUp(e)` → track `ctrlDown` / `altDown` / `otherKeys`

- **PTT** (hold Ctrl+Alt): `tryStartPtt()` → `setMode('ptt')` → `onEnterListening()`
- **Always-on** (Ctrl x3): `registerBareCtrlPress()` (≤1200ms window) → `enterAlwaysOn()` → `setMode('always-on')` → `onEnterListening()`
- **Escape**: `handleEscape()` → `setMode('idle')` → `onExitListening()`
  - Escape does **NOT** call `onInterrupt` — only exits listening

`onEnterListening` / `onExitListening` (in `main.ts`) → `realtimeVoiceManager.setListening(true/false)`

### `setListening(true)`

- `isListening = true`
- `emitToRenderer('cartesia-start-capture')` → panel renderer
- `stt.connect()` if needed
- `setVoiceState('listening')` → `uiSink.sendState` → `panelWindow.webContents.send('state-change')`

### `setListening(false)`

- `isListening = false`
- `emitToRenderer('cartesia-stop-capture')`
- `setVoiceState('idle')` (only if `!isResponseActive && !isSpeaking && !pendingToolCalls`)

---

## 2. MIC CAPTURE (renderer: `cartesia-realtime.js`)

`onCartesiaStartCapture` → `startCapture()`

- `ensureMic()` → `navigator.mediaDevices.getUserMedia({ echoCancellation, noiseSuppression, ... })`
- `captureCtx = new AudioContext({ sampleRate: 24000 })`; `captureCtx.resume()`
- `audioWorklet.addModule('realtime-worklet.js')` ← `RealtimePCMProcessor` (Float32 → PCM16, 20ms frames)
- `AudioWorkletNode` + `createMediaStreamSource(micStream)` → connect
- `worklet.port.onmessage` → `window.budAPI.sendRealtimePCM(base64)`

  → `preload.ts`: `sendRealtimePCM` → `ipcRenderer.send('realtime-pcm-chunk')`

  → `main.ts`: `ipcMain.on('realtime-pcm-chunk')` → `realtimeVoiceManager.handleAudioChunk(base64)`

  → `handleAudioChunk` → `if (!isListening) return; stt.sendAudioChunk(Buffer)`

---

## 3. STT (`CartesiaSTTSession` → `wss://api.cartesia.ai/stt/turns/websocket`)

`sendAudioChunk(pcm)` → `ws.send(pcm)` (raw PCM bytes)

Cartesia server → `ws 'message'` → `handleMessage(data)` → `JSON.parse` → `switch(event.type)`:

- `turn.start` → `emit('turn.start')`
- `turn.update` → `emit('turn.update', { transcript })` ← partial (live UI)
- `turn.eager_end` → `emit('turn.eager_end')` ← (NOT handled — preliminary)
- `turn.resume` → `emit('turn.resume')` ← (NOT handled)
- `turn.end` → `emit('turn.end', { transcript })` ← FINAL
- `error` → `emit('error')`

### `VoiceManager.setupSTTHandlers()`

- `turn.start` → `setVoiceState('speech-detected')`
  - **INTERRUPT GATE:** `if (isSpeaking || pendingToolCalls > 0)` → `handleInterruption()`
  - NOT `isResponseActive`! A stray `turn.start` ~400ms after `turn.end` won't abort a fresh preamble that hasn't spoken yet.
- `turn.update` → `emitToUI('realtime-transcript', partial)`
- `turn.end` → `setVoiceState('processing')` + `handleUserTurn(transcript)`

---

## 4. ORCHESTRATOR (`handleUserTurn` → `OrchestratorAgent.run`)

### `handleUserTurn(transcript)`

- guards: `if (!isListening) return;` `if (isResponseActive) return;` ← drops stale/duplicate turns
- `isResponseActive = true; isSpeaking = false; ttsSentThisTurn = false`
- `cancelledContextIds.clear()`
- `ttsContextId = tts.startContext()` ← just generates a UUID, no WS msg
- `turnAbortController = new AbortController()`
- `await orchestrator.run({ request: transcript, signal })`

### `OrchestratorAgent.run()` — two-model split (preamble first, then complex)

- `history.push({ role: 'user' })`; `trimHistory()`

**PREAMBLE** (fast model, e.g. gpt-5-nano): `streamText({ model: openai(preambleModel), preambleSystem })`

- `for await chunk of textStream` → match `<REPLY>` / `<ACK>` / `<PASS>`
- `preambleDecision` resolved ASAP

- if **REPLY**: `eventBus.emit('text', text); emit('tts', text); emit('done'); return` ← mini answers, no tools
- if **ACK**: `eventBus.emit('tts', ack.slice(0, 60))` ← spoken while complex works
- if **PASS**: (nothing spoken yet, go straight to complex)

**COMPLEX** (main model, tools): `streamText({ model, tools, toolChoice: 'auto', stopWhen: stepCountIs(maxSteps), onStepFinish, abortSignal })`

- `onStepFinish({ toolCalls, toolResults, text })`:
  - for `tc` → `eventBus.emit('toolCall', { id, name, input })`; `toolCallMap.set(id, name)`
  - for `tr` → `enrichToolResult(name, output)` → `emit('toolResult', { id, success, result })`
- `for await chunk of result.textStream`:
  - `eventBus.emit('text', chunk)` ← UI
  - `eventBus.emit('tts', chunk)` ← spoken (streamed, every token)
- `finalText = await result.text`; `response = await result.response`
- `history.push(response.messages)`; `trimHistory()`
- `eventBus.emit('done', { finalText })`

---

## 5. ORCHESTRATOR EVENTS → VoiceManager (`setupOrchestratorEventHandlers`)

- `bus.on('text', chunk)` → `responseTextBuffer += chunk`; `emitToUI('realtime-response-chunk')`
- `bus.on('tts', text)` → `ttsSentThisTurn = true; isSpeaking = true`; `setVoiceState('responding')`; `tts.sendText(text, ttsContextId, isContinuation=TRUE)` ← streaming, context stays open
- `bus.on('toolCall')` → `pendingToolCalls++; setVoiceState('processing'); emitToUI('realtime-tool-call')`
- `bus.on('toolResult')` → `pendingToolCalls--; emitToUI('realtime-tool-result')`
- `bus.on('toolRetry')` → `emitToUI('realtime-tool-retry')`
- `bus.on('done', { finalText })` → `isResponseActive = false`
  - if `ttsContextId && ttsSentThisTurn` → `tts.flushContext()` (`isSpeaking` stays TRUE until `audio.done`)
  - else → `isSpeaking = false; setVoiceState('idle')`
  - `emitToUI('realtime-response-text' / '-done')`
- `bus.on('error')` → `isResponseActive = false; speakError('Sorry, I had trouble...')`

---

## 6. TOOLS (registered once at startup)

`registerTools(executors)` → `buildVercelTools()` (`tool()` + `jsonSchema()` per executor) → `OrchestratorAgent.wrapToolsWithRetry(tools, bus, 3)` → `orchestrator.setTools(wrapped)`

Tool executors:

- `searchWeb`
- `memory` (`createMemoryTool` — better-sqlite3; save/get/search)
- `spawnAgent` (`createSpawnAgentTool` — background worker, own `OrchestratorAgent` loop, `searchWeb` + `memory` only)
- `excalidraw` (`createExcalidrawTools` — 6 sub-tools via `ExcalidrawController` → preload/IPC → canvas window)

Wrap: `executeWithRetry()` + `RetryToolExecutor` + `isTransientError` → `enrichToolResult()` (`ToolResultEnricher`, pure normalizer)

---

## 7. TTS (`CartesiaTTSSession` → `wss://api.cartesia.ai/tts/websocket`)

- `startContext()` → `currentContextId = randomUUID()` (no WS msg)
- `sendText(text, contextId, isContinuation)`:
  - `ws.send(CartesiaGenerationRequest { model_id, transcript, voice: { mode: 'id', id }, output_format, context_id, continue, max_buffer_delay_ms })`
  - `isContinuation = TRUE` → `continue: true`, `max_buffer_delay_ms: 3000` (buffer + stream)
  - `isContinuation = FALSE` → `continue: false`, `max_buffer_delay_ms: 0` (finalize; used by `speakError`)
- `flushContext(contextId)` → `ws.send({ ...transcript: '', continue: false, flush: true })`
- `cancelContext(contextId)` → `ws.send({ context_id, cancel: true })`

`handleMessage` → `switch(event.type)`:

- `chunk` → `emit('audio.delta', { contextId, base64Audio, done })`; if `done` → `emit('audio.done')`
- `flush_done` → `emit('flush.done', event)`
- `done` → `emit('audio.done', { contextId })`
- `error` → `emit('error', event)` ← raw event carries `context_id`

### `VoiceManager.setupTTSHandlers()`

- `audio.delta` → drop if `cancelledContextIds.has(ctx)`; else `emitToRenderer('cartesia-tts-audio', { ... })`
- `audio.done` → `isSpeaking = false`; `if (!isResponseActive && !pendingToolCalls)` → idle
- `flush.done` → same as `audio.done`
- `error` → suppress if `cancelledContextIds.has(ctx)` OR `Date.now() - lastInterruptedAt < 1500`

---

## 8. AUDIO PLAYBACK (renderer: `cartesia-realtime.js`) — SEPARATE AudioContext

`onCartesiaTTSAudio` → `handleAudioEvent` → `playAudioChunk(base64Audio, contextId)`

- drop if `contextId === stoppedContextId` (interrupted context's late chunks)
- new context → clear `stoppedContextId`, reset `pendingChunks` / queue
- `playbackCtx` (≠ `captureCtx`!); `playbackCtx.resume()` if suspended
- base64 → Int16 → `AudioBuffer` (`createBuffer`); `createBufferSource` → `connect(destination)`
- `source.start(max(nextStartTime, currentTime))`; push to `activeSources`

`onCartesiaTTSStop` → `stopPlayback()`: `activeSources.forEach(s.stop())`; clear queue; `stoppedContextId = activeContextId`

---

## 9. INTERRUPTION (`handleInterruption`) — fires from `turn.start` when `isSpeaking` / `pendingToolCalls`

- `isResponseActive = false; isSpeaking = false; lastInterruptedAt = Date.now()`
- `turnAbortController.abort()` → `OrchestratorAgent.run` catches `AbortError` → `emit('done', { finalText: '' })`
- `cancelledContextIds.add(ttsContextId); tts.cancelContext(ttsContextId); ttsContextId = null`
- `emitToRenderer('cartesia-tts-stop')` → renderer `stopPlayback()`
- `emitToUI('interruption')` → panel clears chat buffer + `cartesiaRealtime.stopPlayback()`

---

## 10. UI (`panelWindow` webContents ← `uiSink` / `sendToPanel`)

- `uiSink.sendState(state)` → `'state-change'` → preload `onStateChange` → panel `setState()`
- `sendToUI(channel, data)` → e.g. `'realtime-transcript'`, `'realtime-tool-call'`, `'cartesia-tts-audio'`, ...
- `preload.ts` exposes `window.budAPI` (`contextBridge`) — the ONLY bridge renderer ↔ main
- `index.html` panel: `setState` / `setMode`, wave anim, chat body, task pills, settings

---

## Most common things that go wrong (and where to look)

1. **Response gets aborted before speaking** → `turn.start` interrupt gate in `setupSTTHandlers`.
   Remember it's `isSpeaking || pendingToolCalls > 0`, **not** `isResponseActive`.
2. **TTS errors / no audio** → `sendText` continue flag + `flushContext` / `cancelContext` in
   `setupTTSHandlers` + the renderer's `captureCtx` vs `playbackCtx` split in `cartesia-realtime.js`.
3. **Hotkeys feel non-global** → `backgroundThrottling` on the panel window + media permission
   handler in `main.ts`; the keyboard hook itself (`uiohook-napi`) is system-wide. Elevated
   (Run-as-admin) target apps can't be hooked by a non-elevated process (Windows UIPI).
4. **Transcript captured but dropped** → `handleUserTurn` guards (`!isListening` or
   `isResponseActive`) — check whether `turn.end` actually fired and whether a response was
   already active.
