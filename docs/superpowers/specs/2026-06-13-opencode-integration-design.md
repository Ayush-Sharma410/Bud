# Bud x OpenCode Integration Design

**Date:** 2026-06-13
**Status:** Draft
**Author:** Bud Design Team

## Overview

Integrate Bud's Realtime Voice Pipeline with opencode so that Bud can delegate complex coding tasks to opencode and report results back via voice and the Chat Agent Panel. Bud acts as the voice interface and task router; opencode acts as the autonomous coding engine.

**User experience:** You speak to Bud — "build a REST API for the todo app" — Bud detects the active project, spawns opencode, opencode does the coding work autonomously, and Bud speaks a summary of what was done while full details appear in the Chat Agent Panel.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Interaction model | Full collaboration | Bud handles simple tasks directly, delegates complex coding to opencode, seamlessly blends results |
| Session scope | Fresh session per task | Each coding task gets a new opencode session within a reused server process; no state leakage between tasks |
| Permission model | Full autonomy | opencode runs with `--dangerously-skip-permissions`; Bud is the trust boundary |
| Project targeting | Auto-detect active project | Detect from foreground window; fall back to configured default |
| Result reporting | Voice summary + panel details | Bud speaks a brief summary; full diff/log available in Chat Agent Panel |
| Architecture | Lazy server + HTTP API | Start `opencode serve` on first use, reuse within timeout window, use HTTP API + SSE |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        BUD (Electron)                        │
│                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────┐  │
│  │  Realtime     │    │  Chat Agent      │    │  OpenCode │  │
│  │  Voice        │    │  Panel           │    │  Tool     │  │
│  │  Pipeline     │    │  (Vercel AI SDK) │    │           │  │
│  │  (WebRTC)     │    │                  │    │           │  │
│  └──────┬───────┘    └────────┬─────────┘    └─────┬─────┘  │
│         │                     │                     │        │
│         └─────────┬───────────┘                     │        │
│                   │                                 │        │
│         ┌─────────▼─────────┐                       │        │
│         │  RealtimeToolBridge│                       │        │
│         │  / Tool Registry   │◄──────────────────────┘        │
│         └─────────┬─────────┘                                │
│                   │                                          │
│         ┌─────────▼─────────┐    ┌──────────────────────┐    │
│         │  OpenCodeServer   │    │  ProjectDetector     │    │
│         │  Manager          │    │                      │    │
│         └─────────┬─────────┘    └──────────────────────┘    │
│                   │                                          │
└───────────────────┼──────────────────────────────────────────┘
                    │ HTTP API + SSE
                    │
          ┌─────────▼─────────┐
          │  opencode serve   │
          │  (localhost:<port>)│
          │                   │
          │  Autonomous       │
          │  coding engine    │
          └───────────────────┘
```

### Data Flow

1. User speaks: "Build a REST API for the todo app"
2. Realtime Voice Pipeline transcribes speech, `gpt-realtime-2` reasons and decides to call the `opencode` tool
3. `RealtimeToolBridge` routes the function call to the `opencode` tool executor
4. `ProjectDetector` determines the working directory from the foreground window
5. `OpenCodeServerManager` ensures `opencode serve` is running (lazy start)
6. Tool creates a session via `POST /session`
7. Tool sends the task via `POST /session/{id}/message` with `noReply: false`
8. Tool subscribes to `GET /event` SSE stream for progress updates
9. Progress events stream in — tool emits `opencode-progress` IPC events to the panel
10. When the session goes idle, tool collects the final message list
11. Tool returns a structured result: summary + files changed + key actions
12. `RealtimeVoiceManager` sends the result back to the Realtime session
13. `gpt-realtime-2` speaks a natural summary to the user
14. Full details (file diffs, command output) appear in the Chat Agent Panel

## Components

### 1. OpenCodeServerManager

**File:** `app/src/main/opencode/OpenCodeServerManager.ts`

Singleton that manages the lifecycle of the `opencode serve` process.

```typescript
interface OpenCodeServerManager {
  // Returns the base URL of the running server (e.g., "http://127.0.0.1:4096")
  // Starts the server if not running. Throws if opencode binary not found.
  ensureRunning(workDir: string): Promise<string>;

  // Gracefully stop the server
  stop(): Promise<void>;

