/**
 * Bud — LLM Provider
 *
 * Resolves the orchestrator + preamble model names from env. Direct OpenAI
 * integration is handled at call sites via `@ai-sdk/openai`'s `openai()`.
 */
export function getDefaultOrchestratorModelName(): string {
  return process.env.BUD_ORCHESTRATOR_MODEL || 'gpt-5.1';
}

export function getDefaultPreambleModelName(): string {
  return process.env.BUD_PREAMBLE_MODEL || 'gpt-4.1-mini';
}
