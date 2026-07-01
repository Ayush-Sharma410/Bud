/**
 * Bud — LLM Provider
 *
 * Slim, cross-platform. OpenAI by default, or any OpenAI-compatible endpoint
 * via OPENAI_BASE_URL. The orchestrator + preamble models default from env.
 */
import { openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export function getDefaultModelName(): string {
  return process.env.OPENAI_MODEL || 'gpt-5.1';
}

export function getDefaultOrchestratorModelName(): string {
  return process.env.BUD_ORCHESTRATOR_MODEL || 'gpt-5.1';
}

export function getDefaultPreambleModelName(): string {
  return process.env.BUD_PREAMBLE_MODEL || 'gpt-4.1-mini';
}

export interface CreateLanguageModelOptions {
  /** Optional base URL override. If omitted, env OPENAI_BASE_URL is used. */
  baseURL?: string;
}

export function createLanguageModel(modelName: string, options: CreateLanguageModelOptions = {}) {
  const baseURL = options.baseURL || process.env.OPENAI_BASE_URL;

  if (baseURL) {
    const normalized = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`;
    console.log(`🤖 Using OpenAI-compatible provider with model: ${modelName} at ${normalized}`);
    const provider = createOpenAICompatible({ name: 'bud', baseURL: normalized });
    return provider(modelName);
  }

  console.log(`🤖 Using OpenAI provider with model: ${modelName}`);
  return openai(modelName);
}
