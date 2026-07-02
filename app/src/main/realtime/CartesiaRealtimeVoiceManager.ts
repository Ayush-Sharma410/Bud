import { EventEmitter } from 'events';
import { tool, jsonSchema } from 'ai';
import { CartesiaSTTSession } from './CartesiaSTTSession';
import { CartesiaTTSSession } from './CartesiaTTSSession';
import { RealtimeToolBridge, ToolExecutor } from './RealtimeToolBridge';
import {
  CartesiaConfig,
  CartesiaVoiceState,
  CARTESIA_DEFAULTS,
} from './cartesiaTypes';
import {
  OrchestratorAgent,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from '../orchestrator';

/**
 * Decouples the voice manager from any specific BrowserWindow. The main
 * process implements this to route voice state + events to the pill/panel.
 */
export interface UISink {
  sendState(state: CartesiaVoiceState): void;
  sendToUI(channel: string, data: any): void;
}

export interface CartesiaRealtimeVoiceManagerOptions {
  config: Partial<CartesiaConfig>;
  uiSink: UISink;
  onFallbackTriggered?: (reason: string) => void;
  systemPrompt?: string;
}

export class CartesiaRealtimeVoiceManager extends EventEmitter {
  private stt: CartesiaSTTSession;
  private tts: CartesiaTTSSession;
  private toolBridge: RealtimeToolBridge;
  private uiSink: UISink;
  private onFallbackTriggered?: (reason: string) => void;
  private systemPrompt: string;

  private config: CartesiaConfig;
  private voiceState: CartesiaVoiceState = 'idle';
  private isListening = false;
  private isResponseActive = false;
  // True while TTS audio is being delivered/played. The orchestrator finishes
  // ('done') before the audio finishes playing, so isResponseActive alone can't
  // gate interruption — without this flag, speaking during playback wouldn't
  // cancel playback because turn.start saw isResponseActive=false. Kept true
  // from the first tts event until audio.done/flush.done for the context.
  private isSpeaking = false;
  private pendingToolCalls = 0;
  private ttsContextId: string | null = null;
  // Whether any TTS text was sent on the current context. The final flush is
  // only valid when there is buffered content to flush; flushing an empty
  // context triggers Cartesia's "No valid transcripts passed" error.
  private ttsSentThisTurn = false;
  // Timestamp of the last interruption. Used to suppress the expected TTS
  // "context ID does not exist" error that Cartesia returns when a send lands
  // on a context we just cancelled — the error often arrives without a
  // context_id, so the cancelled-set check alone isn't enough.
  private lastInterruptedAt = 0;
  private responseTextBuffer = '';
  private reconnectFallbackTriggered = false;
  private orchestrator: OrchestratorAgent;
  private turnAbortController: AbortController | null = null;
  // Context ids whose audio output has been cancelled by an interruption.
  // In-flight chunks arriving for these after cancelContext() must be dropped
  // so the renderer doesn't keep playing the interrupted response.
  private cancelledContextIds = new Set<string>();

  constructor(options: CartesiaRealtimeVoiceManagerOptions) {
    super();
    this.config = { ...CARTESIA_DEFAULTS, ...options.config };
    this.systemPrompt = options.systemPrompt || ORCHESTRATOR_SYSTEM_PROMPT;

    this.stt = new CartesiaSTTSession(this.config);
    this.tts = new CartesiaTTSSession(this.config);
    this.toolBridge = new RealtimeToolBridge();
    this.uiSink = options.uiSink;
    this.onFallbackTriggered = options.onFallbackTriggered;

    this.orchestrator = new OrchestratorAgent({
      tools: {},
      system: this.systemPrompt,
    });
    this.setupOrchestratorEventHandlers();

    this.setupSTTHandlers();
    this.setupTTSHandlers();
  }

  private setupOrchestratorEventHandlers() {
    const bus = this.orchestrator.events;

    bus.on('text', (chunk) => {
      this.responseTextBuffer += chunk;
      this.emitToUI('realtime-response-chunk', chunk);
    });

    bus.on('tts', (text) => {
      if (!this.ttsContextId) return;
      // Stream with continue=true so the context stays open across the ACK and
      // the complex model's answer. Sending continue=false after the ACK would
      // finalize the context and make every later send (and the final flush)
      // fail with "No valid transcripts passed". The context is flushed once,
      // on 'done'.
      this.ttsSentThisTurn = true;
      this.isSpeaking = true;
      this.setVoiceState('responding');
      this.tts.sendText(text, this.ttsContextId, true);
    });

    bus.on('toolCall', ({ id, name, input }) => {
      this.pendingToolCalls++;
      console.log(`🔧 Tool call: ${name} (${id})`);
      // While tools are running we are "thinking", not "speaking" — even if an
      // ACK was just spoken. Keep the pill honest about what Bud is doing.
      this.setVoiceState('processing');
      this.emitToUI('realtime-tool-call', { id, name, input });
      this.emit('tool.call', { name, input });
    });

    bus.on('toolResult', ({ id, success, result }) => {
      this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
      this.emitToUI('realtime-tool-result', { id, success, result });
      // If all tools finished but the orchestrator is still composing its final
      // answer, we are back to thinking. If it already spoke, the next tts event
      // will flip us to responding.
      if (this.pendingToolCalls === 0 && this.isResponseActive) {
        this.setVoiceState('processing');
      }
    });

    bus.on('toolRetry', ({ id, attempt, reason }) => {
      console.log(`🔧 Tool retry ${attempt} for ${id}: ${reason}`);
      this.emitToUI('realtime-tool-retry', { id, attempt, reason });
    });

    bus.on('done', ({ finalText }) => {
      this.isResponseActive = false;
      // Only flush if we still own a live TTS context AND we actually streamed
      // text onto it. After an interruption ttsContextId is null and the
      // context was cancelled — flushing null would send an invalid request.
      // Flushing a context that received no transcript likewise errors.
      if (this.ttsContextId && this.ttsSentThisTurn) {
        this.tts.flushContext(this.ttsContextId);
        // isSpeaking stays true: audio.done / flush.done will clear it and flip
        // the pill to idle once playback actually finishes. This keeps voice
        // interruption able to cancel playback during the post-done buffer.
      } else {
        // No TTS this turn — nothing will emit audio.done, so settle now.
        this.isSpeaking = false;
        if (this.pendingToolCalls === 0) {
          this.setVoiceState('idle');
        }
      }
      this.ttsSentThisTurn = false;
      this.emitToUI('realtime-response-text', finalText);
      this.emitToUI('realtime-response-done', {});
    });

    bus.on('error', ({ message }) => {
      console.error('⚠️ Orchestrator error:', message);
      this.isResponseActive = false;
      this.speakError('Sorry, I had trouble thinking that through.');
    });
  }

  private setupSTTHandlers() {
    this.stt.on('stateChange', (state) => {
      console.log(`🎙️ Cartesia STT state: ${state}`);
      if (state === 'failed') {
        this.triggerFallback('Cartesia STT connection failed');
      }
    });

    this.stt.on('turn.start', () => {
      console.log('🎤 Speech detected');
      this.setVoiceState('speech-detected');
      this.emit('speech.started');
      this.emitToUI('realtime-turn-start', {});

      // Only interrupt if Bud is actually producing output the user can hear
      // or is mid-tool. We deliberately do NOT interrupt on isResponseActive
      // alone: right after turn.end the orchestrator may have just started
      // (preamble running, no audio yet, no tools). A stray turn.start ~400ms
      // later (continuation / echo / noise) would otherwise abort that fresh
      // response before it ever speaks, losing the user's first utterance.
      if (this.isSpeaking || this.pendingToolCalls > 0) {
        console.log('🎤 User interrupted — stopping playback');
        this.handleInterruption();
      }
    });

    this.stt.on('turn.update', (event: { transcript: string }) => {
      this.emitToUI('realtime-transcript', event.transcript);
    });

    this.stt.on('turn.end', (event: { transcript: string }) => {
      console.log(`🗣️ User transcript: "${event.transcript}"`);
      this.setVoiceState('processing');
      this.emitToUI('realtime-transcript', event.transcript);
      this.handleUserTurn(event.transcript);
    });

    this.stt.on('error', (err: Error) => {
      console.error('⚠️ Cartesia STT error:', err.message);
    });

    this.stt.on('reconnectFailed', () => {
      this.triggerFallback('Cartesia STT reconnection failed');
    });
  }

  private setupTTSHandlers() {
    this.tts.on('stateChange', (state) => {
      console.log(`🔊 Cartesia TTS state: ${state}`);
      if (state === 'failed') {
        this.triggerFallback('Cartesia TTS connection failed');
      }
    });

    this.tts.on('audio.delta', (event: { contextId: string; base64Audio: string; done: boolean }) => {
      // Drop audio for contexts that were cancelled by an interruption.
      // Cartesia may still deliver a few chunks that were already in flight
      // before cancelContext() took effect — forwarding them would make the
      // renderer resume playback after stopPlayback(), defeating interruption.
      if (event.contextId && this.cancelledContextIds.has(event.contextId)) {
        return;
      }
      this.emitToRenderer('cartesia-tts-audio', {
        contextId: event.contextId,
        base64Audio: event.base64Audio,
        done: event.done,
      });
    });

    this.tts.on('audio.done', (event?: { contextId?: string }) => {
      // Ignore audio.done for cancelled contexts for the same reason as above.
      if (event?.contextId && this.cancelledContextIds.has(event.contextId)) {
        return;
      }
      this.isSpeaking = false;
      if (!this.isResponseActive && this.pendingToolCalls === 0) {
        this.setVoiceState('idle');
        this.emitToUI('realtime-response-done', {});
      }
    });

    // Cartesia may signal the end of a flushed context via flush_done instead
    // of (or in addition to) a chunk with done=true. Treat it as the same
    // "playback finished" signal so the pill doesn't get stuck in responding.
    this.tts.on('flush.done', (event: { context_id?: string }) => {
      if (event?.context_id && this.cancelledContextIds.has(event.context_id)) {
        return;
      }
      this.isSpeaking = false;
      if (!this.isResponseActive && this.pendingToolCalls === 0) {
        this.setVoiceState('idle');
        this.emitToUI('realtime-response-done', {});
      }
    });

    this.tts.on('error', (event: { context_id?: string; message?: string } | Error) => {
      // Cartesia returns "context ID does not exist or may have already been
      // cancelled" when a send/flush lands on a context we just cancelled via
      // interruption. That's expected — drop it silently. The error frequently
      // arrives without a context_id, so also suppress any TTS error within a
      // short window after an interruption.
      const ctxId = (event as any)?.context_id;
      if (ctxId && this.cancelledContextIds.has(ctxId)) {
        return;
      }
      if (Date.now() - this.lastInterruptedAt < 1500) {
        return;
      }
      const message = (event as any)?.message ?? String(event);
      console.error('⚠️ Cartesia TTS error:', message);
    });

    this.tts.on('reconnectFailed', () => {
      this.triggerFallback('Cartesia TTS reconnection failed');
    });
  }

  private async handleUserTurn(transcript: string) {
    if (!this.isListening) {
      // Stale turn arrived after listening ended (e.g. right after Escape or
      // PTT release). Ignore it so we don't respond to audio we weren't meant
      // to capture.
      console.log('🗣️ Ignoring turn — not listening');
      return;
    }
    if (this.isResponseActive) {
      console.log('🗣️ Ignoring duplicate turn while response already active');
      return;
    }

    this.isResponseActive = true;
    this.isSpeaking = false;
    this.responseTextBuffer = '';
    this.ttsSentThisTurn = false;
    this.cancelledContextIds.clear();
    this.ttsContextId = this.tts.startContext();
    this.turnAbortController = new AbortController();

    try {
      await this.orchestrator.run({ request: transcript, signal: this.turnAbortController.signal });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.log('🗣️ Orchestrator turn aborted by interruption');
        return;
      }
      console.error('⚠️ Orchestrator turn failed:', err.message);
      this.isResponseActive = false;
      this.speakError('Sorry, I had trouble thinking that through.');
    }
  }

  private buildVercelTools(): Record<string, any> {
    const tools: Record<string, any> = {};
    const executors = this.toolBridge.getToolExecutors();

    for (const executor of executors) {
      tools[executor.name] = tool({
        description: executor.description,
        inputSchema: jsonSchema(executor.parameters),
        execute: async (args: any) => executor.execute(args),
      });
    }

    return tools;
  }

  private handleInterruption() {
    this.isResponseActive = false;
    this.isSpeaking = false;
    this.responseTextBuffer = '';
    this.lastInterruptedAt = Date.now();

    if (this.turnAbortController) {
      this.turnAbortController.abort();
      this.turnAbortController = null;
    }

    if (this.ttsContextId) {
      // Remember this context so in-flight audio chunks that arrive after the
      // cancel are dropped instead of being forwarded to the renderer.
      this.cancelledContextIds.add(this.ttsContextId);
      this.tts.cancelContext(this.ttsContextId);
      this.ttsContextId = null;
    }

    this.emitToRenderer('cartesia-tts-stop', {});
    this.emitToUI('interruption', {});
    this.emit('interruption');
  }

  private speakError(text: string) {
    this.ttsContextId = this.tts.startContext();
    this.isSpeaking = true;
    this.tts.sendText(text, this.ttsContextId, false);
    this.emitToUI('realtime-response-text', text);
  }

  private setVoiceState(state: CartesiaVoiceState) {
    if (this.voiceState === state) return;
    this.voiceState = state;
    console.log(`🎙️ Cartesia voice state: ${state}`);
    this.uiSink.sendState(state);
    this.uiSink.sendToUI('state-change', state);
  }

  private emitToUI(channel: string, data: any) {
    this.uiSink.sendToUI(channel, data);
  }

  private emitToRenderer(channel: string, data: any) {
    this.uiSink.sendToUI(channel, data);
  }

  private triggerFallback(reason: string) {
    if (this.reconnectFallbackTriggered) return;
    this.reconnectFallbackTriggered = true;
    console.log(`⚠️ Triggering Cartesia fallback: ${reason}`);
    this.setVoiceState('fallback');
    this.onFallbackTriggered?.(reason);
  }

  // Public API

  registerTools(executors: ToolExecutor[]) {
    this.toolBridge.registerTools(executors);
    const vercelTools = this.buildVercelTools();
    const wrapped = OrchestratorAgent.wrapToolsWithRetry(vercelTools, this.orchestrator.events, 3);
    this.orchestrator.setTools(wrapped);
  }

  start() {
    console.log('🚀 Starting CartesiaRealtimeVoiceManager');
    // Connect STT/TTS up front so mode switches have no reconnect latency.
    // Mic capture is NOT started here — it is driven by setListening() from
    // VoiceInputManager (idle by default).
    this.stt.connect();
    this.tts.connect();
  }

  stop() {
    console.log('🛑 Stopping CartesiaRealtimeVoiceManager');
    this.stt.disconnect();
    this.tts.disconnect();
    this.emitToRenderer('cartesia-stop-capture', {});
    this.setVoiceState('idle');
  }

  /**
   * Turn the mic on/off. Driven by VoiceInputManager (PTT hold / always-on /
   * Escape). Emits capture start/stop to the renderer; the STT WebSocket stays
   * connected across toggles — only the PCM flow is gated.
   */
  setListening(listening: boolean): void {
    this.isListening = listening;
    console.log(`🎙️ Listening ${listening ? 'enabled' : 'disabled'}`);

    if (listening) {
      this.emitToRenderer('cartesia-start-capture', {});
      if (this.stt.getState() !== 'connected') {
        this.stt.connect();
      }
      // Show "listening" only when idle; don't clobber an active response.
      if (this.voiceState === 'idle') {
        this.setVoiceState('listening');
      }
    } else {
      this.emitToRenderer('cartesia-stop-capture', {});
      // Don't flip to idle if Bud is still speaking or thinking — releasing the
      // mic (PTT) or exiting always-on (Escape) must only stop capture, not
      // disturb an in-progress response.
      if (!this.isResponseActive && !this.isSpeaking && this.pendingToolCalls === 0) {
        this.setVoiceState('idle');
      }
    }
  }

  getListening(): boolean {
    return this.isListening;
  }

  /**
   * Public entry to the interruption path (Escape). Aborts the orchestrator
   * turn, cancels the TTS context, and drops in-flight audio.
   */
  interrupt(): void {
    this.handleInterruption();
  }

  getVoiceState(): CartesiaVoiceState {
    return this.voiceState;
  }

  isConnected(): boolean {
    return this.stt.getState() === 'connected' && this.tts.getState() === 'connected';
  }

  handleAudioChunk(base64PCM: string) {
    if (!this.isListening) return;
    const buffer = Buffer.from(base64PCM, 'base64');
    this.stt.sendAudioChunk(buffer);
  }

  injectContext(text: string) {
    if (!text) return;
    const history = this.orchestrator.getHistory();
    history.push({ role: 'user', content: text });
    this.orchestrator.setHistory(history);
  }

  destroy() {
    this.stop();
    this.stt.destroy();
    this.tts.destroy();
    this.toolBridge.clear();
    this.removeAllListeners();
  }
}
