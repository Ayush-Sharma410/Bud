import { tool, jsonSchema } from 'ai';

// ====================== WINDOWS TOOL ======================
const windowsToolSchema = jsonSchema<{
    action: string;
    payload?: any;
    reason?: string;
}>({
    type: 'object',
    properties: {
        action: {
            description: 'The Windows operation to perform. Must be one of the supported actions listed in the tool description.',
            type: 'string',
            enum: [
                'open_app', 'close_app', 'focus_window', 'minimize_window', 'maximize_window',
                'file_search', 'file_move', 'file_delete', 'file_create', 'file_rename', 'file_read',
                'run_powershell', 'get_processes', 'kill_process',
                'set_volume', 'set_brightness', 'toggle_wifi', 'toggle_bluetooth',
                'read_clipboard', 'write_clipboard', 'clear_temp', 'system_info'
            ]
        },
        payload: {
            description: 'Parameters for the chosen action (e.g. { app: "Cursor" }, { path: "C:\\Users\\...", newName: "..." }, { command: "ipconfig" })',
            type: 'object',
        },
        reason: {
            description: 'One sentence explanation why this tool is being called and how it helps achieve the user goal.',
            type: 'string'
        },
    },
    required: ['action'],
});

export const windowsTool = tool({
    description: `**Windows Tool** — Primary tool for all native Windows OS operations.

This is ONE OF THE TWO MOST IMPORTANT TOOLS (along with Apps & Services Tool).

Use this tool for:
- Launching, closing, focusing, minimizing/maximizing applications
- File and folder operations (search, move, delete, create, rename, read)
- Running PowerShell commands
- System controls (volume, brightness, WiFi, Bluetooth)
- Clipboard access
- Process management (list/kill)
- Clearing temp files, getting system info

**GOLDEN RULE**: Always prefer this tool over Computer Use when the task can be done natively through Windows.

**Routing Priority**: Windows Settings → Windows Tool | File Operations → Windows Tool | PowerShell → Windows Tool

Never use Computer Use if this tool can solve the request.`,
    inputSchema: windowsToolSchema,
    execute: async ({ action, payload, reason }) => {
        const serverLogs: Array<{ level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS'; category: string; message: string; emoji?: string }> = [];

        const addLog = (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', category: string, message: string, emoji?: string) => {
            serverLogs.push({ level, category, message, emoji });
            const emojiPrefix = emoji ? `${emoji} ` : '';
            console.log(`[Windows Tool] ${emojiPrefix}${message}`);
        };

        addLog('INFO', 'Windows', `Action: ${action} | Reason: ${reason || 'Not provided'}`);

        try {
            // TODO: Replace with your IPC call to Electron main process
            // Example: const result = await ipcRenderer.invoke('execute-windows-tool', { action, payload });
            const result = { 
                success: true, 
                data: `Executed ${action} successfully`,
                action,
                payload 
            };

            addLog('SUCCESS', 'Windows', `Action "${action}" completed`, '✅');

            return {
                success: true,
                action,
                payload,
                result: result.data,
                serverLogs,
            };
        } catch (error: any) {
            addLog('ERROR', 'Windows', `Failed: ${error.message}`, '❌');
            console.error('[Windows Tool] Error:', error);

            return {
                success: false,
                action,
                error: error.message,
                serverLogs,
            };
        }
    },
});

// ====================== APPS & SERVICES TOOL ======================
const appsToolSchema = jsonSchema<{
    service: string;
    action: string;
    parameters?: any;
    reason?: string;
}>({
    type: 'object',
    properties: {
        service: {
            description: 'The target app or service (spotify, github, supabase, gmail, slack, notion, google_calendar, vscode, cursor, etc.)',
            type: 'string',
        },
        action: {
            description: 'Specific action to perform on the service (play, pause, create_issue, check_logs, send_message, search_repo, etc.)',
            type: 'string',
        },
        parameters: {
            description: 'Parameters needed for the action (track name, issue title, query, etc.)',
            type: 'object',
        },
        reason: {
            description: 'One sentence explanation why this tool is being used.',
            type: 'string'
        },
    },
    required: ['service', 'action'],
});

export const appsTool = tool({
    description: `**Apps & Services Tool** — Primary tool for controlling specific applications and cloud/SaaS services.

This is ONE OF THE TWO MOST IMPORTANT TOOLS (together with Windows Tool).

Supported categories & examples:
- Music: Spotify, YouTube Music, Apple Music, VLC
- Communication: Gmail, Outlook, Slack, Discord, Teams
- Developer: GitHub, Supabase, Vercel, Docker, Cursor, VS Code
- Productivity: Notion, Google Calendar, Google Drive, OneDrive

**GOLDEN RULE**: Strongly prefer API calls → MCP servers → Native integrations. Use browser automation only as fallback.

**Routing Priority**: Music → Apps Tool | Emails → Apps Tool | Supabase → Apps Tool | GitHub → Apps Tool

Never fall back to Computer Use if this tool can handle the request.`,
    inputSchema: appsToolSchema,
    execute: async ({ service, action, parameters, reason }) => {
        const serverLogs: Array<{ level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS'; category: string; message: string; emoji?: string }> = [];

        const addLog = (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', category: string, message: string, emoji?: string) => {
            serverLogs.push({ level, category, message, emoji });
            const emojiPrefix = emoji ? `${emoji} ` : '';
            console.log(`[Apps Tool / ${service}] ${emojiPrefix}${message}`);
        };

        addLog('INFO', 'Apps', `Service: ${service} | Action: ${action} | Reason: ${reason || 'N/A'}`);

        try {
            // TODO: Add service-specific routing here (API keys, MCP clients, etc.)
            const result = { 
                success: true, 
                data: `Executed "${action}" on ${service}`,
                service,
                action,
                parameters 
            };

            addLog('SUCCESS', 'Apps', `Completed ${action} on ${service}`, '✅');

            return {
                success: true,
                service,
                action,
                parameters,
                result: result.data,
                serverLogs,
            };
        } catch (error: any) {
            addLog('ERROR', 'Apps', `Failed on ${service}: ${error.message}`, '❌');
            return {
                success: false,
                service,
                action,
                error: error.message,
                serverLogs,
            };
        }
    },
});

// ====================== TROUBLESHOOTING TOOL ======================
const troubleshootingSchema = jsonSchema<{
    issue: string;
    context?: string;
    reason?: string;
}>({
    type: 'object',
    properties: {
        issue: { description: 'Clear description of the technical problem the user is facing', type: 'string' },
        context: { description: 'Additional context: recent changes, error messages, symptoms, logs', type: 'string' },
        reason: { description: 'Why troubleshooting is needed right now', type: 'string' },
    },
    required: ['issue'],
});

export const troubleshootingTool = tool({
    description: `**Troubleshooting Tool** — Acts like a senior Windows engineer for diagnostics and fixes.

Use for complex technical issues:
- Docker / Node / Python / Git problems
- Windows Update failures, BSOD, driver issues
- Slow performance, networking (DNS, VPN, WiFi), port conflicts
- Microphone, audio, or hardware problems
- Registry or permissions issues

Internal workflow: Gather logs → Run diagnostics → Search documentation → Suggest + execute fixes.

Can be combined with Windows Tool and Web Search for best results.`,
    inputSchema: troubleshootingSchema,
    execute: async ({ issue, context, reason }) => {
        const serverLogs: any[] = [];
        const addLog = (level: any, cat: string, msg: string) => {
            serverLogs.push({ level, category: cat, message: msg });
            console.log(`[Troubleshooting] ${msg}`);
        };

        addLog('INFO', 'Troubleshoot', `Issue: ${issue}`);

        // TODO: Implement real diagnostic logic + log collection
        return {
            success: true,
            issue,
            diagnosis: `Analyzed: ${issue}`,
            suggestedSteps: ["Step 1: ...", "Step 2: ..."],
            serverLogs,
        };
    },
});

// ====================== MEMORY TOOL ======================
const memorySchema = jsonSchema<{
    operation: string;
    key: string;
    data?: any;
    reason?: string;
}>({
    type: 'object',
    properties: {
        operation: { description: 'Operation to perform: "save", "get", "append", or "search"', type: 'string' },
        key: { description: 'Memory key (e.g. activeProject, preferences, yesterdayWork, communicationStyle)', type: 'string' },
        data: { description: 'Data to store (object or string) — required for save/append', type: 'any' },
        reason: { description: 'Why memory access is needed', type: 'string' },
    },
    required: ['operation', 'key'],
});

export const memoryTool = tool({
    description: `**Memory Tool** — Long-term persistent memory using simple JSON files.

Stores and retrieves:
- User preferences & favorite apps
- Active projects (Ghostmark, Supervisual, Lautonomy, etc.)
- Recent work / daily habits
- Communication style
- Frequently used commands

Critical for maintaining context across conversations and sessions.`,
    inputSchema: memorySchema,
    execute: async ({ operation, key, data, reason }) => {
        const serverLogs: any[] = [];
        const addLog = (level: any, cat: string, msg: string) => {
            serverLogs.push({ level, category: cat, message: msg });
            console.log(`[Memory] ${msg}`);
        };

        addLog('INFO', 'Memory', `${operation} on key "${key}"`);

        // TODO: Implement actual JSON file storage (e.g. using fs/promises in ~/.bud/memory/)
        // Simple example structure: { [key]: data, lastUpdated: Date }
        return {
            success: true,
            operation,
            key,
            data: data || "Retrieved memory data",
            serverLogs,
        };
    },
});

// ====================== COMPUTER USE TOOL (Fallback) ======================
const computerUseSchema = jsonSchema<{
    goal: string;
    maxSteps?: number;
    reason?: string;
}>({
    type: 'object',
    properties: {
        goal: { description: 'Clear, specific natural language goal for the computer-use agent', type: 'string' },
        maxSteps: { description: 'Maximum number of steps before stopping (default: 15)', type: 'number' },
        reason: { description: 'Clear justification why Computer Use is required (no other tool works)', type: 'string' },
    },
    required: ['goal'],
});

export const computerUseTool = tool({
    description: `**Computer Use Tool** — LAST RESORT ONLY for direct GUI automation.

Uses the existing Agent Loop (screenshot → VLM → single action via nut-js → verify).

**ONLY use when**:
- No API / MCP exists for the task
- No Windows Tool or Apps Tool integration is possible
- Legacy desktop software with no other interface

This tool is slow, fragile, and UI-change sensitive. Use sparingly and only as final fallback.`,
    inputSchema: computerUseSchema,
    execute: async ({ goal, maxSteps = 15, reason }) => {
        const serverLogs: any[] = [];
        const addLog = (l: any, c: string, m: string) => console.log(`[Computer Use] ${m}`);

        addLog('INFO', 'ComputerUse', `Goal: ${goal} | Reason: ${reason}`);

        // TODO: Trigger your existing Agent Loop here and return final result
        return {
            success: true,
            goal,
            status: 'Computer Use Agent Loop started',
            maxSteps,
            serverLogs,
        };
    },
});

// ====================== SPAWN WORKER TOOL ======================
const spawnWorkerSchema = jsonSchema<{
    task: string;
    toolsAllowed?: string[];
    timeoutMinutes?: number;
    reason?: string;
}>({
    type: 'object',
    properties: {
        task: { description: 'Detailed description of the long-running background task', type: 'string' },
        toolsAllowed: { description: 'Optional list of tools the worker agent is allowed to use', type: 'array', items: { type: 'string' } },
        timeoutMinutes: { description: 'Maximum runtime before auto-termination (default: 30)', type: 'number' },
        reason: { description: 'Why a background worker is needed', type: 'string' },
    },
    required: ['task'],
});

export const spawnWorkerTool = tool({
    description: `**Spawn Worker Agent** — Run long-duration or asynchronous tasks in the background.

Good for:
- Competitor / market research
- Codebase review or documentation generation
- Monitoring logs, deployments, or emails
- Organizing files or building reports

The worker uses the OpenAI SDK and can call most other tools (but cannot spawn another worker).`,
    inputSchema: spawnWorkerSchema,
    execute: async ({ task, toolsAllowed, timeoutMinutes = 30, reason }) => {
        const serverLogs: any[] = [];
        const addLog = (l: any, c: string, m: string) => console.log(`[Spawn Worker] ${m}`);

        addLog('INFO', 'Worker', `Task: ${task}`);

        // TODO: Spawn background OpenAI SDK agent and return worker ID
        const workerId = 'worker_' + Date.now();

        return {
            success: true,
            task,
            workerId,
            status: 'Worker spawned successfully',
            timeoutMinutes,
            serverLogs,
        };
    },
});