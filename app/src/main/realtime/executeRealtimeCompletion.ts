import { streamText, stepCountIs } from 'ai';
import { createLanguageModel, resolveLLMProvider, getDefaultModelName } from '../llmProvider';

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
  const explicitProvider = process.env.LLM_PROVIDER;
  const defaultModel = getDefaultModelName(resolveLLMProvider(explicitProvider || ''));
  const modelName = options.model || process.env.OLLAMA_MODEL || process.env.MODAL_LLM_MODEL || process.env.GROQ_MODEL || process.env.OPENAI_MODEL || defaultModel;
  const provider = resolveLLMProvider(modelName);

  console.log(`🤖 Realtime completion starting with ${explicitProvider || provider}/${modelName}, messages: ${options.messages.length}`);

  const result = streamText({
    model: createLanguageModel(modelName),
    messages: options.messages,
    system: options.system,
    tools: options.tools,
    stopWhen: stepCountIs(20),
    providerOptions: provider === 'ollama'
      ? { ollama: { think: process.env.OLLAMA_THINK === 'true' } }
      : undefined,
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
