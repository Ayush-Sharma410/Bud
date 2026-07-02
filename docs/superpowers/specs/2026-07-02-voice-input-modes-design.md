# Voice Input Modes Design

**Date:** 2026-07-02
**Status:** Approved
**Scope:** Replace Bud's always-on voice listener with two explicit input modes — **push-to-talk** (hold Ctrl+Alt) and **always-on** (Ctrl ×3 to enter, Escape to exit) — backed by a native global keyboard hook. Retire the mute hotkey. Default to idle (mic off). Main-process + renderer capture + pill UI changes.

## 1. Goal

Today Bud's mic is always capturing once the panel loads (`CartesiaRealtimeVoiceManager.start()` connects STT and emits `cartesia-start-capture`; the renderer runs `getUserMedia` continuously and forwards PCM unless muted). This spec replaces that single "always-on" behaviour with two deliberate, user-driven modes plus an idle default:

1. **Push-to-talk (PTT)** — hold **Ctrl+Alt** to listen; release to stop.
2. **Always-on** — press **Ctrl three times** to listen continuously; press **Escape** to exit.

Startup defaults to **idle** (mic released, OS indicator off). The mute hotkey (`Ctrl+Alt+M`) is retired — the two modes supersede it.

This requires global press **and** release tracking and bare-modifier detection, which Electron's `globalShortcut` cannot provide (it fires key-down only and cannot register lone modifiers). We therefore re-introduce a native keyboard hook (`uiohook-napi`), a deliberate departure from the "no native input automation" stance recorded in `CONTEXT.md` and the 2026-06-30 reshape spec (which had dropped `uiohook-napi`).

## 2. Non-Goals

- **No "remember last mode".** Startup is always idle.
- **No settings UI for remapping the new mode keys.** Keys are hardcoded in `VoiceInputManager` (YAGNI; can add later).
- **No migration of the canvas-toggle hotkey** (`Ctrl+Shift+Space`) — it stays on Electron `globalShortcut`; it works fine for a simple combo.
- **No reconnect-per-PTT.** STT/TTS WebSockets stay connected across mode switches; only the PCM flow is gated.
- **No always-on ↔ PTT overlap.** While always-on is active, holding Ctrl+Alt is a no-op.
- **No test framework added now.** Verification is `npm run typecheck` + a manual smoke matrix. Pure state-machine logic is extracted to be unit-testable if a runner is added later.

## 3. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Input tracking | `uiohook-napi` native global hook | Only way to get system-wide press + release + bare-modifier detection; cross-platform (win/mac/linux), Node-API, rebuilt via existing `electron-builder install-app-deps` postinstall |
| Default startup mode | `idle` (mic off) | User-confirmed; privacy-priority — OS mic indicator off when not listening |
| PTT gesture | Hold Ctrl+Alt, no other non-modifier key held | Avoids false triggers from `Ctrl+Alt+←` (screen rotate), `Ctrl+Alt+Del`, etc. |
| Always-on entry | Bare Ctrl ×3 within 1.2s rolling window | Bare presses only (press+release with no intervening non-modifier key) so `Ctrl+C`/`Ctrl+V` don't accumulate |
| Always-on exit | Escape | User-specified; also interrupts any in-progress response |
| Escape scope | Acts only while actively listening (ptt or always-on) | uiohook is observe-only (never consumes), so Escape still reaches other apps when Bud is idle |
| Mic at idle | Released (`track.stop()`, null stream) | Preserves privacy / indicator-off; first PTT after idle has ~150–300ms device-init latency, softened by pre-warm on second-modifier-down |
| STT/TTS across modes | Stay connected; PCM flow gated | No reconnect-per-PTT latency |
| Old mute hotkey | Retired entirely | Superseded by the two modes; avoids Ctrl+Alt conflict with PTT |
| Code structure | Approach A — new `VoiceInputManager` (native hook) + slim `GlobalHotkey` (canvas toggle only) | Clean separation; native hook only where `globalShortcut` can't do the job |
| Mode keys configurable | No (hardcoded) | YAGNI |
| Pill feedback | New `voice-mode` channel (idle/ptt/always-on) + existing activity states overlay | User must see which mode is active |

## 4. Voice Modes (state model)

Mutually exclusive voice states driven by `VoiceInputManager`:

| Mode | Mic | Entered by | Exited by |
|------|-----|-----------|-----------|
| `idle` (default at startup) | off (tracks stopped, indicator off) | — | — |
| `ptt` | on, forwarding to STT | hold Ctrl+Alt (both down, no non-modifier key held) | release either modifier, or press a non-modifier key mid-hold |
| `always-on` | on, forwarding to STT continuously | bare Ctrl ×3 within 1.2s | Escape |

Rules:
- `ptt` and `always-on` never coexist. While in `always-on`, holding Ctrl+Alt is a **no-op**.
- Ctrl ×3 while in `ptt` is **ignored** (no mode switch mid-PTT).
- Escape acts in **any active-listening mode** (ptt or always-on): exit to `idle` + interrupt in-progress response + stop capture. When idle, Escape is ignored.

## 5. Key Detection (uiohook-napi, observe-only)

