import { openai } from '@ai-sdk/openai';
import { groq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai';
import { FetchFunction } from '@ai-sdk/provider-utils';
import { createOllama } from 'ollama-ai-provider-v2';

export type LLMProvider = 'openai' | 'groq' | 'modal' | 'ollama';

function looksLikeGroqModel(modelName: string): boolean {
  return modelName.includes('/');
}

function looksLikeModalModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith('google/') ||
    normalized.includes('gemma') ||
    normalized.startsWith('qwen/') ||
    normalized.startsWith('deepseek-ai/')
  );
}

export function resolveLLMProvider(modelName: string): LLMProvider {
  const explicitProvider = process.env.LLM_PROVIDER;
  if (
    explicitProvider === 'openai' ||
    explicitProvider === 'groq' ||
    explicitProvider === 'modal' ||
    explicitProvider === 'ollama'
  ) {
    return explicitProvider;
  }
  if (looksLikeModalModel(modelName)) return 'modal';
  if (looksLikeGroqModel(modelName)) return 'groq';
  return 'ollama';
}

export function getDefaultModelName(provider: LLMProvider): string {
  switch (provider) {
    case 'ollama':
      return process.env.OLLAMA_MODEL || 'qwen3.6';
    case 'modal':
      return process.env.MODAL_LLM_MODEL || 'google/gemma-4-26B-A4B-it';
    case 'groq':
      return process.env.GROQ_MODEL || 'qwen/qwen3-32b';
    case 'openai':
    default:
      return process.env.OPENAI_MODEL || 'gpt-5.1';
  }
}

export function getDefaultOrchestratorModelName(): string {
  return process.env.BUD_ORCHESTRATOR_MODEL || 'gpt-5.1';
}

export function getDefaultPreambleModelName(): string {
  return process.env.BUD_PREAMBLE_MODEL || 'gpt-4.1-mini';
}

export interface StartupAwareFetchOptions {
  /** Max total time to keep retrying startup errors (ms). Default: 30 min. */
  maxWaitMs?: number;
  /** Initial retry delay (ms). Default: 5s. */
  baseDelayMs?: number;
  /** Max retry delay (ms). Default: 60s. */
  maxDelayMs?: number;
  /** HTTP status codes that indicate the server is still starting up. */
  startupStatuses?: number[];
}

/**
 * Creates a fetch wrapper that patiently retries while a Modal-deployed vLLM
 * server is cold-starting. Large models such as Qwen3-235B-A22B can take 20+
 * minutes to load, during which the Modal proxy returns 503/502/504. This
 * wrapper keeps polling until the server is ready or the max wait is exhausted.
 */
export function createStartupAwareFetch(
  options: StartupAwareFetchOptions = {}
): FetchFunction {
  const maxWaitMs =
    options.maxWaitMs ??
    (Number(process.env.MODAL_STARTUP_MAX_WAIT_MS) || 30 * 60 * 1000);
  const baseDelayMs =
    options.baseDelayMs ??
    (Number(process.env.MODAL_STARTUP_BASE_DELAY_MS) || 5_000);
  const maxDelayMs =
    options.maxDelayMs ??
    (Number(process.env.MODAL_STARTUP_MAX_DELAY_MS) || 60_000);
  const startupStatuses = new Set(
    options.startupStatuses ?? [502, 503, 504, 429]
  );

  return async (input, init) => {
    const startTime = Date.now();
    let attempt = 0;
    const signal = init?.signal;

    const abortError = () =>
      new DOMException('The operation was aborted.', 'AbortError');

    const waitWithAbort = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });

    while (true) {
      if (signal?.aborted) {
        throw abortError();
      }

      try {
        const response = await fetch(input, init);

        if (startupStatuses.has(response.status)) {
          const elapsed = Date.now() - startTime;

          if (elapsed >= maxWaitMs) {
            console.error(
              `[Modal] Server still returning ${response.status} after ${Math.round(
                elapsed / 1000
              )}s; giving up.`
            );
            return response;
          }

          const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
          attempt++;
          console.log(
            `[Modal] Server returned ${response.status} (cold start?), retrying in ${delay}ms... ` +
            `(attempt ${attempt}, elapsed ${Math.round(elapsed / 1000)}s)`
          );
          await waitWithAbort(delay);
          continue;
        }

        return response;
      } catch (err) {
        // AbortError should never be retried
        if ((err as Error)?.name === 'AbortError') {
          throw err;
        }

        const elapsed = Date.now() - startTime;

        if (elapsed >= maxWaitMs) {
          console.error(
            `[Modal] Request failed after ${Math.round(
              elapsed / 1000
            )}s; giving up.`,
            err
          );
          throw err;
        }

        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        attempt++;
        console.log(
          `[Modal] Request error (${(err as Error)?.message || err
          }), retrying in ${delay}ms... ` +
          `(attempt ${attempt}, elapsed ${Math.round(elapsed / 1000)}s)`
        );
        await waitWithAbort(delay);
      }
    }
  };
}

export interface CreateLanguageModelOptions {
  /** Optional base URL override. If omitted, env vars are used. */
  baseURL?: string;
  /** Optional sticky session ID. */
  sessionId?: string;
  /** Force a specific provider, bypassing model-name heuristics. */
  provider?: LLMProvider;
}

export function createLanguageModel(modelName: string, options: CreateLanguageModelOptions = {}) {
  const provider = options.provider || resolveLLMProvider(modelName);

  switch (provider) {
    case 'ollama': {
      const baseURL =
        options.baseURL ||
        process.env.OLLAMA_BASE_URL ||
        'http://localhost:11434/api';
      console.log(`🤖 Using Ollama provider with model: ${modelName} at ${baseURL}`);
      const ollamaProvider = createOllama({ baseURL });
      return wrapLanguageModel({
        model: ollamaProvider(modelName),
        middleware: [
          extractReasoningMiddleware({
            tagName: 'think',
            separator: '\n\n',
          }),
        ],
      });
    }
    case 'modal': {
      const baseURL =
        options.baseURL ||
        process.env.MODAL_ORCHESTRATOR_ENDPOINT ||
        process.env.MODAL_LLM_ENDPOINT ||
        process.env.MODAL_VLM_ENDPOINT ||
        'https://lautonomy--bud-vlm-serve-sglangserver.us-east.modal.direct/v1';
      const normalizedBaseURL = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`;

      console.log(`🤖 Using Modal provider with model: ${modelName} at ${normalizedBaseURL}`);
      const modalProvider = createOpenAICompatible({
        name: 'modal',
        baseURL: normalizedBaseURL,
        fetch: createStartupAwareFetch(),
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
