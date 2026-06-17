import { RealtimeToolDefinition, RealtimeToolCall } from './realtimeTypes';

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any>;
}

export class RealtimeToolBridge {
  private tools: Map<string, ToolExecutor> = new Map();
  private pendingResults: Map<string, { resolve: (result: any) => void; reject: (err: Error) => void }> = new Map();

  registerTool(executor: ToolExecutor) {
    this.tools.set(executor.name, executor);
    console.log(`🔧 RealtimeToolBridge: registered "${executor.name}"`);
  }

  registerTools(executors: ToolExecutor[]) {
    for (const executor of executors) {
      this.registerTool(executor);
    }
  }

  getToolDefinitions(): RealtimeToolDefinition[] {
    const defs: RealtimeToolDefinition[] = [];

    for (const [name, executor] of this.tools) {
      defs.push({
        type: 'function',
        name: executor.name,
        description: executor.description,
        parameters: executor.parameters,
      });
    }

    return defs;
  }

  async executeToolCall(call: RealtimeToolCall): Promise<any> {
    const executor = this.tools.get(call.name);

    if (!executor) {
      console.error(`⚠️ RealtimeToolBridge: unknown tool "${call.name}"`);
      return { success: false, error: `Unknown tool: ${call.name}` };
    }

    try {
      const args = call.arguments ? JSON.parse(call.arguments) : {};
      console.log(`🔧 RealtimeToolBridge: executing "${call.name}" with args:`, JSON.stringify(args).substring(0, 200));

      const result = await executor.execute(args);
      console.log(`🔧 RealtimeToolBridge: "${call.name}" completed`);
      return result;
    } catch (err: any) {
      console.error(`⚠️ RealtimeToolBridge: "${call.name}" failed:`, err.message);
      return { success: false, error: err.message };
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
    this.pendingResults.clear();
  }
}