`uiohook-napi` reports global keydown/keyup for every key without consuming them, so other apps are unaffected.

- **PTT (Ctrl+Alt hold):** track modifier state. Enter `ptt` when both Control and Alt are down **and no non-modifier key is currently held**. Exit when either modifier releases, or when any non-modifier key presses mid-hold (treated as a shortcut, not talk).
- **Pre-warm:** when the *second* modifier of the Ctrl+Alt pair begins to depress (one already held + the other goes down), signal the renderer to start mic capture so the stream is warm by the time both are held. Pre-warming on the *first* modifier alone is intentionally avoided — bare `Ctrl` is pressed constantly (browser clicks, etc.) and would flash the mic on for every press. If the second modifier never arrives (e.g. a `Ctrl+Alt+X` shortcut where X lands first), any pre-warmed capture is torn down immediately without entering `ptt`.
- **Ctrl ×3:** count bare Control keydowns — each must be a clean press+release with **no intervening non-modifier keydown** (so `Ctrl+C`/`Ctrl+V` don't count). 3 within a 1.2s rolling window → enter `always-on`. Left or right Ctrl both count. If already `always-on`, ×3 is a no-op.
- **Escape:** when in `ptt` or `always-on` → exit to `idle` + interrupt + stop capture. When `idle`, ignored.

## 6. Mic Capture Lifecycle

- **Idle → mic released:** renderer stops mic tracks (`track.stop()`), nulls `micStream` → OS mic indicator off. *(New behaviour — current `stopCapture()` tears down the worklet/AudioContext but never releases tracks, so the indicator stays on.)*
- **Entering ptt/always-on → capture starts** (`getUserMedia` + worklet), PCM flows to STT.
- **Returning to idle → capture stops + tracks released.**
- **STT/TTS WebSockets stay connected** across mode switches; only PCM flow is gated. Existing STT reconnect logic handles any idle timeouts.

The current `isMuted` gate (`cartesia-realtime.js:85`, `CartesiaRealtimeVoiceManager.ts:366`) becomes an `isListening` gate; the `toggleMute`/mute plumbing is removed.

**Trade-off:** releasing the mic device each idle means the first PTT after idle has ~150–300ms device-init latency (pre-warm softens this). The alternative — keep `micStream` warm at idle — gives instant PTT but leaves the OS mic indicator on, contradicting "idle by default". Privacy option chosen.

## 7. Architecture

### 7.1 High-Level Flow

```
uiohook-napi (global keydown/keyup)
   → VoiceInputManager (state machine: idle / ptt / always-on)
        → enterListening()  → CartesiaRealtimeVoiceManager.setListening(true)
                              → emit 'cartesia-start-capture' → renderer startCapture()
        → exitListening()   → setListening(false)
                              → emit 'cartesia-stop-capture'  → renderer stopCapture() + releaseMic()
        → interrupt()       → CartesiaRealtimeVoiceManager.interrupt()  (Escape path)

renderer PCM ─► handleAudioChunk (gated on isListening) ─► CartesiaSTTSession
   STT turn.end ─► OrchestratorAgent ─► text ─► CartesiaTTSSession ─► renderer playback

GlobalHotkey (Electron globalShortcut) ─► canvas toggle only (Ctrl+Shift+Space)
```

### 7.2 New component — `VoiceInputManager` (`src/main/voiceInputManager.ts`)

Owns the native hook + the 3-mode state machine. Pure core extracted as testable functions:

```
VoiceInputManager
  ├── uiohook-napi: start(), hook global keydown/keyup
  ├── modifierState: { ctrl, alt, otherKeyHeld }        // pure tracker
  ├── ctrlTripletCounter: bare-ctrl presses / 1.2s window // pure counter
  ├── mode: 'idle' | 'ptt' | 'always-on'
  └── delegates to voiceManager:
        enterListening() / exitListening() / interrupt()
```

- `enterListening()` → `voiceManager.setListening(true)` (renderer `cartesia-start-capture`; STT already connected).
- `exitListening()` → `voiceManager.setListening(false)` (renderer `cartesia-stop-capture`; STT stays connected).
- `interrupt()` → `voiceManager.interrupt()` (public expose of the existing private `handleInterruption`).
- Emits `voice-mode` to the pill via `UISink` on every mode change.

### 7.3 Changes to `CartesiaRealtimeVoiceManager`

- `isMuted` / `toggleMute` / `getMuted` → `isListening` / `setListening(bool)` / `getListening()`.
- `handleAudioChunk` gates on `isListening` instead of `isMuted` (`:366`).
- `start()` connects STT/TTS but **no longer** emits `cartesia-start-capture` unconditionally — capture is now driven by `setListening`. Connection stays up; PCM flow gated.
- New public `interrupt()` wrapping the existing private `handleInterruption()` (`:258`).
- Remove the `setVoiceState('muted')` path and the `mute-state` UI emit from `toggleMute`.

### 7.4 Renderer changes (`src/renderer/panel/cartesia-realtime.js`)

- `stopCapture()` enhanced: also `track.stop()` all mic tracks + null `micStream` (full device release → indicator off). New `releaseMic()` helper.
- `setMuted` removed; listening is driven purely by existing `startCapture`/`stopCapture` (already wired to `cartesia-start/stop-capture`).
- Pre-warm: reuse `startCapture()` on second-modifier-down (one of Ctrl/Alt already held); tear down immediately if PTT never engages. Idempotent via the `isCapturing` guard.

### 7.5 Changes to `GlobalHotkey` + `main.ts` + `settings.ts`

- **`GlobalHotkey`** — drop `onMuteToggle`, `muteToggleAccelerator`, its registration, and the `canvasToggleAccelerator`/`onCanvasToggle` paths remain. Canvas toggle stays on Electron `globalShortcut`.
- **`main.ts`** — instantiate `VoiceInputManager` after the voice manager; wire `enterListening`/`exitListening`/`interrupt`. Remove mute wiring (`:225`–`:233`), the `toggle-realtime-mute` IPC handler (`:533`), and the `muted` field in `get-realtime-state` (`:540`). The unconditional `start-realtime-capture` send on panel ready (`:310`) is removed — capture is now mode-driven.
- **`settings.ts`** — remove `muteHotkey` from `AppSettings` + `defaults()` (`:39`, `:75`). Old values in `settings.json` are harmlessly ignored on load. New mode keys are hardcoded in `VoiceInputManager`.

### 7.6 Pill UI (`src/renderer/panel/index.html`)

- New `voice-mode` IPC channel: `idle` | `ptt` | `always-on`. Pill renders a small mode badge/label.
- When a mode is active and STT hears speech, the existing activity states (`speech-detected` / `processing` / `responding`) overlay as today.
- Remove the `state-muted` style (`:126`), the `'muted'` label/color entries (`:1132` / `:1138`), and the `onMuteStateChange` handler (`:1513`). `idle` renders dim/off.

## 8. Edge Cases & Error Handling

- **uiohook fails to load/start** → log warning, voice modes disabled, pill shows `fallback`; canvas toggle (`globalShortcut`) still works.
- **Mic permission denied** → stay `idle`, pill `fallback`.
- **Ctrl ×3 while in `ptt`** → ignored.
- **Escape while `ptt`** → exits to `idle` + interrupts (Escape acts in any active-listening mode).
- **Rapid PTT spam** → STT stays connected; `setListening` re-entrancy guarded.
- **Panel hidden** → native hook is global; modes work regardless of panel visibility.
- **False-trigger avoidance** — `Ctrl+C`/`Ctrl+V` (single bare-ish ctrl press with a non-modifier) do not count toward ×3; `Ctrl+Alt+←` does not trigger PTT (non-modifier key held).

## 9. Dependency & Build Impact

- **Add** `uiohook-napi` to `dependencies`. Native module; rebuilt per-platform by the existing `postinstall: electron-builder install-app-deps` (`package.json:13`) alongside `better-sqlite3`.
- `CONTEXT.md` note: the "No platform-specific input automation / no native hook library" line is superseded for the voice-input path — `uiohook-napi` is re-introduced deliberately. The rest of the cross-platform stance (tray, hotkey, overlay) is unchanged.

## 10. Testing

No test runner in the repo (`package.json` has only `typecheck`). Verification:

- **`npm run typecheck`** — no references to removed mute plumbing; new module compiles.
- **Manual smoke matrix:**
  - idle startup → OS mic indicator off.
  - hold Ctrl+Alt → listens (indicator on) → release → idle (off).
  - Ctrl×3 → always-on (listens) → Escape mid-speech → idle + response cut off.
  - `Ctrl+C` / `Ctrl+V` do **not** trigger false always-on.
  - `Ctrl+Alt+←` does **not** trigger false PTT.
- **Recommend** extracting the pure state-machine + triplet-counter as separate functions so they're unit-testable if/when a runner (vitest) is added — not mandatory now.

## 11. File Plan

### New
- `app/src/main/voiceInputManager.ts` — native hook + state machine.

### Edited
- `app/src/main/realtime/CartesiaRealtimeVoiceManager.ts` — `isListening` gate, `setListening`, public `interrupt()`, drop mute path, `start()` no auto-capture.
- `app/src/main/globalHotkey.ts` — mute hotkey removed; canvas toggle only.
- `app/src/main/main.ts` — instantiate `VoiceInputManager`; remove mute wiring + `toggle-realtime-mute` + ready-to-show auto-capture.
- `app/src/main/settings.ts` — drop `muteHotkey`.
- `app/src/main/preload.ts` — add `voice-mode` listener; remove `onMuteStateChange` (or repurpose).
- `app/src/renderer/panel/cartesia-realtime.js` — `releaseMic()` in `stopCapture`; drop `setMuted`.
- `app/src/renderer/panel/index.html` — `voice-mode` badge; remove muted style/label/handler.
- `app/package.json` — add `uiohook-napi` dependency.
- `CONTEXT.md` — note `uiohook-napi` re-introduction for voice input.

### Removed (code paths, not files)
- `toggleMute` / `getMuted` / `mute-state` emit / `cartesia-mute` renderer path / `toggle-realtime-mute` IPC / `muteHotkey` setting.
