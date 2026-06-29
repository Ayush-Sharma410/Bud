import { BrowserWindow, nativeImage } from 'electron';
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

export interface CartesiaRealtimeVoiceManagerOptions {
  config: Partial<CartesiaConfig>;
  overlayManager: {
    sendToOverlay: (channel: string, data: any) => void;
    getWindow: () => BrowserWindow | null;
  };
  panelWindow: () => BrowserWindow | null;
  onFallbackTriggered?: (reason: string) => void;
  systemPrompt?: string;
}

export class CartesiaRealtimeVoiceManager extends EventEmitter {
  private stt: CartesiaSTTSession;
  private tts: CartesiaTTSSession;
  private toolBridge: RealtimeToolBridge;
  private overlayManager: CartesiaRealtimeVoiceManagerOptions['overlayManager'];
  private panelWindow: () => BrowserWindow | null;
  private onFallbackTriggered?: (reason: string) => void;
  private systemPrompt: string;

  private config: CartesiaConfig;
  private voiceState: CartesiaVoiceState = 'idle';
  private isMuted = false;
  private isResponseActive = false;
  private pendingToolCalls = 0;
  private ttsContextId: string | null = null;
  private responseTextBuffer = '';
  private reconnectFallbackTriggered = false;
  private orchestrator: OrchestratorAgent;
  private turnAbortController: AbortController | null = null;

