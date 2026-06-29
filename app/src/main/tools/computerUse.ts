import { tool, jsonSchema } from 'ai';
import { AgentManager } from '../agentManager';
import { ScreenCapture } from '../screenCapture';

const GUI_ACTIONS = ['click', 'doubleClick', 'rightClick', 'type', 'press', 'scroll'];

async function captureScreenshotBase64(): Promise<string | null> {
  try {
    const captures = await ScreenCapture.captureAllScreens();
    if (captures && captures.length > 0) return captures[0].imageBase64;
  } catch (err) {
    console.warn('⚠️ computerUse: post-action screenshot failed:', err);
  }
  return null;
}

export const createComputerUseTool = (agentManager: AgentManager) => tool({
  description: 'Execute a desktop action on the Windows machine. Supports: shell commands (PowerShell), mouse clicks, keyboard input, scrolling, waiting, and screenshots. Shell commands return stdout/stderr. After execution actions, the system auto-captures a screenshot for verification.',
  inputSchema: jsonSchema<{
    action: string;
    command?: string;
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    direction?: 'up' | 'down';
    amount?: number;
    ms?: number;
    label: string;
  }>({
    type: 'object',
    properties: {
      action: { type: 'string', description: 'The type of desktop action to perform', enum: ['shell', 'click', 'doubleClick', 'rightClick', 'type', 'press', 'scroll', 'wait', 'screenshot'] },
      command: { type: 'string', description: 'PowerShell command (for action=shell)' },
      x: { type: 'number', description: 'X coordinate in pixels (for click/doubleClick/rightClick/scroll)' },
      y: { type: 'number', description: 'Y coordinate in pixels (for click/doubleClick/rightClick/scroll)' },
      text: { type: 'string', description: 'Text to type (for action=type)' },
      key: { type: 'string', description: 'Keyboard shortcut e.g. Ctrl+L, Alt+Tab, Enter (for action=press)' },
      direction: { type: 'string', description: 'Scroll direction (for action=scroll)', enum: ['up', 'down'] },
      amount: { type: 'number', description: 'Scroll steps (for action=scroll)' },
      ms: { type: 'number', description: 'Milliseconds to wait (for action=wait)' },
      label: { type: 'string', description: 'Short description of what this action does and why' }
    },
    required: ['action', 'label']
  }),
  execute: async (args) => {
    const { action, label } = args;
    console.log(`🛠️ Tool: computerUse.${action} — ${label}`);

    switch (action) {
      case 'shell': {
        const command = args.command || '';
        const result = await agentManager.actionQueue.enqueue(
          () => agentManager.actionExecutor.execute({ type: 'shell', command, label })
        );
        const shellResult = result as { stdout?: string; stderr?: string } | undefined;
        return {
          success: true,
          stdout: shellResult?.stdout || '',
          stderr: shellResult?.stderr || '',
          detail: `Executed shell: ${label}`
        };
      }
      case 'click': {
        await agentManager.actionQueue.enqueue(
          () => agentManager.actionExecutor.execute({ type: 'click', x: args.x || 0, y: args.y || 0, label })
        );
        const imageBase64 = await captureScreenshotBase64();
        return { success: true, detail: `Clicked at (${args.x}, ${args.y}): ${label}`, imageBase64 };
      }
      case 'doubleClick': {
        await agentManager.actionQueue.enqueue(
          () => agentManager.actionExecutor.execute({ type: 'double_click', x: args.x || 0, y: args.y || 0, label })
        );
        const imageBase64 = await captureScreenshotBase64();
        return { success: true, detail: `Double clicked at (${args.x}, ${args.y}): ${label}`, imageBase64 };
      }
      case 'rightClick': {
        await agentManager.actionQueue.enqueue(
          () => agentManager.actionExecutor.execute({ type: 'right_click', x: args.x || 0, y: args.y || 0, label })
        );
        const imageBase64 = await captureScreenshotBase64();
        return { success: true, detail: `Right clicked at (${args.x}, ${args.y}): ${label}`, imageBase64 };
      }
      case 'type': {
        await agentManager.actionQueue.enqueue(
          () => agentManager.actionExecutor.execute({ type: 'type', text: args.text || '', label })
        );
        const imageBase64 = await captureScreenshotBase64();
        return { success: true, detail: `Typed "${args.text}": ${label}`, imageBase64 };
      }
      case 'press': {
        await agentManager.actionQueue.enqueue(
          () => agentManager.actionExecutor.execute({ type: 'press', key: args.key || '', label })
        );
        const imageBase64 = await captureScreenshotBase64();
        return { success: true, detail: `Pressed "${args.key}": ${label}`, imageBase64 };
      }
      case 'scroll': {
        await agentManager.actionQueue.enqueue(
          () => agentManager.actionExecutor.execute({
            type: 'scroll', x: args.x || 0, y: args.y || 0,
            direction: args.direction || 'down', amount: args.amount || 3, label
          })
        );
        const imageBase64 = await captureScreenshotBase64();
        return { success: true, detail: `Scrolled ${args.direction} at (${args.x}, ${args.y}): ${label}`, imageBase64 };
      }
      case 'wait': {
        const waitMs = args.ms || 1000;
        await new Promise(r => setTimeout(r, waitMs));
        return { success: true, detail: `Waited ${waitMs}ms: ${label}` };
      }
      case 'screenshot': {
        const imageBase64 = await captureScreenshotBase64();
        if (imageBase64) {
          return { success: true, detail: `Screenshot captured.`, imageBase64 };
        }
        return { success: false, error: 'No screenshot captured' };
      }
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
  toModelOutput: ({ output }) => {
    const result = output as any;
    const detail = result?.detail || result?.error || JSON.stringify(result);
    if (result?.imageBase64) {
      return {
        type: 'content' as const,
        value: [
          { type: 'text' as const, text: detail },
          { type: 'image-data' as const, data: result.imageBase64, mediaType: 'image/jpeg' },
        ],
      };
    }
    if (result?.stdout !== undefined) {
      return { type: 'text' as const, value: `${detail}\nstdout: ${result.stdout}\nstderr: ${result.stderr}` };
    }
    return { type: 'text' as const, value: detail };
  },
});
