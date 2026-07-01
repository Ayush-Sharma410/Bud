import { tool, jsonSchema } from 'ai';
import { randomUUID } from 'crypto';
import { fork } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { bus } from '../bus';

export const createSpawnAgentTool = (getPanelWindow: () => BrowserWindow | null) => tool({
  description: `**Spawn Agent** — Run long-duration or asynchronous tasks in the background.

Good for:
- Research / market analysis
- Building reports or summaries
- Organizing information

The worker uses the OpenAI SDK and can call \`searchWeb\` and \`memory\` only. It **cannot** spawn another agent or touch the Excalidraw canvas.

Returns immediately with a taskId — the task runs in the background and reports progress/completion back to the panel.`,
  inputSchema: jsonSchema<{
    task: string;
    toolsAllowed?: string[];
    timeoutMinutes?: number;
    reason?: string;
  }>({
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Detailed description of the long-running background task' },
      toolsAllowed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of tools the worker is allowed to use (defaults to searchWeb + memory)',
      },
      timeoutMinutes: { type: 'number', description: 'Maximum runtime before auto-termination (default: 30)' },
      reason: { type: 'string', description: 'Why a background agent is needed' },
    },
    required: ['task'],
  }),
  execute: async ({ task, toolsAllowed, timeoutMinutes = 30, reason }) => {
    const taskId = randomUUID();
    console.log(`🛠️ Tool: spawnAgent — Task: "${task.substring(0, 80)}..." | Timeout: ${timeoutMinutes}m | Reason: ${reason || 'N/A'}`);

    bus.post(taskId, 'worker', { task, toolsAllowed, timeoutMinutes, reason });

    const workerOutputDir = path.join(process.env.BUD_USER_DATA || app.getPath('userData'), 'worker-output');
    fs.mkdirSync(workerOutputDir, { recursive: true });

    const workerPath = path.join(__dirname, '..', '..', 'worker', 'worker.js');
    const child = fork(workerPath, [taskId], {
      env: {
        ...process.env,
        WORKER_TASK: task,
        WORKER_TOOLS_ALLOWED: JSON.stringify(toolsAllowed || ['searchWeb', 'memory']),
        WORKER_TIMEOUT_MINUTES: String(timeoutMinutes),
        WORKER_OUTPUT_DIR: workerOutputDir,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
      },
      detached: false,
      cwd: workerOutputDir,
    });

    const killTimer = setTimeout(() => {
      if (!child.killed) {
        console.log(`⏰ Worker ${taskId} timed out after ${timeoutMinutes}m — killing`);
        child.kill('SIGTERM');
        bus.fail(taskId, `Timed out after ${timeoutMinutes} minutes`);
        getPanelWindow()?.webContents.send('agent-task-updated', bus.get(taskId));
      }
    }, timeoutMinutes * 60 * 1000);

    child.on('exit', (code) => {
      clearTimeout(killTimer);
      console.log(`Worker ${taskId} exited — code ${code}`);
      getPanelWindow()?.webContents.send('agent-task-updated', bus.get(taskId));
    });

    console.log(`Spawned agent for task ${taskId}`);
    getPanelWindow()?.webContents.send('agent-task-updated', bus.get(taskId));

    return {
      success: true,
      taskId,
      task: task.substring(0, 200),
      timeoutMinutes,
      message: `Background agent started. I'll let you know when it's done.`,
    };
  }
});
