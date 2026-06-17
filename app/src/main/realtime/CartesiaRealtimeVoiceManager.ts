import { BrowserWindow, nativeImage } from 'electron';
import { EventEmitter } from 'events';
import { tool, jsonSchema } from 'ai';
import { CartesiaSTTSession } from './CartesiaSTTSession';
import { CartesiaTTSSession } from './CartesiaTTSSession';
import { executeRealtimeCompletion } from './executeRealtimeCompletion';
import { RealtimeToolBridge, ToolExecutor } from './RealtimeToolBridge';
import {
  CartesiaConfig,
  CartesiaVoiceState,
  CARTESIA_DEFAULTS,
} from './cartesiaTypes';

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
  private isCompletionRunning = false;
  private pendingToolCalls = 0;
  private ttsContextId: string | null = null;
  private responseTextBuffer = '';
  private messages: any[] = [];
  private reconnectFallbackTriggered = false;

  constructor(options: CartesiaRealtimeVoiceManagerOptions) {
    super();
    this.config = { ...CARTESIA_DEFAULTS, ...options.config };
    this.systemPrompt = options.systemPrompt || '';

    this.stt = new CartesiaSTTSession(this.config);
    this.tts = new CartesiaTTSSession(this.config);
    this.toolBridge = new RealtimeToolBridge();
    this.overlayManager = options.overlayManager;
    this.panelWindow = options.panelWindow;
    this.onFallbackTriggered = options.onFallbackTriggered;

    this.setupSTTHandlers();
    this.setupTTSHandlers();
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
      this.emitToUI('cartesia-tts-audio', {
        contextId: event.contextId,
        base64Audio: event.base64Audio,
        done: event.done,
      });
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
    this.isResponseActive = true;
    this.responseTextBuffer = '';
    this.ttsContextId = this.tts.startContext();

    this.messages.push({ role: 'user', content: transcript });
    this.trimHistory();

    try {
      this.isCompletionRunning = true;
      await executeRealtimeCompletion({
        messages: this.messages,
        system: this.systemPrompt,
        tools: this.buildVercelTools(),
        model: process.env.OPENAI_MODEL,
        onTextChunk: (chunk) => {
          this.responseTextBuffer += chunk;
          this.setVoiceState('responding');
          this.emitToUI('realtime-response-chunk', chunk);
          this.tts.sendText(chunk, this.ttsContextId!, true);
        },
        onToolCall: (toolCall) => {
          this.pendingToolCalls++;
          console.log(`🔧 Tool call: ${toolCall.name}`);
          this.emit('tool.call', toolCall);
        },
        onStepFinish: ({ toolCalls }) => {
          for (const tc of toolCalls) {
            this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
          }
        },
      });

      this.isCompletionRunning = false;
      this.messages.push({ role: 'assistant', content: this.responseTextBuffer });
      this.trimHistory();

      // Finalize TTS
      this.tts.flushContext(this.ttsContextId!);
      this.emitToUI('realtime-response-text', this.responseTextBuffer);
    } catch (err: any) {
      console.error('⚠️ Realtime completion failed:', err.message);
      this.isCompletionRunning = false;
      this.speakError('Sorry, I had trouble thinking that through.');
    }

    this.isResponseActive = false;
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

          const strippedResult = this.stripImageData(result);
          const resultStr = typeof strippedResult === 'string'
            ? strippedResult
            : JSON.stringify(strippedResult);

          this.emitToUI('realtime-tool-result', {
            name: executor.name,
            result: (executor.name === 'captureScreen' || executor.name === 'computerUse')
              ? { success: true, detail: `${executor.name} executed` }
              : result,
          });

          await this.handleToolImages(result);
          return result;
        },
      });
    }

    return tools;
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

  private async handleToolImages(result: any) {
    const images: Array<{ base64: string; mediaType: string }> = [];

    if (result?.screens) {
      for (const screen of result.screens) {
        if (screen.imageBase64) {
          const resized = await this.resizeImageForDataChannel(screen.imageBase64);
          if (resized) images.push({ base64: resized, mediaType: 'image/jpeg' });
        }
      }
    }

    if (result?.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === 'image' && item.data) {
          const resized = await this.resizeImageForDataChannel(item.data);
          if (resized) images.push({ base64: resized, mediaType: item.mimeType || 'image/jpeg' });
        }
      }
    }

    if (images.length > 0) {
      for (const img of images) {
        this.messages.push({
          role: 'user',
          content: [{ type: 'image', image: `data:${img.mediaType};base64,${img.base64}` }],
        });
      }
    }
  }

  private async resizeImageForDataChannel(base64Image: string, maxDim = 1280, quality = 60): Promise<string | null> {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(base64Image, 'base64'));
      if (img.isEmpty()) return null;

      const size = img.getSize();
      const scale = Math.min(1, maxDim / Math.max(size.width, size.height));
      const resized = scale < 1 ? img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }) : img;

      const jpegBuffer = resized.toJPEG(quality);
      return jpegBuffer.toString('base64');
    } catch (err) {
      console.error('⚠️ Failed to resize image for data channel:', err);
      return null;
    }
  }

  private handleInterruption() {
    this.isResponseActive = false;
    this.responseTextBuffer = '';

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

  private trimHistory(maxMessages = 20) {
    if (this.messages.length > maxMessages) {
      this.messages = this.messages.slice(-maxMessages);
    }
  }

  // Public API

  registerTools(executors: ToolExecutor[]) {
    this.toolBridge.registerTools(executors);
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
    if (text) {
      this.messages.push({ role: 'user', content: text });
    }
    if (images) {
      for (const img of images) {
        this.messages.push({
          role: 'user',
          content: [{ type: 'image', image: `data:${img.mediaType};base64,${img.base64}` }],
        });
      }
    }
    this.trimHistory();
  }

  destroy() {
    this.stop();
    this.stt.destroy();
    this.tts.destroy();
    this.toolBridge.clear();
    this.removeAllListeners();
  }
}
