/**
 * Bud — Orchestrator Agent
 *
 * Handles every voice/chat request with a two-model split:
 *  - Preamble (gpt-4.1-mini): fires a short engagement ack the instant a
 *    request arrives, so the user knows Bud is already moving.
 *  - Complex (gpt-5.1): handles tool calls and multi-step workflows, freed
 *    from having to produce the acknowledgment first.
 *
 * Both calls run concurrently with a shared AbortSignal. The preamble ack
 * is suppressed if the complex stream already emitted TTS (e.g. a direct
 * answer that needs no tool), avoiding double-speak.
 */

import { streamText, stepCountIs } from 'ai';
import {
  createLanguageModel,
  CreateLanguageModelOptions,
  getDefaultOrchestratorModelName,
  getDefaultPreambleModelName,
} from '../llmProvider';
import { OrchestratorEventBus } from './OrchestratorEventBus';
import { TTSMarkerParser } from './TTSMarkerParser';
import { enrichToolResult } from './ToolResultEnricher';
import { executeWithRetry } from './RetryToolExecutor';
import { PREAMBLE_SYSTEM_PROMPT } from './orchestratorPrompt';

export interface OrchestratorAgentOptions {
  /** Vercel AI SDK tool map. */
  tools: Record<string, any>;
  /** System prompt for the complex model. */
  system?: string;
  /** Complex model name (tool calls + workflows). Defaults via env or gpt-5.1. */
  model?: string;
  /** Preamble model name (engagement ack). Defaults via env or gpt-4.1-mini. */
  preambleModel?: string;
  /** System prompt for the preamble model. Defaults to PREAMBLE_SYSTEM_PROMPT. */
  preambleSystem?: string;
  /** Max tool-calling steps per run. */
  maxSteps?: number;
  /** Max retries for transient tool errors. */
  maxRetries?: number;
  /** Optional base URL override. */
  baseURL?: string;
}

export interface RunOptions {
  /** User request text. */
  request: string;
  /** AbortSignal to cancel the run. */
  signal?: AbortSignal;
}

export interface RunResult {
  finalText: string;
}

export class OrchestratorAgent {
  private tools: Record<string, any>;
  private system?: string;
  private model: string;
  private preambleModel: string;
  private preambleSystem: string;
  private maxSteps: number;
  private maxRetries: number;
  private baseURL?: string;
  private history: any[] = [];
  private eventBus = new OrchestratorEventBus();
  private running = false;

  constructor(options: OrchestratorAgentOptions) {
    this.tools = options.tools;
    this.system = options.system;
    this.model = options.model || getDefaultOrchestratorModelName();
    this.preambleModel = options.preambleModel || getDefaultPreambleModelName();
    this.preambleSystem = options.preambleSystem || PREAMBLE_SYSTEM_PROMPT;
    this.maxSteps = options.maxSteps ?? 30;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseURL = options.baseURL;
  }

  /** Expose the event bus so consumers can subscribe to reasoning/tool/text events. */
  get events(): OrchestratorEventBus {
    return this.eventBus;
  }

  /** Replace the tool map (used when tools are registered after construction). */
  setTools(tools: Record<string, any>) {
    this.tools = tools;
  }

  /** Replace or seed conversation history. */
  setHistory(messages: any[]) {
    this.history = messages.slice();
  }

  /** Get current conversation history. */
  getHistory(): any[] {
    return this.history.slice();
  }

