import { openai } from '@ai-sdk/openai';
import { groq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai';

export type LLMProvider = 'openai' | 'groq' | 'modal';

function looksLikeGroqModel(modelName: string): boolean {
  return modelName.includes('/');
}

function looksLikeModalModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.startsWith('google/') || normalized.includes('gemma');
}

export function resolveLLMProvider(modelName: string): LLMProvider {
  const explicitProvider = process.env.LLM_PROVIDER;
  if (explicitProvider === 'openai' || explicitProvider === 'groq' || explicitProvider === 'modal') {
    return explicitProvider;
  }
  if (looksLikeModalModel(modelName)) return 'modal';
  if (looksLikeGroqModel(modelName)) return 'groq';
  return 'openai';
}

export function getDefaultModelName(provider: LLMProvider): string {
  switch (provider) {
    case 'modal':
      return process.env.MODAL_LLM_MODEL || 'google/gemma-4-26B-A4B-it';
    case 'groq':
      return process.env.GROQ_MODEL || 'qwen/qwen3-32b';
    case 'openai':
    default:
      return process.env.OPENAI_MODEL || 'gpt-5.1';
  }
}

export function createLanguageModel(modelName: string) {
  const provider = resolveLLMProvider(modelName);

  switch (provider) {
    case 'modal': {
      const baseURL = process.env.MODAL_LLM_ENDPOINT || process.env.MODAL_VLM_ENDPOINT || 'https://lautonomy--bud-vlm-serve-sglangserver.us-east.modal.direct/v1';
      const normalizedBaseURL = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`;

      console.log(`🤖 Using Modal provider with model: ${modelName} at ${normalizedBaseURL}`);
      const modalProvider = createOpenAICompatible({
        name: 'modal',
        baseURL: normalizedBaseURL,
        headers: {
          'Modal-Session-ID': `bud-${Math.random().toString(36).substring(2, 15)}`,
        },
      });

      return wrapLanguageModel({
        model: modalProvider(modelName),
        middleware: [
          extractReasoningMiddleware({
            tagName: 'think',
            separator: '\n\n',
          }),
        ],
      });
    }
    case 'groq':
      console.log(`🤖 Using Groq provider with model: ${modelName}`);
      return groq(modelName);
    case 'openai':
    default:
      console.log(`🤖 Using OpenAI provider with model: ${modelName}`);
      return openai(modelName);
  }
}
