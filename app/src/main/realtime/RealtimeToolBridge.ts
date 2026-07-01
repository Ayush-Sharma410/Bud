/**
 * Bud — Realtime Tool Bridge
 *
 * Registry of ToolExecutors shared by the Cartesia voice manager and the chat
 * orchestrator. The orchestrator builds Vercel AI SDK tools from the registered
 * executors via getToolExecutors(); it does not call executeToolCall() directly
 * (that was the OpenAI Realtime path, now removed).
 */

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any>;
}

export class RealtimeToolBridge {
  private tools: Map<string, ToolExecutor> = new Map();

  registerTool(executor: ToolExecutor) {
    this.tools.set(executor.name, executor);
    console.log(`🔧 RealtimeToolBridge: registered "${executor.name}"`);
  }

  registerTools(executors: ToolExecutor[]) {
    for (const executor of executors) {
      this.registerTool(executor);
    }
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolExecutors(): ToolExecutor[] {
    return Array.from(this.tools.values());
  }

  clear() {
    this.tools.clear();
  }
}
