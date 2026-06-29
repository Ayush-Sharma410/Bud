# Orchestrator Agent Design

**Date:** 2026-06-18  
**Status:** Draft  
**Branch target:** `experiment/orchestrator-agent`

## Goal

Replace Bud's thin realtime completion loop with a single, capable **Orchestrator Agent** that handles every voice and chat request. The agent is backed by a strong open-source model (starting with **Qwen3-235B-A22B**) deployed on Modal. It decides whether to answer directly, call one tool, or run a multi-step tool loop, and it can hand long-running work off to a background task.

## Non-goals

- Do not rewrite the existing tool implementations (`windowsTool`, `appsTool`, `computerUse`, etc.). The orchestrator calls them through the same Vercel AI SDK `tool()` wrappers.
- Do not change the audio capture/playback pipeline (Cartesia realtime). The orchestrator feeds text into the existing TTS path.
- Do not support multiple concurrent foreground orchestrator runs; only one foreground run at a time per Bud instance.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Voice / Chat Input                                                 │
└───────────────────────┬─────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  OrchestratorAgent                                                  │
│  - Owns conversation history                                        │
│  - Calls streamText(Qwen3-235B-A22B, tools, systemPrompt)           │
│  - Emits: reasoning, toolCall, toolResult, text, tts, done, error   │
└───────────────────────┬─────────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   Tool Executor   TTS Pipeline     Chat / Overlay UI
```

### New files

- `app/src/main/orchestrator/OrchestratorAgent.ts` — core agent class.
- `app/src/main/orchestrator/OrchestratorEventBus.ts` — typed event emitter for UI + voice manager.
- `app/src/main/orchestrator/ToolResultEnricher.ts` — post-tool hooks (screenshots, error context).
- `app/src/main/orchestrator/RetryToolExecutor.ts` — transient-error retry wrapper.
- `app/src/main/orchestrator/orchestratorPrompt.ts` — system prompt + tool hierarchy rules.
- `modal/llm_serve.py` — Modal SGLang deployment for Qwen3-235B-A22B.

### Modified files

- `app/src/main/realtime/CartesiaRealtimeVoiceManager.ts` — call `OrchestratorAgent.run()` instead of `executeRealtimeCompletion()`.
- `app/src/main/agentManager.ts` — become the registry for background orchestrator tasks.
- `app/src/main/main.ts` — wire `OrchestratorAgent` into chat IPC handlers.
- `app/src/renderer/panel/index.html` — render reasoning, tool cards, and `<TTS>` snippets.
- `app/.env.example` — add `MODAL_ORCHESTRATOR_MODEL` and related env vars.

## Model deployment

### Model choice

- **Primary:** `qwen/qwen3-235b-a22b` (Qwen3-235B-A22B).
- **No Llama models** per project preference.
- Future alternatives: larger Qwen3 variants or DeepSeek-V3-0324 if Qwen3 proves insufficient.

### Modal container

- **Base image:** `lmsysorg/sglang:v0.5.13.post1-cu129` (proven for Gemma 4; validate for Qwen3).
- **GPU:** minimum `8× A100-80GB` or `8× H100-80GB` for BF16 weights + KV cache.
- **Quantization fallback:** FP8 on H100 if BF16 latency/cost is too high.
- **Warm pool:** keep at least one container warm so the first request does not cold-start.

### Endpoint

- New env var: `MODAL_ORCHESTRATOR_MODEL=qwen/qwen3-235b-a22b`.
- Reuse `MODAL_LLM_ENDPOINT` or add `MODAL_ORCHESTRATOR_ENDPOINT` if the endpoint differs from the fast LLM endpoint.
- Use the same `@ai-sdk/openai-compatible` client as `llmProvider.ts`.

## Agent loop

```ts
class OrchestratorAgent {
  async run(request: string, options: RunOptions): Promise<RunResult> {
    this.history.push({ role: 'user', content: request });

    const result = streamText({
      model: createLanguageModel(process.env.MODAL_ORCHESTRATOR_MODEL),
      system: ORCHESTRATOR_SYSTEM_PROMPT,
      messages: this.history,
      tools: this.tools,
      toolChoice: 'auto',
      maxSteps: 30,
      async onStepFinish({ toolCalls, text }) {
        // emit tool calls and reasoning to UI
      },
    });

    for await (const chunk of result.textStream) {
      this.parseTTSMarkers(chunk);   // speak live snippets
      this.emit('text', chunk);       // stream to UI
    }

    const finalText = await result.text;
    this.history.push({ role: 'assistant', content: finalText });
    this.emit('done', { finalText });
    return { finalText };
  }
}
```

### Loop behavior

1. **No tools needed:** model answers directly; text streams to UI and final answer is spoken.
2. **One tool needed:** model calls the tool, sees the result, then answers.
3. **Multi-step:** model chains tools; each result feeds back into `streamText` automatically via Vercel SDK `maxSteps`.
4. **Error recovery:** tool executor catches errors; transient errors are retried up to 3 times with exponential backoff. Non-transient errors are returned to the model with context so it can replan.
5. **Abort:** `AbortSignal` is threaded through `streamText`; Escape key or stop command aborts the run and clears queued actions.

## Tool-calling improvements

### Pre-tool middleware

| Tool | Prerequisite enforced |
|------|----------------------|
| `appsTool` | If the target app has a desktop presence, `windowsTool` must open it first and wait for it to be ready. |
| `computerUse` with `screenshot` | None; screenshot is captured. |
| `computerUse` with GUI action (`click`, `type`, etc.) | Previous step should have established coordinates via vision or a prior screenshot. |
| Any URL opened via `windowsTool` | Wait 2–3 seconds, then `captureScreen` so the model can read the page. |

### Post-tool middleware

- After every `computerUse` GUI action, capture a screenshot and include it as an image message in the next step.
- After `shell` actions, summarize long stdout to avoid context bloat.
- After tool errors, append a structured error message with suggested retry action when possible.

### Retry wrapper

- Retry on: network errors, 5xx, timeouts, rate-limiting (with backoff).
- Do not retry on: 4xx client errors, tool schema validation errors, user cancellation.
- Max 3 retries; each retry emits a `toolRetry` event to the UI.

## TTS streaming with `<TTS>` markers

To keep Bud responsive while tools run, the orchestrator emits spoken snippets as soon as they are generated.

### Protocol

- The model is instructed to wrap any text meant to be spoken in `<TTS>...</TTS>` tags.
- Text outside tags is shown in the UI but not spoken.
- Example stream:
  ```
  <TTS>on it</TTS>
  Opening Spotify and checking active devices...
  [tool call: spotify.devices]
  <TTS>found your desktop device, playing the song now</TTS>
  ```

### Parser

- A small streaming parser in `OrchestratorAgent` extracts complete `<TTS>` blocks.
- As soon as a closing `</TTS>` is received, the contained text is emitted as a `tts` event.
- The voice manager sends the snippet to the TTS pipeline immediately without waiting for the full response.

### Fallback

- If the model forgets to use `<TTS>` tags, the final assistant message is spoken automatically once the run completes.

## Foreground vs background execution

### Foreground (default)

- Tied to the current voice/chat turn.
- Streams all events to the panel in real time.
- Blocks the active voice session until `done` or `error`.

### Background

- Triggered when:
  - The user explicitly says "in the background" / "do this in the background".
  - The orchestrator predicts the task needs many steps or long waits.
- Behavior:
  - `AgentManager` creates a background `AgentTask` with a unique ID.
  - The foreground run returns immediately with an acknowledgment like "I'll work on that in the background."
  - Milestone events (`tts`, `toolCall`, `text`) are emitted to the panel's task view.
  - On completion, a final notification is shown and spoken.

## UI streaming

The renderer receives these events:

| Event | Payload | UI action |
|-------|---------|-----------|
| `reasoning` | string | Show in collapsible "thinking" panel. |
| `toolCall` | `{ name, input, id }` | Add a tool-call card in pending state. |
| `toolResult` | `{ id, result }` | Update the matching card with success/error. |
| `toolRetry` | `{ id, attempt, reason }` | Show small retry indicator on the card. |
| `text` | string | Append to the assistant message bubble. |
| `tts` | string | Send to TTS; also show as a spoken caption. |
| `done` | `{ finalText }` | Finalize assistant bubble, speak if not already spoken. |
| `error` | `{ message }` | Show error message and speak a brief apology. |

## Latency optimizations

1. **Warm Modal container** with `keep_warm=1` minimum.
2. **SGLang settings** tuned for throughput: continuous batching, `--disable-mla` if unstable, `--mem-fraction-static` adjusted for long contexts.
3. **Non-thinking mode** for tool calls; enable thinking only when the model explicitly needs deep reasoning.
4. **HTTP keep-alive** and connection reuse across a single orchestrator run.
5. **Trim history** to a sliding window (last N messages + summarized older context) to keep token count stable.
6. **Parallel independent tool calls** enabled via Vercel SDK.
7. **Quantization:** evaluate FP8 on H100 if BF16 first-token latency is too high.

## Error handling and cancellation

- `AbortSignal` is passed through `streamText` and tool execution.
- `Escape` key or voice "stop" calls `OrchestratorAgent.abort()`, which:
  - Cancels the LLM stream.
  - Clears the action queue.
  - Emits an `error` event with reason `aborted`.
- If the Modal endpoint is unreachable, fall back to the fast LLM path (Qwen3-32B / Groq) for that request and show a subtle indicator.

## Testing plan

1. **Unit tests**
   - `OrchestratorAgent` event sequence for no-tool, one-tool, and multi-tool runs.
   - `<TTS>` parser extracts snippets correctly across chunk boundaries.
   - Retry wrapper retries only transient errors.
2. **Modal deployment test**
   - Deploy `modal/llm_serve.py` and verify `/v1/chat/completions` returns a valid response.
3. **Manual end-to-end**
   - Simple Q&A with no tools.
   - Single tool: "what's the weather" (searchWeb).
   - Multi-step: "play my Spotify liked songs" (open Spotify → devices → transfer → play).
   - Error recovery: ask for an action that fails once (e.g. app not running) and confirm retry/replan.
   - Background task: "organize my Downloads folder in the background."

## Design decisions

1. **`executeRealtimeCompletion` fallback:** Keep it as the legacy fallback while the orchestrator is experimental. Once the orchestrator is stable and covers all realtime/chat paths, remove it.
2. **Conversation history:** The orchestrator uses the same message history as the chat panel so voice and chat share context. Tool results and screenshots are stored internally and summarized before being shown to the user.
3. **Thinking mode:** Qwen3-235B-A22B supports an `enable_thinking` flag. Tool-calling steps use `enable_thinking=false` for latency; the model may enable thinking explicitly for hard reasoning or planning steps.

## Open questions

1. What is the exact SGLang launch command for Qwen3-235B-A22B (e.g. `--tp 8`, `--dp`) — needs a test deployment.

## Success criteria

- The agent correctly chooses `windowsTool`/`appsTool` over `computerUse` for tasks where they apply.
- `appsTool` is never called without first opening the app when a desktop app exists.
- Multi-step tasks complete without losing context across tool calls.
- TTS starts within 2–3 seconds for simple requests and within 5 seconds for the first spoken snippet in multi-step requests.
- Background tasks can run independently and report progress.
