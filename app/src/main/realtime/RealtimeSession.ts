import { ipcMain, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import {
  RealtimeConfig,
  RealtimeSessionState,
  RealtimeToolDefinition,
  REALTIME_DEFAULTS,
} from './realtimeTypes';

export class RealtimeSession extends EventEmitter {
  private config: RealtimeConfig;
  private sessionState: RealtimeSessionState = 'disconnected';
  private reconnectAttempts = 0;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private sessionId: string | null = null;
  private sdpEndpoint: string;
  private targetWindow: () => BrowserWindow | null;

  constructor(options: {
    config: Partial<RealtimeConfig>;
    sdpEndpoint: string;
    targetWindow: () => BrowserWindow | null;
  }) {
    super();
    this.config = { ...REALTIME_DEFAULTS, ...options.config };
    this.sdpEndpoint = options.sdpEndpoint;
    this.targetWindow = options.targetWindow;
    this.setupIPC();
  }

  private setupIPC() {
    ipcMain.on('realtime-webrtc-event', (_event, event: any) => {
      this.resetInactivityTimer();
      this.handleEvent(event);
    });

    ipcMain.on('realtime-webrtc-connected', () => {
      console.log('🔌 Realtime WebRTC ICE connected');
      this.reconnectAttempts = 0;
      this.setState('connected');
      this.resetInactivityTimer();
    });

    ipcMain.on('realtime-webrtc-datachannel-open', () => {
      console.log('🔌 Realtime WebRTC data channel open — configuring session');
      this.configureSession();
      this.emit('datachannel.open');
    });

    ipcMain.on('realtime-webrtc-disconnected', (_event, reason: string) => {
      console.log(`🔌 Realtime WebRTC disconnected: ${reason}`);
      this.setState('disconnected');
      if (!this.intentionalClose && reason !== 'intentional') {
        this.attemptReconnect();
      }
    });

    ipcMain.on('realtime-webrtc-error', (_event, error: string) => {
      console.error('⚠️ Realtime WebRTC error:', error);
      this.emit('error', new Error(error));
    });
  }

  getState(): RealtimeSessionState {
    return this.sessionState;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  connect() {
    if (this.sessionState === 'connected' || this.sessionState === 'connecting') {
      return;
    }

    this.intentionalClose = false;
    this.setState('connecting');

    const win = this.targetWindow();
    if (!win || win.isDestroyed()) {
      console.error('⚠️ Cannot connect — target window not available');
      this.setState('failed');
      return;
    }

    win.webContents.send('realtime-webrtc-connect', {
      sdpEndpoint: this.sdpEndpoint,
    });
  }

  disconnect() {
    this.intentionalClose = true;
    this.clearInactivityTimer();

    const win = this.targetWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('realtime-webrtc-disconnect');
    }

    this.setState('disconnected');
  }

  send(event: Record<string, any>) {
    const win = this.targetWindow();
    if (!win || win.isDestroyed()) {
      console.warn('⚠️ Cannot send — target window not available');
      return false;
    }

    try {
      win.webContents.send('realtime-webrtc-send', event);
      return true;
    } catch (err) {
      console.error('⚠️ Failed to send Realtime event:', err);
      return false;
    }
  }

  sendAudioChunk(base64Audio: string) {
    return this.send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  commitAudio() {
    return this.send({ type: 'input_audio_buffer.commit' });
  }

  clearAudioBuffer() {
    return this.send({ type: 'input_audio_buffer.clear' });
  }

  sendToolResult(callId: string, output: string) {
    return this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
  }

  sendTextMessage(role: 'user' | 'assistant', text: string) {
    return this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role,
        content: [{ type: 'input_text', text }],
      },
    });
  }

  sendImageMessage(base64Image: string, mediaType: string = 'image/jpeg') {
    return this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: `data:${mediaType};base64,${base64Image}`,
          },
        ],
      },
    });
  }

  triggerResponse() {
    return this.send({ type: 'response.create' });
  }

  cancelResponse() {
    return this.send({ type: 'response.cancel' });
  }

  updateTools(tools: RealtimeToolDefinition[]) {
    return this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        tools: tools.map(t => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        tool_choice: 'auto',
      },
    });
  }

  isConnected(): boolean {
    return this.sessionState === 'connected';
  }

  private configureSession() {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.config.model,
        reasoning: {
          effort: 'low',
        },
        output_modalities: ['audio'],
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
              rate: 24000,
            },
            turn_detection: {
              type: 'semantic_vad',
            },
          },
          output: {
            format: {
              type: 'audio/pcm',
              rate: 24000,
            },
            voice: this.config.voice || 'cedar',
          },
        },
        instructions: this.config.instructions || '',
      },
    });
  }

  private handleEvent(event: any) {
    switch (event.type) {
      case 'session.created':
        this.sessionId = event.session?.id || null;
        console.log(`🔌 Realtime session created: ${this.sessionId}`);
        this.emit('session.created', event);
        break;

      case 'session.updated':
        console.log('🔌 Realtime session configured');
        this.emit('session.updated', event);
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech.started', event);
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speech.stopped', event);
        break;

      case 'input_audio_buffer.committed':
        this.emit('speech.committed', event);
        break;

      case 'conversation.item.created':
        this.emit('item.created', event);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.emit('transcript', event.transcript || '');
        break;

      case 'conversation.item.input_audio_transcription.failed':
        console.error('⚠️ Transcription failed:', event.error);
        break;

      case 'response.created':
        this.emit('response.created', event);
        break;

      case 'response.output_item.added':
        this.emit('output_item.added', event);
        break;

      case 'response.function_call_arguments.delta':
        this.emit('function_call.delta', event);
        break;

      case 'response.function_call_arguments.done':
        this.emit('function_call.done', {
          callId: event.call_id,
          name: event.name,
          arguments: event.arguments,
        });
        break;

      case 'response.output_audio.delta':
        this.emit('audio.delta', event.delta);
        break;

      case 'response.output_audio_transcript.delta':
        this.emit('response_transcript.delta', event.delta);
        break;

      case 'response.output_audio_transcript.done':
        this.emit('response_transcript.done', event.transcript || '');
        break;

      case 'response.output_audio.done':
        this.emit('audio.done', event);
        break;

      case 'response.output_item.done':
        this.emit('output_item.done', event);
        break;

      case 'response.done':
        this.emit('response.done', event);
        break;

      case 'response.cancelled':
        this.emit('response.cancelled', event);
        break;

      case 'error':
        console.error('⚠️ Realtime API error:', event.error);
        this.emit('error', new Error(event.error?.message || 'Unknown Realtime error'));
        break;

      default:
        break;
    }
  }

  private setState(state: RealtimeSessionState) {
    if (this.sessionState === state) return;
    this.sessionState = state;
    this.emit('stateChange', state);
  }

  private attemptReconnect() {
    const maxAttempts = this.config.maxReconnectAttempts || 3;

    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`⚠️ Realtime reconnect failed after ${maxAttempts} attempts`);
      this.setState('failed');
      this.emit('reconnectFailed');
      return;
    }

    this.reconnectAttempts++;
    this.setState('reconnecting');

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    console.log(`🔌 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`);

    setTimeout(() => {
      if (!this.intentionalClose) {
        this.connect();
      }
    }, delay);
  }

  private resetInactivityTimer() {
    this.clearInactivityTimer();
    const timeout = this.config.inactivityTimeoutMs || REALTIME_DEFAULTS.inactivityTimeoutMs!;

    if (timeout > 0) {
      this.inactivityTimer = setTimeout(() => {
        console.log('⏰ Realtime session inactive — disconnecting');
        this.disconnect();
        this.emit('inactivityTimeout');
      }, timeout);
    }
  }

  private clearInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  destroy() {
    this.disconnect();
    this.removeAllListeners();
    ipcMain.removeAllListeners('realtime-webrtc-event');
    ipcMain.removeAllListeners('realtime-webrtc-connected');
    ipcMain.removeAllListeners('realtime-webrtc-datachannel-open');
    ipcMain.removeAllListeners('realtime-webrtc-disconnected');
    ipcMain.removeAllListeners('realtime-webrtc-error');
  }
}
