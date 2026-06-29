# PRD: Bud — Computer Use

## Problem Statement

Bud can see the user's screen and answer questions about it, but it cannot act. When the user says "open Chrome and go to AWS," Bud can only describe how to do it — it can't actually do it. The user still has to click, type, and navigate themselves. For a desktop companion that lives in the system tray and already has full screen visibility, the inability to act on what it sees is the single biggest gap between "helpful assistant" and "autonomous buddy."

## Solution

Extend Bud with Computer Use — the ability to autonomously control the user's Windows desktop (mouse, keyboard, app launching) to complete tasks issued via voice. Bud receives a voice command, produces a structured Task Plan, then executes each step through an Agent Loop: capture screenshot → send to VLM → receive next action → execute via nut-js → repeat until done. Multiple Agent Tasks can run concurrently with a serialized Action Queue ensuring only one task actuates at a time. Bud narrates minimally — announces the task at the start, reports errors, and confirms completion.

## User Stories

1. As a user, I want to say "open Chrome" and have Bud launch Chrome for me, so that I don't have to click through menus or use keyboard shortcuts.
2. As a user, I want to say "go to my AWS console" and have Bud navigate there in the browser, so that I can get to frequently-used sites by voice alone.
3. As a user, I want to say "open Spotify and play my liked songs" and have Bud perform all the clicks needed, so that I can control apps without touching the mouse.
4. As a user, I want Bud to show me what it plans to do before it starts acting, so that I know the task was understood correctly.
5. As a user, I want Bud to automatically recover when a step fails (e.g., a button didn't load yet), so that tasks complete reliably without my intervention.
6. As a user, I want Bud to tell me when something goes wrong and it can't recover after 3 retries, so that I can course-correct or take over manually.
7. As a user, I want to press Escape at any time to instantly stop all running Agent Tasks, so that I have an immediate kill switch if something goes wrong.
8. As a user, I want to say "stop" or "cancel" to halt all Agent Tasks via voice, so that I don't need to reach for the keyboard.
9. As a user, I want to issue a new voice command while an Agent Task is running and have it start as a separate concurrent task, so that I can multitask ("also check my email while you're at it").
10. As a user, I want Bud to announce what it's about to do at the start ("on it, opening chrome and heading to aws") and confirm when it's done ("done, you're on the aws console"), so that I know the task is being handled without constant screen-watching.
11. As a user, I want Bud to stay silent during routine steps (clicking, typing, scrolling) and only speak when something noteworthy happens, so that the narration doesn't become annoying.
12. As a user, I want to ask Bud a conversational question ("what's the weather?") while an Agent Task is running, and get a normal spoken answer without it being confused with a computer-use command, so that voice conversation and computer use coexist naturally.
13. As a user, I want Bud to launch apps directly (via Windows shell) instead of clicking through the Start menu, so that simple launches are instant rather than requiring multiple VLM round-trips.
14. As a user, I want the Agent Loop to take a fresh screenshot after every action, so that Bud adapts to unexpected dialogs, popups, or loading states instead of blindly following a stale plan.
15. As a user, I want multiple Agent Tasks to not interfere with each other when they both need the mouse, so that one task's click doesn't land in the wrong window because another task moved the cursor.
16. As a user, I want Bud to use the same VLM model for computer use that it uses for conversation, so that I don't need to deploy or manage a second model.
17. As a user, I want the computer-use pipeline to feel fast — actions should happen within a second or two of each other, not with multi-second gaps between each click.

## Implementation Decisions

### Architecture: Hybrid Plan + Agent Loop

Computer Use follows a two-phase architecture:

1. **Planning phase**: The VLM receives the user's voice transcript + a screenshot and produces a structured Task Plan — a JSON array of high-level steps with descriptions and expected actions. This gives the task structure, debuggability, and allows narration of the overall plan.

2. **Execution phase**: Each step of the plan is executed through an Agent Loop. For each step: capture screenshot → send to VLM with the current step context → VLM returns a single action tag → Action Executor performs the action → repeat. The VLM verifies whether the previous action succeeded (combined act-and-verify in a single call) before deciding the next action.

This hybrid provides the planning benefits of a scripted approach with the resilience of a reactive screenshot loop.

### Actuation: nut-js

Desktop control is handled by `@nut-tree/nut-js`, a maintained Node.js native module with TypeScript support. It calls Windows `SendInput` / `SetCursorPos` APIs to move the mouse, click, type text, and press key combinations. This runs in the Electron main process.

Coordinate-based actuation aligns with the existing VLM pipeline that already outputs pixel coordinates via `[POINT:x,y:label]`. The same coordinate space is reused for action coordinates.

### Action Vocabulary

The VLM can emit these actions in execution mode:

- `click(x, y)` — left click at screen coordinates
- `double_click(x, y)` — double click
- `right_click(x, y)` — right click (context menus)
- `type("text")` — type a string of text
- `press("key")` — press a key or combo (e.g., `Enter`, `Ctrl+T`, `Win+S`)
- `scroll(x, y, direction, amount)` — scroll up/down at a position
- `wait(ms)` — pause for animations/loading to finish
- `launch("app_name")` — open an application via Windows shell (fast path, no VLM loop needed)
- `done("summary")` — task is complete

Drag-and-drop is explicitly deferred to a future iteration.

### Output Formats

**Planning call** returns structured JSON:
```json
{
  "narration": "on it, heading to your aws console",
  "plan": [
    { "step": 1, "description": "Launch Chrome", "action": { "type": "launch", "target": "chrome" } },
    { "step": 2, "description": "Navigate to AWS", "action": { "type": "type", "text": "console.aws.amazon.com" } },
    { "step": 3, "description": "Go", "action": { "type": "press", "key": "Enter" } }
  ]
}
```

**Step execution calls** return a single action tag (lightweight, fast to parse):
```
[ACTION:click(450,52):address bar]
```

If the VLM determines the command is a conversational question (not a computer-use task), it returns plain text — no plan, no actions. The CompanionManager routes accordingly.

### Orchestration: Client-Side

The Agent Loop runs in the Electron main process. The VLM on Modal remains a stateless "screenshot in, response out" service. All state — the Task Plan, current step index, retry count, conversation context — lives in the Electron process.

This avoids the latency of uploading screenshots just so a server-side orchestrator can forward them to the VLM on the same machine. The screenshot data is already local; the Action Executor is local; only the VLM inference call goes to Modal.

### Single Entry Point, VLM Routes

Every voice command enters through the existing CompanionManager pipeline (STT → screenshot → VLM). The VLM's system prompt includes instructions for both conversation and computer use. If the VLM returns a Task Plan (JSON with actions), CompanionManager spawns an Agent Task. If it returns plain text, the existing TTS pipeline handles it. The user doesn't need to switch modes or use different hotkeys.

### Same VLM Endpoint, Different System Prompts

Computer Use reuses the existing `bud-vlm-serve` Modal deployment. No second VLM service is needed. The Electron app sends different system prompts depending on the call type:

- **Conversation mode**: The existing system prompt (respond conversationally, point at things).
- **Planning mode**: "Analyze the user's request and the screenshot. If it requires computer control, produce a JSON Task Plan. If it's just a question, respond conversationally."
- **Step execution mode**: "You are executing step N of M. Here's the screenshot after the last action. Return a single [ACTION:...] tag."

### Multi-Agent with Serialized Actuation

Multiple Agent Tasks can exist concurrently — each new voice command spawns a new task. Agent Tasks can plan and reason in parallel (VLM calls happen concurrently), but physical actions go through a shared Action Queue that serializes execution. Only one task moves the mouse or types at a time.

### Narration: Minimal, Per-Plan

Bud narrates at three points:
1. **Task start**: Brief acknowledgment via TTS ("on it, opening chrome and heading to aws").
2. **Error/stuck**: If a step fails 3 times, Bud speaks up ("hey, i'm stuck trying to click the address bar, want me to try something else?").
3. **Task complete**: Confirmation ("done, you're on the aws console now").

No narration during routine step execution. TTS calls add latency; silence is fast.

### Stop Mechanisms

Two ways to halt all running Agent Tasks:

1. **Escape hotkey**: Pressing `Escape` instantly kills all running Agent Tasks. Zero latency — no AI involved, just an event listener that calls `abort()` on all active AbortControllers.
2. **Voice keyword**: After STT returns a transcript, the Electron app checks for "stop" / "cancel" / "abort" keywords *before* sending to the VLM. If detected, all tasks are killed immediately. Latency: STT time only (~1 second).

### Verification and Retry

Each step uses combined act-and-verify: the VLM sees the screenshot after the previous action and decides whether it succeeded. If it failed, the VLM returns a corrective action instead of advancing to the next step. If a step fails 3 consecutive times, the Agent Task pauses and asks the user for help via TTS.

### Safety: Prompt-Level Only (V1)

No code-level guardrails. The VLM system prompt includes soft guidance: "never delete files without the user explicitly asking, never send messages without explicit instruction." The user can always press Escape or say "stop." Code-level guardrails (confirmation dialogs for destructive actions, app allowlists) are deferred to a future iteration.

## Testing Decisions

Good tests verify external behavior through the module's public interface, not internal implementation details. Tests should be stable across refactors.

### Action Parser
Pure function unit tests. Input: VLM response strings with `[ACTION:...]` tags. Output: parsed action objects (type, coordinates, text, key). Tests cover all action types, malformed tags, missing fields. Same testing pattern as the existing Pointing Parser.

### Task Plan Parser
Pure function unit tests. Input: JSON strings (valid plans, malformed JSON, missing fields, empty plans). Output: structured TaskPlan objects or parse errors. Tests verify schema validation and graceful degradation.

### Action Executor
Interface-based tests with a mock nut-js backend. Inject a recorder that logs calls instead of moving the real mouse. Assert that each action type maps to the correct nut-js API calls with the right arguments.

### Agent Task
Integration tests with mock VisionProvider + mock ActionExecutor. Assert:
- Follows the plan step by step
- Retries on step failure (up to 3 times)
- Pauses and asks user after 3 consecutive failures
- Aborts cleanly on AbortController signal
- Calls TTS for narration at start and end only

### CompanionManager Routing
Test that a VLM response containing a JSON plan spawns an Agent Task, while a plain text response goes through the existing TTS flow. Uses the existing mock provider injection pattern.

## Out of Scope

- **Drag-and-drop.** Deferred to a future iteration. Click, type, press, scroll covers 95% of desktop tasks.
- **Code-level safety guardrails.** Confirmation dialogs for destructive actions, app allowlists — deferred. Prompt-level guidance only for V1.
- **Explicit mode switching.** No separate hotkey or UI toggle for "computer use mode" vs. "conversation mode." The VLM decides automatically based on the user's request.
- **Server-side orchestration.** The Agent Loop runs client-side. No Modal-hosted orchestrator.
- **Windows UI Automation API.** Accessibility-tree-based element finding is more reliable than coordinate clicking but significantly more complex. Deferred.
- **Screen recording / task replay.** Recording Agent Task executions for debugging or replay.
- **Task scheduling.** Running Agent Tasks on a timer or cron ("open my email every morning at 9am").
- **Cross-machine control.** Bud controls only the machine it runs on.

## Further Notes

- **Latency budget.** Each Agent Loop iteration involves: screenshot capture (~100ms) + VLM inference (~500ms-2s) + action execution (~50ms). Target is under 3 seconds per iteration. The `launch` shortcut bypasses the loop entirely for simple app launches.
- **VLM coordinate accuracy.** Gemma 4 27B's coordinate prediction accuracy on UI elements is untested at scale. If it consistently misclicks, consider switching to a model specifically fine-tuned for UI grounding (e.g., Qwen2.5-VL, CogAgent) or adding the Windows UI Automation API as a fallback.
- **nut-js Electron compatibility.** nut-js uses native Node.js addons. Verify it works correctly in Electron's main process without rebuild issues. The `electron-rebuild` tool may be needed.
- **Action Queue fairness.** The current design is FIFO — whichever agent submitted its action first gets to actuate. This is fine for V1 but may need priority-based scheduling if agents have different urgency levels.
- **Conversation during execution.** When an Agent Task is running and the user asks a conversational question, the voice pipeline runs independently (VLM call for conversation doesn't block the Agent Loop's VLM calls). The user hears the TTS response while the agent continues working.
