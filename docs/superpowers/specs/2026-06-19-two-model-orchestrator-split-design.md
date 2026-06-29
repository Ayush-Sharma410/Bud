# Two-Model Orchestrator Split — Preamble + Complex

**Date:** 2026-06-19
**Status:** Approved (pending spec review)
**Scope:** `OrchestratorAgent` only — chat panel + Cartesia realtime fallback

## Motivation

Modal-hosted orchestrator models (Qwen3, DeepSeek-R1 distill) add latency that hurts the conversational feel of Bud's chat panel and the Cartesia realtime fallback path. Switching these two `OrchestratorAgent` instances to OpenAI models removes that latency. Splitting into two specialized models further improves perceived responsiveness:

- A **small, fast model** emits the short engagement acknowledgment ("on it", "got it") the instant a request arrives.
- A **complex model** handles tool calls and multi-step workflows, freed from having to produce the acknowledgment first.

The primary Realtime Voice Pipeline (`gpt-realtime-2` over WebRTC) already does preamble + tool calls + spoken answer in a single low-latency OpenAI-native pass and is out of scope for this change.

## Scope

**In scope:**
- `app/src/main/orchestrator/OrchestratorAgent.ts` — concurrent two-model run.
- `app/src/main/orchestrator/orchestratorPrompt.ts` — remove ack section; add `PREAMBLE_SYSTEM_PROMPT`.
- `app/src/main/orchestrator/index.ts` — export the new prompt.
- `app/src/main/llmProvider.ts` — `provider` override option; orchestrator/preamble default helpers.
- `app/src/main/main.ts` — drop `model:` field at the chat-panel construction site.
- `app/src/main/realtime/CartesiaRealtimeVoiceManager.ts` — drop `model:` field at the Cartesia construction site.
- `app/.env.example` — document the two new env vars.

**Out of scope (unchanged):**
- `gpt-realtime-2` WebRTC Realtime Voice Pipeline (`RealtimeVoiceManager`, `RealtimeSession`, `realtimeTypes.ts`).
- `executeRealtimeCompletion.ts` — stays on a single model.
- `worker.ts` background worker — stays on its single OpenAI model.
- The Modal / Groq / Ollama provider branches in `llmProvider.ts` — kept for other paths and A/B testing. No dead code removed.

## Models

| Role        | Env var                | Default         | Provider | Purpose                                                        |
| ----------- | ---------------------- | --------------- | -------- | ------------------------------------------------------------- |
| Preamble    | `BUD_PREAMBLE_MODEL`   | `gpt-4.1-mini`  | `openai` | 1–3 word engagement ack, or `<NO_ACK>`. No tools. Single-shot. |
| Complex     | `BUD_ORCHESTRATOR_MODEL` | `gpt-5.1`     | `openai` | Tool calls, multi-step workflows, final spoken answer.        |

Provider is forced to `openai` for both — model-name heuristics in `resolveLLMProvider()` would mis-route `gpt-4.1-mini` to Ollama (no slash, no Modal prefix), so an explicit override is required.

## `llmProvider.ts` Changes

1. Add `provider?: LLMProvider` to `CreateLanguageModelOptions`.
2. In `createLanguageModel(name, options)`: if `options.provider` is set, branch directly to that provider's case, skipping `resolveLLMProvider()`.
3. Add `getDefaultOrchestratorModelName()` → `process.env.BUD_ORCHESTRATOR_MODEL || 'gpt-5.1'`.
4. Add `getDefaultPreambleModelName()` → `process.env.BUD_PREAMBLE_MODEL || 'gpt-4.1-mini'`.
5. Leave `getDefaultModelName()` untouched for the paths that still use it (`executeRealtimeCompletion`, etc.).
6. All existing Modal/Groq/Ollama branches remain unchanged.

## `OrchestratorAgent` Concurrent Run

### New option field
- Add `preambleModel?: string` to `OrchestratorAgentOptions` (alongside the existing `model?`).

### New fields
- `preambleModel: string` — constructed with `createLanguageModel(name, { provider: 'openai' })`.
- `model: string` (complex) — same `provider: 'openai'` override.
- Constructor: `this.model = options.model || getDefaultOrchestratorModelName(); this.preambleModel = options.preambleModel || getDefaultPreambleModelName();`

### `run()` flow
1. Set `running = true`. Append user message, trim history (as today).
2. **Fire two `streamText` calls in parallel, sharing `options.signal`:**
   - **Preamble call:** `gpt-4.1-mini`, `PREAMBLE_SYSTEM_PROMPT`, last 2 history messages only, `tools: {}`, no `stopWhen` loop, single-shot.
   - **Complex call:** `gpt-5.1`, modified `ORCHESTRATOR_SYSTEM_PROMPT` (ack removed), full history, full tools, `stepCountIs(maxSteps)` — the existing loop.
3. **Preamble stream handling:** accumulate text; on completion, trim and check:
   - Contains `<NO_ACK>` or is empty/garbage → emit nothing.
   - Otherwise → hard-truncate to 60 chars; if `complexEmittedTts` is already true, suppress (avoid stepping on the answer); else emit one `tts` event with the ack phrase.
