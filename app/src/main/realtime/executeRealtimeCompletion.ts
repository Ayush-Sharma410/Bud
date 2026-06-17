import { openai } from '@ai-sdk/openai';
import { groq } from '@ai-sdk/groq';
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

function looksLikeGroqModel(modelName: string): boolean {
  return modelName.includes('/');
}

function resolveProvider(modelName: string): 'groq' | 'openai' {
  const explicitProvider = process.env.LLM_PROVIDER;
  if (explicitProvider === 'groq' || explicitProvider === 'openai') {
    return explicitProvider;
  }
  return looksLikeGroqModel(modelName) ? 'groq' : 'openai';
}

function createModel(modelName: string) {
  const provider = resolveProvider(modelName);

  if (provider === 'groq') {
    console.log(`🤖 Using Groq provider with model: ${modelName}`);
    return groq(modelName);
  }

  console.log(`🤖 Using OpenAI provider with model: ${modelName}`);
  return openai(modelName);
}

export async function executeRealtimeCompletion(options: RealtimeCompletionOptions): Promise<string> {
  const explicitProvider = process.env.LLM_PROVIDER;
  const defaultModel = resolveProvider('') === 'groq' ? 'qwen/qwen3-32b' : 'gpt-5.1';
  const modelName = options.model || process.env.OPENAI_MODEL || process.env.GROQ_MODEL || defaultModel;
  const provider = resolveProvider(modelName);

  console.log(`🤖 Realtime completion starting with ${explicitProvider || provider}/${modelName}, messages: ${options.messages.length}`);

  const result = streamText({
    model: createModel(modelName),
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
