import { ipcMain, BrowserWindow, nativeImage } from 'electron';
import { EventEmitter } from 'events';
import { RealtimeSession } from './RealtimeSession';
import { RealtimeToolBridge, ToolExecutor } from './RealtimeToolBridge';
import {
  RealtimeConfig,
  RealtimeVoiceState,
  RealtimeSessionState,
  RealtimeToolCall,
  REALTIME_SYSTEM_INSTRUCTIONS,
} from './realtimeTypes';

export interface RealtimeVoiceManagerOptions {
  config: RealtimeConfig;
  sdpEndpoint: string;
  overlayManager: { sendToOverlay: (channel: string, data: any) => void; getWindow: () => BrowserWindow | null };
  panelWindow: () => BrowserWindow | null;
  onFallbackTriggered?: (reason: string) => void;
}

export class RealtimeVoiceManager extends EventEmitter {
  private session: RealtimeSession;
  private toolBridge: RealtimeToolBridge;
  private overlayManager: RealtimeVoiceManagerOptions['overlayManager'];
  private panelWindow: () => BrowserWindow | null;
  private onFallbackTriggered?: (reason: string) => void;

  private voiceState: RealtimeVoiceState = 'idle';
  private isMuted = false;
  private functionCallBuffer: Map<string, string> = new Map();
  private responseTextBuffer = '';
  private reconnectFallbackTriggered = false;
  private pendingToolCalls = 0;
  private isResponseActive = false;
  private toolResultsSent = false;

  constructor(options: RealtimeVoiceManagerOptions) {
    super();
    this.session = new RealtimeSession({
      config: {
        ...options.config,
        instructions: options.config.instructions || REALTIME_SYSTEM_INSTRUCTIONS,
      },
      sdpEndpoint: options.sdpEndpoint,
      targetWindow: options.panelWindow,
    });

    this.toolBridge = new RealtimeToolBridge();
    this.overlayManager = options.overlayManager;
    this.panelWindow = options.panelWindow;
    this.onFallbackTriggered = options.onFallbackTriggered;

    this.setupSessionHandlers();
    this.setupIPC();
  }

  private setupIPC() {
    ipcMain.handle('realtime-webrtc-send-event', async (_event, clientEvent: any) => {
      if (this.session.isConnected()) {
        return this.session.send(clientEvent);
      }
      return false;
    });
  }

  private setupSessionHandlers() {
    this.session.on('stateChange', (state: RealtimeSessionState) => {
      console.log(`🔌 Realtime session state: ${state}`);

      if (state === 'connected') {
        this.reconnectFallbackTriggered = false;
        this.setVoiceState('idle');
      } else if (state === 'failed') {
        if (!this.reconnectFallbackTriggered) {
          this.reconnectFallbackTriggered = true;
          this.triggerFallback('Realtime connection failed after max retries');
        }
      } else if (state === 'reconnecting') {
        this.setVoiceState('idle');
      }
    });

    this.session.on('datachannel.open', () => {
      console.log('🔌 Data channel open — registering tools with Realtime session');
      this.registerToolsWithSession();
    });

    this.session.on('speech.started', () => {
      console.log('🎤 Speech detected');
      this.setVoiceState('speech-detected');
      this.emit('speech.started');

      if (this.isResponseActive || this.pendingToolCalls > 0) {
        console.log('🎤 User interrupted — stopping playback');
        this.session.cancelResponse();
        this.setVoiceState('listening');
        this.emitToUI('interruption', {});
        this.emit('interruption');
      }
    });

    this.session.on('speech.stopped', () => {
      console.log('🎤 Speech ended');
      this.setVoiceState('processing');
    });

    this.session.on('transcript', (transcript: string) => {
      console.log(`🗣️ User transcript: "${transcript}"`);
      this.emitToUI('realtime-transcript', transcript);
    });

    this.session.on('response.created', () => {
      this.responseTextBuffer = '';
      this.isResponseActive = true;
      this.toolResultsSent = false;
      this.setVoiceState('responding');
      this.emit('response.created');
    });

    this.session.on('response_transcript.delta', (delta: string) => {
      this.responseTextBuffer += delta;
      this.emitToUI('realtime-response-chunk', delta);
    });

    this.session.on('response_transcript.done', (text: string) => {
      this.emitToUI('realtime-response-text', text);
    });

    this.session.on('response.done', async () => {
      this.isResponseActive = false;

      if (this.pendingToolCalls > 0) {
      } else if (this.toolResultsSent) {
        this.session.triggerResponse();
      } else {
        this.setVoiceState('idle');
      }

      this.emitToUI('realtime-response-done', {});
    });

    this.session.on('function_call.delta', (event: any) => {
      const existing = this.functionCallBuffer.get(event.call_id) || '';
      this.functionCallBuffer.set(event.call_id, existing + (event.delta || ''));
    });

    this.session.on('function_call.done', async (call: RealtimeToolCall) => {
      this.functionCallBuffer.delete(call.callId);
      this.pendingToolCalls++;
      await this.handleToolCall(call);
      this.pendingToolCalls--;
      if (this.pendingToolCalls === 0 && !this.isResponseActive) {
        this.session.triggerResponse();
      }
    });

    this.session.on('output_item.done', (event: any) => {
      if (event.item?.type === 'function_call') {
        // Tool call handled separately
      }
    });

    this.session.on('response.cancelled', () => {
      this.isResponseActive = false;
      this.setVoiceState('idle');
    });

    this.session.on('inactivityTimeout', () => {
      console.log('⏰ Realtime session timed out — will reconnect on next speech');
      this.setVoiceState('idle');
    });

    this.session.on('reconnectFailed', () => {
      if (!this.reconnectFallbackTriggered) {
        this.reconnectFallbackTriggered = true;
        this.triggerFallback('Realtime reconnection failed');
      }
    });

    this.session.on('error', (err: Error) => {
      console.error('⚠️ Realtime session error:', err.message);
    });
  }

