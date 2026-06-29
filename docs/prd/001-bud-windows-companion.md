# PRD: Bud — Windows Desktop Voice Companion

## Problem Statement

A Windows user wants a desktop companion that lives in their system tray, listens to their voice via push-to-talk, sees their screen, and responds with spoken answers — including the ability to point at UI elements on screen. Today, this capability only exists as Clicky, a macOS-native app built on Apple frameworks and commercial AI APIs (Anthropic, ElevenLabs, AssemblyAI). There is no equivalent for Windows, and no version that runs on open-source AI models.

## Solution

Build Bud, a Windows Electron app that replicates Clicky's core experience using entirely open-source AI models hosted on Modal (serverless GPU). The app captures the user's voice via push-to-talk, transcribes it with Whisper, sends the transcript plus a screenshot to a vision-language model (Gemma 4 27B via vLLM), and speaks the response back using Chatterbox TTS. A transparent overlay displays a cursor companion that can fly to and point at UI elements referenced in the response. A local fallback path (Ollama + Piper TTS) is available for users who want zero third-party dependencies.

## User Stories

1. As a Windows user, I want to install Bud as a desktop app, so that I have an always-available voice companion without needing a browser.
2. As a user, I want Bud to appear in my system tray (not the taskbar), so that it stays out of the way until I need it.
3. As a user, I want to press a global hotkey (Ctrl+Alt) to start speaking, so that I can trigger Bud from any application without switching windows.
4. As a user, I want to release the hotkey to stop recording, so that Bud knows when I'm done speaking.
5. As a user, I want Bud to capture my screen(s) when I speak, so that it can see what I'm looking at and give context-aware answers.
6. As a user, I want Bud to transcribe my speech accurately, so that my questions are understood correctly.
7. As a user, I want Bud to analyze my screenshot alongside my question, so that it can reference specific things on my screen.
8. As a user, I want Bud to respond with natural spoken audio, so that I can listen to the answer without reading.
9. As a user, I want Bud to stream its response progressively, so that I see the answer building up rather than waiting for the full response.
10. As a user, I want Bud's cursor to fly to and point at specific UI elements on my screen, so that I can see exactly where Bud is referring to.
11. As a user, I want Bud to remember my previous questions within a session, so that I can have a continuous conversation without repeating context.
12. As a user, I want to see a visual indicator (waveform) while I'm speaking, so that I know Bud is listening.
13. As a user, I want to see a spinner while Bud is processing, so that I know it's working on my request.
14. As a multi-monitor user, I want Bud to capture all my screens and identify which one my cursor is on, so that it can reference elements on any monitor.
15. As a multi-monitor user, I want Bud's pointing cursor to fly to the correct monitor, so that it points at the right element even if it's on a secondary display.
16. As a user, I want to click the system tray icon to open a control panel, so that I can see Bud's status and configure settings.
17. As a user, I want to choose between different VLM models in the panel, so that I can balance quality and speed.
18. As a user, I want to toggle between Modal (cloud) and Ollama (local) providers, so that I can use Bud without an internet connection or third-party services.
19. As a user, I want to hide and show the companion cursor, so that I can declutter my screen when I don't need Bud visible.
20. As a user, I want the cursor to appear transiently only during interactions when it's hidden, so that I still see visual feedback during push-to-talk without the cursor always being on screen.
21. As a user who can't afford cloud GPU credits, I want to run Bud entirely locally with Ollama and Piper TTS, so that I pay nothing beyond my own hardware.
22. As a first-time user, I want a setup wizard that walks me through permissions and provider configuration, so that I can get Bud running without reading documentation.
23. As a user, I want Bud to request only necessary permissions (microphone, screen capture) and explain why each is needed, so that I trust the app with my system access.
24. As a user, I want Bud to launch on Windows startup, so that it's always available without manual launching.
25. As a user, I want to configure the push-to-talk hotkey, so that I can avoid conflicts with other applications.
26. As a user, I want to configure the Modal endpoint URLs in settings, so that I can point Bud at my own deployed services.
27. As a user, I want Bud to cancel an in-progress response when I press the hotkey again, so that I can interrupt and ask a new question.
28. As a user, I want Bud to stop TTS playback when I start a new interaction, so that the old response doesn't overlap with my new question.
29. As a user, I want the overlay to be fully transparent and click-through, so that it never interferes with my normal computer use.
30. As a user, I want a dark-themed, modern-looking control panel, so that Bud feels premium and polished.

## Implementation Decisions

### Application Shell
- **Electron with TypeScript.** Provides system tray, transparent windows, global shortcuts, screen capture, and audio recording — all required for Bud's feature set. (ADR 0001)
- **No dock/taskbar icon.** Bud lives entirely in the system tray, matching Clicky's menu-bar-only design.