  // Current state
  readonly state: 'stopped' | 'starting' | 'running' | 'error';
  readonly port: number | null;
  readonly baseUrl: string | null;
}
```

**Lifecycle:**

- **Start:** Spawn `opencode serve --port <random-high-port> --hostname 127.0.0.1` with the working directory set to the target project. Use a random port to avoid conflicts.
- **Health check:** Poll `GET /global/health` every 500ms until 200 OK, with a 30-second timeout.
- **Reuse:** If already running and healthy, return the existing URL immediately.
- **Idle timeout:** After 10 minutes of no tool invocations, send `SIGTERM` to the server process. Reset the timer on each use.
- **Cleanup:** Register `process.on('exit')` and `process.on('beforeExit')` to kill the child process. Also handle `SIGINT` and `SIGTERM` on the Bud process itself.
- **Restart on crash:** If the process exits unexpectedly while in `running` state, set state to `stopped` and restart on next `ensureRunning()` call.

**Environment:**

- Pass through the user's `PATH` so opencode can find its dependencies (git, node, etc.)
- Set `OPENCODE_SERVER_PASSWORD` to a random token for security, and pass it to HTTP requests as Basic Auth.

### 2. OpenCode Tool

**File:** `app/src/main/tools/opencodeTool.ts`

A new tool registered with both the Realtime Voice Pipeline (via `RealtimeToolBridge`) and the Chat Agent Panel (via Vercel AI SDK `streamText`).

```typescript
const opencodeTool = tool({
  description: `Delegate a complex coding task to opencode, an autonomous coding agent.
    opencode will read/write files, run shell commands, install packages, write tests,
    and build projects. Use this for any task that involves making changes to a codebase.
    The task description should be detailed and specific.`,
  inputSchema: jsonSchema<{
    task: string;        // The coding task to perform
    directory?: string;  // Optional: override the working directory
  }>(),
  execute: async ({ task, directory }) => { ... }
});
```

**Execution flow:**

1. Resolve working directory (via `ProjectDetector` or explicit `directory` arg)
2. Call `serverManager.ensureRunning(workDir)` to get the base URL
3. `POST /session` to create a new session
4. Subscribe to `GET /event` SSE stream (filtered to the session ID)
5. `POST /session/{id}/message` with the task as a text part
6. Wait for the session to go idle (SSE `session.idle` event) or timeout (10 minutes)
7. `GET /session/{id}/message` to retrieve all messages
8. Parse the final assistant message for a summary of changes
9. Return structured result

**Return format:**

```json
{
  "success": true,
  "summary": "Created a REST API with 4 endpoints (GET/POST/PUT/DELETE /todos) using Express and TypeScript. Added input validation with zod and wrote 12 tests.",
  "filesChanged": ["src/routes/todos.ts", "src/models/todo.ts", "src/index.ts", "tests/todos.test.ts"],
  "commandsRun": ["npm init -y", "npm install express zod", "npm test"],
  "fullOutput": "...(truncated to 50KB for Realtime)..."
}
```

### 3. Project Detection

**File:** `app/src/main/opencode/ProjectDetector.ts`

Determines which directory opencode should work in.

**Detection priority:**

1. **Explicit override:** If the tool call includes a `directory` parameter, use it.
2. **Foreground window:** Detect the active project based on the foreground window's process:
   - **VS Code / Cursor:** Run `code --list-extensions` to verify it's installed, then use the VS Code CLI or the window title (which contains the folder name) to determine the workspace. Alternatively, read the `storage.json` in the VS Code app data to find recent workspaces.
   - **Terminal (Windows Terminal, PowerShell, CMD):** Query the current working directory of the shell process via PowerShell:
     ```powershell
     $hwnd = (Add-Type '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -Name Win32 -PassThru)::GetForegroundWindow()
     $pid = 0; (Add-Type '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);' -Name Win32b -PassThru)::GetWindowThreadProcessId($hwnd, [ref]$pid)
     (Get-Process -Id $pid).Path
     ```
     For terminal processes, use WMI to get the process's current directory: `Get-CimInstance Win32_Process -Filter "ProcessId = $pid" | Select-Object -ExpandProperty CommandLine` and parse the working directory from the shell's current location.
   - **Other processes:** Walk up from the process's working directory to find the nearest directory containing `.git/`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, or `Makefile`.
3. **Configured default:** Read from Bud settings (`settings.get('defaultProjectDir')`).
4. **Fallback:** Return an error — Bud speaks: "I couldn't detect a project directory. Please specify one."

**Known project cache:** Once a directory is successfully detected, cache it in memory keyed by process name (e.g., `code.exe → C:\Users\ayush\projects\bud`). This speeds up subsequent detections.

### 4. Progress Streaming and Reporting

**SSE Event Handling:**

Subscribe to `GET /event` on the opencode server. Filter events by session ID. Key events (names to be verified against the actual opencode SSE API during implementation):

| SSE Event | Action |
|-----------|--------|
| `message.updated` | A new message chunk from the AI. Extract text parts and forward to panel. |
| `tool.execute.before` | opencode is about to use a tool (bash, edit, write). Log the tool name and args. |
| `tool.execute.after` | Tool completed. Log the result summary. |
| `session.idle` | opencode finished its work. Trigger result collection. |
| `session.error` | Something went wrong. Trigger error handling. |

**Note:** The SSE event names above are based on opencode's plugin hook names. The actual SSE event stream may use different names or a different structure. During implementation, inspect the output of `GET /event` to determine the exact event format.

**Panel UI updates:**

Emit `opencode-progress` IPC events to the renderer. The Chat Agent Panel displays:

- A task card with the original request
- A live status indicator: "Working..." with a spinner
- Collapsible sections for each tool execution (file edits, shell commands)
- Final summary when complete

**Voice reporting:**

When the tool returns its result to the Realtime session, `gpt-realtime-2` receives the structured result and naturally summarizes it. The tool's return value includes a `summary` field that the model can paraphrase. For example:

> "I've built the REST API for your todo app. It has four endpoints for creating, reading, updating, and deleting todos, with input validation and 12 passing tests. The files are in your project directory."

### 5. Registration

**In `main.ts`:**

```typescript
// Create the tool
import { opencodeTool } from './tools/opencodeTool';

// Register with Chat Agent Panel (Vercel AI SDK)
const tools = {
  computerUse, searchWeb, spawnWorker, windows, apps, memory,
  captureScreen, opencode: opencodeTool  // <-- new
};

// Register with Realtime Voice Pipeline
const toolExecutors = [
  ...existingExecutors,
  toToolExecutor(opencodeTool, 'opencode')  // <-- new
];
realtimeVoiceManager.registerTools(toolExecutors);
```

### 6. Error Handling

| Scenario | Behavior |
|----------|----------|
| opencode binary not found | Tool returns error. Bud speaks: "OpenCode isn't installed. You can install it from opencode.ai." |
| Server fails to start | Retry up to 3 times with 2s backoff. If all fail, return error. Bud speaks the stderr output. |
| Session times out (10 min) | Abort the session via `POST /session/{id}/abort`. Return partial results. Bud speaks: "The task is taking too long, I've stopped it. Here's what was done so far..." |
| opencode crashes mid-task | Detect process exit. Return error with any partial output collected. Bud speaks the error. |
| Project directory not detected | Return error. Bud asks the user to specify a directory. |
| Network error (SSE disconnects) | Reconnect SSE stream. If session is still running, continue waiting. If 3 reconnects fail, abort and report. |
| Concurrent invocations | Queue them. Only one opencode session runs at a time. The second invocation waits for the first to complete. |

### 7. Dependencies

- **opencode CLI:** Must be installed and available in `PATH`. The tool checks for this on first use.
- **No new npm packages:** The HTTP API calls use Node's built-in `fetch` (available in Node 18+). SSE parsing uses a minimal inline parser (~30 lines).
- **Existing Bud infrastructure:** Uses the same tool registration pattern (`toToolExecutor`), the same IPC channels, and the same PowerShell execution helpers.

## Testing Strategy

1. **Unit tests:** Test `ProjectDetector` with mock foreground window processes. Test SSE event parsing with sample event streams. Test result formatting with sample opencode responses.
2. **Integration tests:** Start a real `opencode serve` process, create a session, send a simple task ("create a file called hello.txt with the text 'hello'"), verify the result.
3. **Manual testing:** Speak a coding task to Bud, verify opencode executes it, verify Bud speaks the summary, verify the Chat Agent Panel shows details.

## Out of Scope

- Multiple concurrent opencode sessions (queued, not parallel)
- Persisting opencode session state between Bud restarts
- Custom opencode configuration (model selection, agent selection) — uses defaults
- opencode plugin/MCP integration — future enhancement
- Visual diff viewer in the Chat Agent Panel — text-based output for now