  async run(options: RunOptions): Promise<RunResult> {
    if (this.running) {
      throw new Error('OrchestratorAgent is already running a foreground task');
    }
    this.running = true;

    this.history.push({ role: 'user', content: options.request });
    this.trimHistory();

    const ttsParser = new TTSMarkerParser();
    const toolCallMap = new Map<string, string>();
    const signal = options.signal;

    try {
      const modelOptions: CreateLanguageModelOptions = {};
      if (this.baseURL) modelOptions.baseURL = this.baseURL;

      // Decision from the preamble stream, resolved once we've seen the marker.
      type PreambleDecision =
        | { kind: 'reply'; text: string }
        | { kind: 'ack'; text: string }
        | { kind: 'pass' }
        | { kind: 'none' };
      const preambleDecision = new Promise<PreambleDecision>(async (resolve) => {
        const preambleMessages = this.history.slice(-2);
        const preambleResult = streamText({
          model: createLanguageModel(this.preambleModel),
          system: this.preambleSystem,
          messages: preambleMessages,
          tools: {},
          abortSignal: signal,
        });

        let preambleText = '';
        let decided = false;
        try {
          for await (const chunk of preambleResult.textStream) {
            preambleText += chunk;

            // Try to resolve the decision as soon as the closing marker lands.
            if (!decided) {
              const replyMatch = preambleText.match(/<REPLY>([\s\S]*?)<\/REPLY>/i);
              if (replyMatch) {
                decided = true;
                resolve({ kind: 'reply', text: replyMatch[1].trim() });
                continue; // keep draining the rest of the stream
              }
              const ackMatch = preambleText.match(/<ACK>([\s\S]*?)<\/ACK>/i);
              if (ackMatch) {
                decided = true;
                resolve({ kind: 'ack', text: ackMatch[1].trim() });
                continue;
              }
              const passMatch = preambleText.match(/<PASS>\s*$/i);
              if (passMatch) {
                decided = true;
                resolve({ kind: 'pass' });
                continue;
              }
            }
          }
          if (!decided) {
            resolve({ kind: 'none' });
          }
        } catch (err) {
          // If the preamble fails, fall through to the complex model.
          console.error('⚠️ Preamble stream failed, falling back:', (err as Error).message);
          resolve({ kind: 'none' });
        }
      });

      const decision = await preambleDecision;

      // Check abort between phases.
      if (signal?.aborted) {
        console.log('🗣️ OrchestratorAgent aborted during preamble');
        this.eventBus.emit('done', { finalText: '' });
        return { finalText: '' };
      }

      // --- REPLY: mini owns the answer, skip the complex model entirely ---
      if (decision.kind === 'reply' && decision.text) {
        this.eventBus.emit('text', decision.text);
        this.eventBus.emit('tts', decision.text);
        this.history.push({ role: 'assistant', content: decision.text });
        this.trimHistory();
        this.eventBus.emit('done', { finalText: decision.text });
        return { finalText: decision.text };
      }

      // --- ACK: speak the ack while the complex model works in parallel ---
      if (decision.kind === 'ack' && decision.text) {
        const ack = decision.text.slice(0, 60);
        if (ack) this.eventBus.emit('tts', ack);
      }

      // --- Complex call (gpt-5.1, tools, multi-step loop) ---
      const result = streamText({
        model: createLanguageModel(this.model, modelOptions),
        system: this.system,
        messages: this.history,
        tools: this.tools,
        toolChoice: 'auto',
        stopWhen: stepCountIs(this.maxSteps),
        abortSignal: signal,
        onStepFinish: async ({ toolCalls, toolResults, text }) => {
          for (const tc of toolCalls as any[]) {
            this.eventBus.emit('toolCall', {
              id: tc.toolCallId,
              name: tc.toolName,
              input: tc.args,
            });
            toolCallMap.set(tc.toolCallId, tc.toolName);
          }

          for (const tr of toolResults as any[]) {
            const toolName = toolCallMap.get(tr.toolCallId) || 'unknown';
            const enriched = await enrichToolResult(toolName, tr.result);
            this.eventBus.emit('toolResult', {
              id: tr.toolCallId,
              success: enriched.success,
              result: enriched,
            });
          }
        },
      });

      let complexHasSpoken = false;
      for await (const chunk of result.textStream) {
        const parsedChunks = ttsParser.push(chunk);
        for (const pc of parsedChunks) {
          if (pc.text) this.eventBus.emit('text', pc.text);
          if (pc.tts) {
            complexHasSpoken = true;
            this.eventBus.emit('tts', pc.tts);
          }
        }
      }

      const finalText = await result.text;
      const response = await result.response;

      const leftover = ttsParser.flush();
      if (leftover) {
        this.eventBus.emit('text', leftover);
      }

      // Complex call may have written a final answer outside <TTS> tags.
      // Don't double-speak if an ACK was already emitted.
      if (!complexHasSpoken && decision.kind !== 'ack' && finalText) {
        this.eventBus.emit('tts', finalText);
      }

      if (response.messages && response.messages.length > 0) {
        this.history.push(...(response.messages as any[]));
      } else {
        this.history.push({ role: 'assistant', content: finalText });
      }
      this.trimHistory();

      this.eventBus.emit('done', { finalText });
      return { finalText };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.log('🗣️ OrchestratorAgent run aborted');
        this.eventBus.emit('done', { finalText: '' });
        return { finalText: '' };
      }
      console.error('⚠️ OrchestratorAgent run failed:', err.message);
      this.eventBus.emit('error', {
        message: err.message || 'Orchestrator run failed',
        code: err.code,
      });
      throw err;
    } finally {
      this.running = false;
    }
  }

  private trimHistory(maxMessages = 40) {
    if (this.history.length > maxMessages) {
      // Keep system/first user message context if present, else just slide the window.
      const keepFirst = this.history.length > 0 && this.history[0].role === 'system' ? 1 : 0;
      const excess = this.history.length - maxMessages;
      this.history.splice(keepFirst, excess);
    }
  }

  /**
   * Wrap a Vercel AI SDK tools map with retry logic for transient errors.
   * Each retry emits a 'toolRetry' event on the supplied bus.
   */
  static wrapToolsWithRetry(
    tools: Record<string, any>,
    eventBus: OrchestratorEventBus,
    maxRetries = 3
  ): Record<string, any> {
    const wrapped: Record<string, any> = {};
    for (const [name, toolDef] of Object.entries(tools)) {
      const originalExecute = toolDef.execute;
      if (typeof originalExecute !== 'function') {
        wrapped[name] = toolDef;
        continue;
      }

      wrapped[name] = {
        ...toolDef,
        execute: async (args: any, options: any) => {
          return executeWithRetry(
            () => originalExecute(args, options),
            { maxRetries },
            (attempt, reason) => {
              eventBus.emit('toolRetry', {
                id: options?.toolCallId || name,
                attempt,
                reason,
              });
            }
          );
        },
      };
    }
    return wrapped;
  }
}