4. **Complex stream handling:** unchanged — `TTSMarkerParser` extracts status-update `<TTS>` and final-answer `<TTS>`; `text` / `toolCall` / `toolResult` / `done` events fire as today. Set `complexEmittedTts = true` the first time a `tts` event fires from the complex stream.
5. **History:** only the complex run's `response.messages` push to `this.history`. Preamble is throwaway.
6. **`running` guard:** the existing single-flight guard covers both calls (they share one `run()` invocation).
7. **Error handling:**
   - Preamble failure is non-critical → log + continue (no ack plays; complex proceeds).
   - Complex failure → existing `error` event + throw.

### Why concurrent
The ack plays at `gpt-4.1-mini` TTFT (~150–300ms) while the complex model is already working. The final-answer critical path is the complex model's time only — the preamble does not sit on it. Forbidding the complex model from acking eliminates the double-speak risk that would otherwise make concurrency unsafe.

## Prompt Changes

### New `PREAMBLE_SYSTEM_PROMPT` (for `gpt-4.1-mini`)
- Output *only* a 1–3 word acknowledgment, or `<NO_ACK>`.
- Skip ack (`<NO_ACK>`) when: the answer is direct and needs no tool, the user is confirming or correcting something, or the request is unclear.
- Match the user's language.
- Vary phrasing; never repeat the last ack (last assistant text passed in via the trimmed context).
- No tools, no explanation, no punctuation beyond what's spoken.

### `ORCHESTRATOR_SYSTEM_PROMPT` modification
- Delete the `## ACKNOWLEDGMENT` section (`orchestratorPrompt.ts:121-130`).
- Replace with a one-liner: "Do **not** emit an opening acknowledgment — engagement is handled by a separate preamble model. Go straight to tool calls, or a brief `<TTS>` status update if useful, then wrap your final spoken answer in `<TTS>`."
- The `## SPEAKING WITH <TTS> MARKERS` section stays — status updates and the final answer still use `<TTS>`.

### `REALTIME_SYSTEM_INSTRUCTIONS` (WebRTC path)
**Untouched.** `gpt-realtime-2` keeps its own acknowledgment rules. This file is referenced for completeness only — no edit.

## Wire-up

### `main.ts:213` (chat panel)
```ts
chatOrchestrator = new OrchestratorAgent({
  tools: {},
  system: ORCHESTRATOR_SYSTEM_PROMPT,
  // model field dropped — OrchestratorAgent self-defaults via env vars
});
```

### `CartesiaRealtimeVoiceManager.ts:59` (Cartesia fallback)
```ts
this.orchestrator = new OrchestratorAgent({
  tools: {},
  system: this.systemPrompt,
  // model field dropped — OrchestratorAgent self-defaults via env vars
});
```

Both call sites drop the `model:` field. `OrchestratorAgent` picks up `BUD_ORCHESTRATOR_MODEL` / `BUD_PREAMBLE_MODEL` from env (with the `gpt-5.1` / `gpt-4.1-mini` defaults).

## Env Vars

Add to `app/.env.example` under the OpenAI section:
```
# Two-model orchestrator split (chat panel + Cartesia fallback only)
# BUD_PREAMBLE_MODEL=gpt-4.1-mini   # fast engagement ack
# BUD_ORCHESTRATOR_MODEL=gpt-5.1    # tool calls + workflows
```

## Edge Cases

- **Preamble finishes after complex starts emitting TTS:** tracked via `complexEmittedTts`. If the complex stream already produced a `tts` event, the preamble ack is suppressed even if mini returned a valid ack — avoids stepping on the answer.
- **User interrupts mid-preamble (Cartesia):** the shared `abortSignal` cancels both streams; no orphan ack plays.
- **Mini returns a long phrase:** hard-truncate to 60 chars in the preamble handler so a misbehaving mini can't dump a paragraph into Cartesia.
- **Mini misjudges no-ack on a direct answer:** the complex prompt already forbids ack, so worst case is ack-then-direct-answer. Acceptable per the chosen approach.
- **Preamble call errors:** logged, swallowed, no ack plays. Complex call continues. The user perceives a slightly slower engagement on that turn but the task still completes.
- **Cost:** mini preamble is ~50 input + ~10 output tokens per turn — negligible.

## Testing

- `OrchestratorAgent`'s existing tests under `app/src/main/orchestrator/tests/` should be extended:
  - Preamble emits a `tts` ack for a tool-requiring request; complex emits no ack.
  - Preamble returns `<NO_ACK>` for a direct-answer request; no `tts` from preamble.
  - Preamble suppressed when `complexEmittedTts` is already true.
  - Preamble error does not fail the run.
  - Shared `abortSignal` cancels both streams.
- Manual smoke: chat panel + Cartesia fallback path show immediate ack, then final answer, with no double-speak.
- WebRTC realtime path is unaffected and needs no new tests.

## Non-Goals

- No change to the `gpt-realtime-2` WebRTC pipeline.
- No change to `executeRealtimeCompletion` or `worker.ts`.
- No removal of the Modal / Groq / Ollama provider abstraction — it stays for other paths.
- No new provider selection UI in settings — env-driven only, matching the codebase style.