### AI Backend
- **All open-source models on Modal.** No commercial AI APIs. Gemma 4 27B (VLM), Whisper Large v3 Turbo (STT), Chatterbox (TTS) — all deployed as Modal web endpoints with OpenAI-compatible APIs where applicable. (ADR 0002)
- **No Cloudflare Worker proxy.** Modal endpoints serve directly. The worker layer is eliminated entirely.
- **Pluggable provider pattern.** Three provider interfaces — `VisionProvider`, `STTProvider`, `TTSProvider` — with two implementations each (Modal and Local). The CompanionManager talks only to the interfaces, never to specific backends.

### Local Fallback
- **Ollama** for local LLM (with a vision model like LLaVA) and local Whisper.
- **Piper TTS** for local text-to-speech (CPU-only, no GPU required).
- **Windows Speech Recognition** as an additional STT fallback.

### Voice Pipeline
- Matches Clicky's architecture: push-to-talk → STT → VLM (with screenshot) → TTS → playback.
- Upload-based STT (not streaming): record audio during push-to-talk, send WAV on release.
- SSE streaming from VLM for progressive response display.
- State machine with four states: `idle`, `listening`, `processing`, `responding`.

### Screen Capture
- Electron's `desktopCapturer` or `screenshot-desktop` for multi-monitor JPEG capture.
- Each capture labeled with cursor position, pixel dimensions, and monitor index.
- App's own windows excluded from captures.

### Element Pointing
- VLM embeds `[POINT:x,y:label:screenN]` tags in responses (same format as Clicky's Claude prompts).
- Pointing parser extracts coordinates and maps from screenshot pixel space to display point space.
- Overlay animates the cursor along a bezier arc to the target element.

### Global Hotkey
- `uiohook-napi` for low-level keyboard hooks (modifier-only shortcuts like Ctrl+Alt).
- Press starts recording, release stops recording and triggers the pipeline.

### Overlay Window
- Transparent `BrowserWindow` spanning all monitors, always on top, click-through, never steals focus.
- Renders cursor, waveform, spinner, response text bubble, and pointing animation.

### Project Structure
- New `app/` directory for the Electron app, alongside the existing Swift code in `Bud/leanring-buddy/` as reference.
- Swift code deleted after port is complete.

## Testing Decisions

Good tests verify external behavior through the module's public interface, not internal implementation details. Tests should be stable across refactors — if the interface contract is maintained, tests should not break.

### Provider Interfaces
- Each provider (VisionProvider, STTProvider, TTSProvider) is tested against its interface with fixture data.
- Modal providers: integration tests that hit the deployed endpoints with known inputs and assert response structure.
- Local providers: unit tests with mocked Ollama/Piper responses.

### CompanionManager State Machine
- Test state transitions by injecting mock providers and asserting that the correct sequence of states is reached for each scenario (successful interaction, cancellation, error, re-trigger during response).
- No real AI calls — mock providers return canned responses.

### Pointing Parser
- Pure function unit tests. Input: response strings with various `[POINT:...]` tag formats. Output: parsed coordinates, labels, screen numbers. Direct port of Clicky's existing test cases (if any) plus edge cases.

### Screen Capture
- Unit test that capture returns valid JPEG data with correct metadata (dimensions, cursor screen flag) for mock display configurations.

### Modal Endpoint Health
- Smoke tests: each deployed service responds to `/health` with 200.
- End-to-end: send a test image + prompt to VLM, assert structured response. Send test audio to STT, assert transcript. Send test text to TTS, assert audio bytes.

## Out of Scope

- **macOS or Linux support.** Bud is Windows-only. No cross-platform abstractions.
- **GPT Realtime API integration.** Originally considered, explicitly dropped from scope.
- **Anthropic, ElevenLabs, or AssemblyAI integration.** Fully replaced by open-source alternatives.
- **PostHog analytics, Sparkle auto-updater, email collection.** Clicky-specific features, not carried over.
- **Onboarding video and music.** Clicky branding, not carried over.
- **Mobile or web companion.** Desktop-only for now.
- **Computer control / automation.** Now in scope — see [002-computer-use.md](./002-computer-use.md).
- **Custom voice cloning for TTS.** Chatterbox supports it, but it's a future enhancement, not MVP.

## Further Notes

- **Cold start latency.** Modal's serverless GPU containers take 30s–2min to cold start when scaling from zero. The `scaledown_window` on each Modal deployment should be tuned to balance cost vs. responsiveness. For personal use, 15 minutes is a reasonable default.
- **Credit economics.** H200 GPU time is approximately $4/hr on Modal. With $4K in credits and a 15-minute scaledown window, the user gets roughly 1,000 hours of active GPU time — enough for months of personal use with occasional queries.
- **Model upgradeability.** Since vLLM exposes an OpenAI-compatible API, swapping Gemma 4 27B for Qwen2.5-VL 72B (or any future model) requires only changing the model string in the Modal deployment script. No Electron app changes needed.
- **Clicky codebase as reference.** The original Swift source remains in `Bud/leanring-buddy/` during development. Key files to reference: `CompanionManager.swift` (state machine), `ClaudeAPI.swift` (streaming API client), `OverlayWindow.swift` (transparent overlay), `GlobalPushToTalkShortcutMonitor.swift` (hotkey capture), `CompanionScreenCaptureUtility.swift` (screen capture).
