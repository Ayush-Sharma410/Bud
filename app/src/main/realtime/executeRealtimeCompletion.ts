import { openai } from '@ai-sdk/openai';
import { streamText, stepCountIs } from 'ai';

export interface RealtimeCompletionOptions {
  messages: any[];
  system?: string;
  tools: Record<string, any>;
  model?: string;
  onTextChunk: (chunk: string) => void;
  onToolCall?: (toolCall: { name: string; input: any }) => void;
  onStepFinish?: (step: { toolCalls: Array<{ toolName: string; input: any }> }) => void;
}

export async function executeRealtimeCompletion(options: RealtimeCompletionOptions): Promise<string> {
  const modelName = options.model || process.env.OPENAI_MODEL || 'gpt-5.1';

  console.log(`🤖 Realtime completion starting with model: ${modelName}, messages: ${options.messages.length}`);

  const result = streamText({
    model: openai(modelName),
    messages: options.messages,
    system: options.system,
    tools: options.tools,
    stopWhen: stepCountIs(20),
    async onStepFinish({ toolCalls }) {
      if (toolCalls.length > 0) {
        const names = toolCalls.map(tc => tc.toolName).join(', ');
        console.log(`🤖 Realtime step finished — tools used: ${names}`);
        for (const tc of toolCalls) {
          options.onToolCall?.({ name: tc.toolName, input: (tc as any).input });
        }
        options.onStepFinish?.({ toolCalls: toolCalls as any });
      }
    },
  });

  let finalText = '';
  for await (const chunk of result.textStream) {
    finalText += chunk;
    options.onTextChunk(chunk);
  }

  console.log(`🤖 Realtime completion finished — ${finalText.length} chars`);
  return finalText;
}
