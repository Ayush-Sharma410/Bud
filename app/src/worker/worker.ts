/**
 * Bud — Background Worker Agent
 * Runs as a child_process.fork() — receives taskId via argv[2]
 *
 * The worker is a sub-orchestrator that can call stateless tools
 * (windows, apps, troubleshooting, memory, searchWeb) but NOT
 * spawnWorker or computerUse.
 *
 * Communicates progress/completion/failure back to the main process
 * via the shared SQLite bus (bud-bus.db).
 */
import '../logger';
import OpenAI from "openai";
import path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import Database from 'better-sqlite3';

const execAsync = promisify(exec);

const taskId = process.argv[2];
if (!taskId) { console.error('No taskId'); process.exit(1); }

// Load .env manually (child process doesn't inherit the Electron env loader)
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    process.env[k] = v;
  }
}
loadEnv();

// ── SQLite Bus ──────────────────────────────────────────────
const dbPath = path.join(process.env.BUD_USER_DATA || process.cwd(), 'bud-bus.db');
const db = new Database(dbPath);

function busProgress(note: string) {
  db.prepare(`UPDATE agent_tasks SET progress=?, updated_at=unixepoch() WHERE id=?`).run(note, taskId);
}
function busComplete(result: object) {
  db.prepare(`UPDATE agent_tasks SET status='done', result=?, updated_at=unixepoch() WHERE id=?`)
    .run(JSON.stringify(result), taskId);
}
function busFail(error: string) {
  db.prepare(`UPDATE agent_tasks SET status='failed', result=?, updated_at=unixepoch() WHERE id=?`)
    .run(JSON.stringify({ error }), taskId);
}

// ── Worker Tool Implementations ─────────────────────────────

async function runPowershell(command: string): Promise<string> {
  try {
    const escaped = command.replace(/"/g, '\\"');
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "${escaped}"`,
      { maxBuffer: 1024 * 1024, timeout: 30_000 }
    );
    return stdout.trim();
  } catch (err: any) {
    return `[Error] ${err.message}`;
  }
}

// Memory tool for worker (direct file I/O)
const memoryDir = path.join(process.env.BUD_USER_DATA || process.cwd(), 'memory');
function ensureMemoryDir() {
  if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
}

// ── Main Loop ───────────────────────────────────────────────

async function run() {
  const row = db.prepare(`SELECT * FROM agent_tasks WHERE id=?`).get(taskId) as any;
  if (!row) { console.error(`Task ${taskId} not found`); process.exit(1); }

  // Mark as running
  db.prepare(`UPDATE agent_tasks SET status='running', updated_at=unixepoch() WHERE id=?`).run(taskId);
  busProgress('Worker started');

  const payload = JSON.parse(row.payload);
  const taskDescription = payload.task || payload.task_description || '';
  const allowedTools = JSON.parse(process.env.WORKER_TOOLS_ALLOWED || '[]') as string[];

  const openaiBaseURL = process.env.OPENAI_BASE_URL;
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(openaiBaseURL ? { baseURL: openaiBaseURL } : {}),
});

  // Build tool definitions based on what's allowed
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    // Always available
    {
      type: 'function',
      function: {
        name: 'report_progress',
        description: 'Report a short status update visible to the user',
        parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_shell',
        description: 'Run a PowerShell command and return output',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'Fetch a URL and return the text body (max 8000 chars)',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_web',
        description: 'Search the web using Exa API for real-time information',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_save',
        description: 'Save data to persistent memory under a key',
        parameters: { type: 'object', properties: { key: { type: 'string' }, data: {} }, required: ['key', 'data'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_get',
        description: 'Retrieve data from persistent memory by key',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
      }
    },
  ];

  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a background worker agent for Bud, a Windows desktop companion. You are executing a task independently. Use tools to accomplish the task. Call report_progress periodically to keep the user updated. When done, respond with a final summary.

When creating files, save them to ${process.env.WORKER_OUTPUT_DIR || process.env.BUD_USER_DATA || process.cwd()}. Always report the exact file path in your final summary.`
    },
    { role: 'user', content: taskDescription }
  ];

  let stepCount = 0;
  const maxSteps = 30;

  while (stepCount < maxSteps) {
    stepCount++;
    busProgress(`Step ${stepCount}/${maxSteps}`);

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.1',
      tools,
      messages,
      max_completion_tokens: 4096,
    });

    const choice = response.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
      busComplete({ output: msg.content || '', steps: stepCount });
      break;
    }

    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

    for (const tc of msg.tool_calls) {
      if (tc.type !== 'function') continue;

      let input: any = {};
      let result = '';

      try {
        // Some model responses emit empty arguments for no-arg tool calls.
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (parseErr: any) {
        result = `Error: invalid tool arguments for ${tc.function.name}: ${parseErr.message}`;
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
        continue;
      }

      try {
        switch (tc.function.name) {
          case 'read_file':
            result = fs.readFileSync(input.path, 'utf-8');
            if (result.length > 10000) result = result.substring(0, 10000) + '\n... (truncated)';
            break;

          case 'write_file':
            const dir = path.dirname(input.path);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(input.path, input.content, 'utf-8');
            result = 'Written successfully';
            break;

          case 'run_shell':
            result = await runPowershell(input.command);
            if (result.length > 8000) result = result.substring(0, 8000) + '\n... (truncated)';
            break;

          case 'fetch_url': {
            const res = await fetch(input.url);
            result = (await res.text()).slice(0, 8000);
            break;
          }

          case 'search_web': {
            const apiKey = (process.env.EXA_API_KEY || '').replace(/"/g, '').trim();
            if (!apiKey) { result = 'EXA_API_KEY not configured'; break; }
            const res = await fetch('https://api.exa.ai/search', {
              method: 'POST',
              headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
              body: JSON.stringify({ query: input.query, useAutoprompt: true, numResults: 5 })
            });
            const data = await res.json() as any;
            result = JSON.stringify(data.results || [], null, 2);
            break;
          }

          case 'memory_save': {
            ensureMemoryDir();
            const safe = (input.key as string).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
            const record = { key: input.key, data: input.data, updatedAt: new Date().toISOString() };
            fs.writeFileSync(path.join(memoryDir, `${safe}.json`), JSON.stringify(record, null, 2), 'utf-8');
            result = `Saved to memory: "${input.key}"`;
            break;
          }

          case 'memory_get': {
            ensureMemoryDir();
            const safe = (input.key as string).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
            const fp = path.join(memoryDir, `${safe}.json`);
            if (fs.existsSync(fp)) {
              const record = JSON.parse(fs.readFileSync(fp, 'utf-8'));
              result = JSON.stringify(record.data);
            } else {
              result = `No memory found for key "${input.key}"`;
            }
            break;
          }

          case 'report_progress':
            busProgress(input.note);
            result = 'Progress noted';
            break;

          default:
            result = `Unknown tool: ${tc.function.name}`;
        }
      } catch (err: any) {
        result = `Error: ${err.message}`;
      }

      toolResults.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result
      });
    }

    messages.push(...toolResults);
  }

  if (stepCount >= maxSteps) {
    busComplete({ output: 'Reached maximum step limit', steps: stepCount });
  }
}

run().catch(err => {
  console.error(`Worker ${taskId} failed:`, err);
  busFail(err.message || 'Unknown error');
  process.exit(1);
});