  constructor(options: CartesiaRealtimeVoiceManagerOptions) {
    super();
    this.config = { ...CARTESIA_DEFAULTS, ...options.config };
    this.systemPrompt = options.systemPrompt || ORCHESTRATOR_SYSTEM_PROMPT;

    this.stt = new CartesiaSTTSession(this.config);
    this.tts = new CartesiaTTSSession(this.config);
    this.toolBridge = new RealtimeToolBridge();
    this.overlayManager = options.overlayManager;
    this.panelWindow = options.panelWindow;
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
      this.setVoiceState('responding');
      this.tts.sendText(text, this.ttsContextId, false);
    });

    bus.on('toolCall', ({ id, name, input }) => {
      this.pendingToolCalls++;
      console.log(`🔧 Tool call: ${name} (${id})`);
      this.emitToUI('realtime-tool-call', { id, name, input });
      this.emit('tool.call', { name, input });
    });

    bus.on('toolResult', ({ id, success, result }) => {
      this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
      const stripped = this.stripImageData(result);
      this.emitToUI('realtime-tool-result', {
        id,
        success,
        result: stripped,
      });
    });

    bus.on('toolRetry', ({ id, attempt, reason }) => {
      console.log(`🔧 Tool retry ${attempt} for ${id}: ${reason}`);
      this.emitToUI('realtime-tool-retry', { id, attempt, reason });
    });

    bus.on('done', ({ finalText }) => {
      this.isResponseActive = false;
      this.tts.flushContext(this.ttsContextId!);
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

      if (this.isResponseActive || this.pendingToolCalls > 0) {
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
      // Audio playback is handled by the panel renderer; do not duplicate via emitToUI.
      this.emitToRenderer('cartesia-tts-audio', {
        contextId: event.contextId,
        base64Audio: event.base64Audio,
        done: event.done,
      });
    });

    this.tts.on('audio.done', () => {
      if (!this.isResponseActive && this.pendingToolCalls === 0) {
        this.setVoiceState('idle');
        this.emitToUI('realtime-response-done', {});
      }
    });

    this.tts.on('error', (err: Error) => {
      console.error('⚠️ Cartesia TTS error:', err.message);
    });

    this.tts.on('reconnectFailed', () => {
      this.triggerFallback('Cartesia TTS reconnection failed');
    });
  }

  private async handleUserTurn(transcript: string) {
    if (this.isResponseActive) {
      console.log('🗣️ Ignoring duplicate turn while response already active');
      return;
    }

    this.isResponseActive = true;
    this.responseTextBuffer = '';
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
        execute: async (args: any) => {
          const result = await executor.execute(args);

          // Normalize image payloads for Vercel AI SDK multi-modal tool results.
          const normalized = this.normalizeToolResult(result);

          // Keep the original result for the orchestrator history; images are
          // included inside normalized content arrays.
          return normalized;
        },
      });
    }

    return tools;
  }

  private normalizeToolResult(result: any): any {
    if (!result || typeof result !== 'object') return result;

    // If the tool already returned Vercel-compatible content parts, pass through.
    if (Array.isArray(result)) {
      return result.map((item) => this.normalizeToolResult(item));
    }

    // Handle { content: [...] } shape used by some tools.
    if (Array.isArray(result.content)) {
      return {
        ...result,
        content: result.content.map((item: any) => {
          if (item?.type === 'image' && item.data) {
            const resized = this.resizeBase64Image(item.data, item.mimeType || 'image/jpeg');
            return {
              type: 'image',
              image: `data:${item.mimeType || 'image/jpeg'};base64,${resized}`,
            };
          }
          if (item?.type === 'image' && item.image) {
            const match = item.image.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const resized = this.resizeBase64Image(match[2], match[1]);
              return { type: 'image', image: `data:${match[1]};base64,${resized}` };
            }
            return item;
          }
          if (item?.type === 'text' && item.text) {
            return { type: 'text', text: item.text };
          }
          return item;
        }),
      };
    }

    // Handle captureScreen's { screens: [{ imageBase64, width, height, ... }] } shape.
    // Preserves width/height metadata (original physical pixels) so the model can
    // return annotation coordinates in original screenshot pixel space, while the
    // image itself is downscaled for context-window efficiency.
    if (Array.isArray(result.screens)) {
      return {
        ...result,
        screens: result.screens.map((screen: any) => {
          if (screen?.imageBase64) {
            const resized = this.resizeBase64Image(screen.imageBase64, 'image/jpeg');
            return { ...screen, imageBase64: undefined, content: [
              { type: 'text', text: `Screen ${screen.screenIndex}: ${screen.width}x${screen.height} (coordinates in original ${screen.width}x${screen.height} pixel space)` },
              { type: 'image', image: `data:image/jpeg;base64,${resized}` },
            ] };
          }
          return screen;
        }),
      };
    }

    // Handle top-level image fields.
    if (result.imageBase64 || result.image?.data) {
      const data = result.imageBase64 || result.image?.data;
      const mimeType = result.mimeType || result.image?.mimeType || 'image/jpeg';
      const resized = this.resizeBase64Image(data, mimeType);
      return {
        ...result,
        content: [
          { type: 'text', text: result.detail || 'Image captured.' },
          { type: 'image', image: `data:${mimeType};base64,${resized}` },
        ],
      };
    }

    return result;
  }

  private resizeBase64Image(base64Data: string, _mimeType: string, maxDim = 1280, quality = 60): string {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(base64Data, 'base64'));
      if (img.isEmpty()) return base64Data;

      const size = img.getSize();
      const scale = Math.min(1, maxDim / Math.max(size.width, size.height));
      const resized = scale < 1
        ? img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
        : img;

      return resized.toJPEG(quality).toString('base64');
    } catch (err) {
      console.error('⚠️ Failed to resize tool image:', err);
      return base64Data;
    }
  }

  private stripImageData(result: any): any {
    if (!result || typeof result !== 'object') return result;
    if (Array.isArray(result)) return result.map(item => this.stripImageData(item));

    const stripped = { ...result };
    for (const key of Object.keys(stripped)) {
      if (key === 'imageBase64' || key === 'image' || key === 'data') {
        if (typeof stripped[key] === 'string' && stripped[key].length > 1000) {
          stripped[key] = '[image data sent separately]';
        }
      } else if (typeof stripped[key] === 'object' && stripped[key] !== null) {
        stripped[key] = this.stripImageData(stripped[key]);
      }
    }
    return stripped;
  }

  private handleInterruption() {
    this.isResponseActive = false;
    this.responseTextBuffer = '';

    if (this.turnAbortController) {
      this.turnAbortController.abort();
      this.turnAbortController = null;
    }

    if (this.ttsContextId) {
      this.tts.cancelContext(this.ttsContextId);
      this.ttsContextId = null;
    }

    this.emitToRenderer('cartesia-tts-stop', {});
    this.emitToUI('interruption', {});
    this.emit('interruption');
  }

  private speakError(text: string) {
    this.ttsContextId = this.tts.startContext();
    this.tts.sendText(text, this.ttsContextId, false);
    this.emitToUI('realtime-response-text', text);
  }

  private setVoiceState(state: CartesiaVoiceState) {
    if (this.voiceState === state) return;
    this.voiceState = state;
    console.log(`🎙️ Cartesia voice state: ${state}`);
    this.emitToUI('state-change', state);
    this.overlayManager.sendToOverlay('state-change', state);
  }

  private emitToUI(channel: string, data: any) {
    const panel = this.panelWindow();
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send(channel, data);
    }
  }

  private emitToRenderer(channel: string, data: any) {
    const panel = this.panelWindow();
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send(channel, data);
    }
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
    this.stt.connect();
    this.tts.connect();
    this.emitToRenderer('cartesia-start-capture', {});
  }

  stop() {
    console.log('🛑 Stopping CartesiaRealtimeVoiceManager');
    this.stt.disconnect();
    this.tts.disconnect();
    this.emitToRenderer('cartesia-stop-capture', {});
    this.setVoiceState('idle');
  }

  toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    console.log(`🎙️ Cartesia mute ${this.isMuted ? 'enabled' : 'disabled'}`);

    this.emitToRenderer('cartesia-mute', this.isMuted);

    if (this.isMuted) {
      this.setVoiceState('muted');
    } else {
      this.setVoiceState('idle');
      if (this.stt.getState() !== 'connected') {
        this.stt.connect();
      }
    }

    this.emitToUI('mute-state', this.isMuted);
    return this.isMuted;
  }

  getMuted(): boolean {
    return this.isMuted;
  }

  getVoiceState(): CartesiaVoiceState {
    return this.voiceState;
  }

  isConnected(): boolean {
    return this.stt.getState() === 'connected' && this.tts.getState() === 'connected';
  }

  handleAudioChunk(base64PCM: string) {
    if (this.isMuted) return;
    const buffer = Buffer.from(base64PCM, 'base64');
    this.stt.sendAudioChunk(buffer);
  }

  injectContext(text: string, images?: Array<{ base64: string; mediaType: string }>) {
    const history = this.orchestrator.getHistory();
    if (text) {
      history.push({ role: 'user', content: text });
    }
    if (images) {
      for (const img of images) {
        history.push({
          role: 'user',
          content: [{ type: 'image', image: `data:${img.mediaType};base64,${img.base64}` }],
        });
      }
    }
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
