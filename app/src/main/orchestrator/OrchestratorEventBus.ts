/**
 * Bud — Orchestrator Event Bus
 *
 * Typed event emitter used by OrchestratorAgent to stream reasoning,
 * tool calls, tool results, text, TTS snippets, and lifecycle events
 * to the chat panel and voice manager.
 */

export interface ToolCallEvent {
  id: string;
  name: string;
  input: any;
}

export interface ToolResultEvent {
  id: string;
  success: boolean;
  result: any;
}

export interface ToolRetryEvent {
  id: string;
  attempt: number;
  reason: string;
}

export interface DoneEvent {
  finalText: string;
}

export interface ErrorEvent {
  message: string;
  code?: string;
}

export type OrchestratorEventMap = {
  reasoning: string;
  toolCall: ToolCallEvent;
  toolResult: ToolResultEvent;
  toolRetry: ToolRetryEvent;
  text: string;
  tts: string;
  done: DoneEvent;
  error: ErrorEvent;
};

export type OrchestratorEventName = keyof OrchestratorEventMap;
export type OrchestratorEventListener<T extends OrchestratorEventName> = (
  payload: OrchestratorEventMap[T]
) => void;

export class OrchestratorEventBus {
  private listeners: {
    [K in OrchestratorEventName]?: Array<OrchestratorEventListener<K>>;
  } = {};

  on<T extends OrchestratorEventName>(
    event: T,
    listener: OrchestratorEventListener<T>
  ): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(listener);

    return () => {
      const arr = this.listeners[event];
      if (arr) {
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  emit<T extends OrchestratorEventName>(
    event: T,
    payload: OrchestratorEventMap[T]
  ): void {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const listener of arr) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`Orchestrator event listener failed for ${event}:`, err);
      }
    }
  }

  once<T extends OrchestratorEventName>(
    event: T,
    listener: OrchestratorEventListener<T>
  ): void {
    const unsubscribe = this.on(event, ((payload: any) => {
      unsubscribe();
      listener(payload);
    }) as OrchestratorEventListener<T>);
  }
}