  private async handleToolCall(call: RealtimeToolCall) {
    console.log(`🔧 Tool call received: ${call.name} (${call.callId})`);

    const result = await this.toolBridge.executeToolCall(call);

    const strippedResult = this.stripImageData(result);
    let resultStr = typeof strippedResult === 'string' ? strippedResult : JSON.stringify(strippedResult);

    if (resultStr.length > 50000) {
      resultStr = resultStr.substring(0, 50000) + '... [truncated]';
    }

    this.session.sendToolResult(call.callId, resultStr);
    this.toolResultsSent = true;

    if (result?.screens) {
      for (const screen of result.screens) {
        if (screen.imageBase64) {
          const resized = await this.resizeImageForDataChannel(screen.imageBase64);
          if (resized) {
            this.session.sendImageMessage(resized);
          }
        }
      }
    }

    if (result?.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === 'image' && item.data) {
          const resized = await this.resizeImageForDataChannel(item.data);
          if (resized) {
            this.session.sendImageMessage(resized, item.mimeType || 'image/jpeg');
          }
        }
      }
    }

    this.emitToUI('realtime-tool-result', {
      name: call.name,
      callId: call.callId,
      result: (call.name === 'captureScreen' || call.name === 'computerUse')
        ? { success: true, detail: `${call.name} executed` }
        : result,
    });
  }

  private stripImageData(result: any): any {
    if (!result || typeof result !== 'object') return result;

    if (Array.isArray(result)) {
      return result.map(item => this.stripImageData(item));
    }

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

  private registerToolsWithSession() {
    const defs = this.toolBridge.getToolDefinitions();
    if (defs.length > 0) {
      this.session.updateTools(defs);
      console.log(`🔧 Registered ${defs.length} tools with Realtime session`);
    }
  }

  private setVoiceState(state: RealtimeVoiceState) {
    if (this.voiceState === state) return;
    this.voiceState = state;
    console.log(`🎙️ Realtime voice state: ${state}`);
    this.emitToUI('state-change', state);
    this.overlayManager.sendToOverlay('state-change', state);
  }

  private emitToUI(channel: string, data: any) {
    const panel = this.panelWindow();
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send(channel, data);
    }
  }

  private triggerFallback(reason: string) {
    console.log(`⚠️ Triggering fallback: ${reason}`);
    this.setVoiceState('fallback');
    this.onFallbackTriggered?.(reason);
  }

  registerTools(executors: ToolExecutor[]) {
    this.toolBridge.registerTools(executors);
    if (this.session.isConnected()) {
      this.registerToolsWithSession();
    }
  }

  start() {
    console.log('🚀 Starting RealtimeVoiceManager (WebRTC)');
    this.session.connect();
  }

  stop() {
    console.log('🛑 Stopping RealtimeVoiceManager');
    this.session.disconnect();
    this.setVoiceState('idle');
  }

  toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    console.log(`🎙️ Mute ${this.isMuted ? 'enabled' : 'disabled'}`);

    const win = this.panelWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('realtime-webrtc-mute', this.isMuted);
    }

    if (this.isMuted) {
      this.setVoiceState('muted');
    } else {
      this.setVoiceState('idle');
      if (!this.session.isConnected()) {
        this.session.connect();
      }
    }

    this.emitToUI('mute-state', this.isMuted);
    return this.isMuted;
  }

  getMuted(): boolean {
    return this.isMuted;
  }

  getVoiceState(): RealtimeVoiceState {
    return this.voiceState;
  }

  isConnected(): boolean {
    return this.session.isConnected();
  }

  sendTextMessage(text: string) {
    if (!this.session.isConnected()) {
      console.warn('⚠️ Cannot send text — session not connected');
      return;
    }

    this.session.sendTextMessage('user', text);
    if (!this.isResponseActive) {
      this.session.triggerResponse();
    }
  }

  injectContext(text: string, images?: Array<{ base64: string; mediaType: string }>) {
    if (!this.session.isConnected()) return;
    if (text) this.session.sendTextMessage('user', text);
    if (images) {
      for (const img of images) {
        this.session.sendImageMessage(img.base64, img.mediaType);
      }
    }
  }

  sendScreenshot(base64Image: string) {
    if (!this.session.isConnected()) return;

    this.session.sendImageMessage(base64Image);
    if (!this.isResponseActive) {
      this.session.triggerResponse();
    }
  }

  speakText(text: string) {
    if (!this.session.isConnected()) {
      this.triggerFallback('Realtime not connected — using direct TTS');
      return;
    }

    this.session.sendTextMessage('assistant', text);
    if (!this.isResponseActive) {
      this.session.triggerResponse();
    }
  }

  destroy() {
    this.session.destroy();
    this.toolBridge.clear();
    ipcMain.removeHandler('realtime-webrtc-send-event');
    this.removeAllListeners();
  }
}
