import { tool, jsonSchema } from 'ai';
import fs from 'fs/promises';
import path from 'path';

/**
 * Factory — needs `memoryDir` (absolute path where memory JSON files are stored).
 * Typically: path.join(app.getPath('userData'), 'memory')
 */
export const createMemoryTool = (memoryDir: string) => {
  // Ensure directory exists on first call
  let dirReady = false;
  async function ensureDir() {
    if (dirReady) return;
    await fs.mkdir(memoryDir, { recursive: true });
    dirReady = true;
  }

  function filePath(key: string): string {
    // Sanitize key to prevent directory traversal
    const safe = key.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    return path.join(memoryDir, `${safe}.json`);
  }

  return tool({
    description: `**Memory Tool** — Long-term persistent memory using simple JSON files.

Stores and retrieves:
- User preferences & favorite apps
- Active projects (Ghostmark, Supervisual, Lautonomy, etc.)
- Recent work / daily habits
- Communication style
- Frequently used commands

Operations:
- "save" — Store data under a key (overwrites existing)
- "get" — Retrieve data by key
- "append" — Add data to an existing array (creates if missing)
- "search" — Scan all memory keys for a substring match

Critical for maintaining context across conversations and sessions.`,
    inputSchema: jsonSchema<{
      operation: string;
      key: string;
      data?: any;
      reason?: string;
    }>({
      type: 'object',
      properties: {
        operation: {
          description: 'Operation to perform: "save", "get", "append", or "search"',
          type: 'string',
          enum: ['save', 'get', 'append', 'search'],
        },
        key: { description: 'Memory key (e.g. activeProject, preferences, yesterdayWork, communicationStyle)', type: 'string' },
        data: { description: 'Data to store (object, array, or string) — required for save/append' },
        reason: { description: 'Why memory access is needed', type: 'string' },
      },
      required: ['operation', 'key'],
    }),
    execute: async ({ operation, key, data, reason }) => {
      console.log(`🛠️ Tool: memory.${operation}("${key}") — ${reason || 'no reason'}`);
      await ensureDir();

      try {
        switch (operation) {
          case 'save': {
            const record = { key, data, updatedAt: new Date().toISOString() };
            await fs.writeFile(filePath(key), JSON.stringify(record, null, 2), 'utf-8');
            return { success: true, operation, key, detail: `Saved to "${key}"` };
          }

          case 'get': {
            try {
              const raw = await fs.readFile(filePath(key), 'utf-8');
              const record = JSON.parse(raw);
              return { success: true, operation, key, data: record.data, updatedAt: record.updatedAt };
            } catch (err: any) {
              if (err.code === 'ENOENT') {
                return { success: false, operation, key, error: `No memory found for key "${key}"` };
              }
              throw err;
            }
          }

          case 'append': {
            let existing: any[] = [];
            try {
              const raw = await fs.readFile(filePath(key), 'utf-8');
              const record = JSON.parse(raw);
              existing = Array.isArray(record.data) ? record.data : [record.data];
            } catch {
              // File doesn't exist — start fresh
            }
            existing.push(data);
            const record = { key, data: existing, updatedAt: new Date().toISOString() };
            await fs.writeFile(filePath(key), JSON.stringify(record, null, 2), 'utf-8');
            return { success: true, operation, key, detail: `Appended to "${key}" (${existing.length} items)` };
          }

          case 'search': {
            const files = await fs.readdir(memoryDir);
            const matches: Array<{ key: string; preview: string }> = [];
            const searchTerm = key.toLowerCase();

            for (const file of files) {
              if (!file.endsWith('.json')) continue;
              try {
                const raw = await fs.readFile(path.join(memoryDir, file), 'utf-8');
                const record = JSON.parse(raw);
                const content = JSON.stringify(record).toLowerCase();
                if (content.includes(searchTerm) || file.toLowerCase().includes(searchTerm)) {
                  matches.push({
                    key: record.key || file.replace('.json', ''),
                    preview: JSON.stringify(record.data).substring(0, 150),
                  });
                }
              } catch {
                // Skip corrupt files
              }
            }
            return { success: true, operation, searchTerm: key, matches, total: matches.length };
          }

          default:
            return { success: false, operation, error: `Unknown operation: ${operation}` };
        }

      } catch (error: any) {
        console.error(`[Memory Tool] ${operation}("${key}") failed:`, error.message);
        return { success: false, operation, key, error: error.message };
      }
    },
  });
};
