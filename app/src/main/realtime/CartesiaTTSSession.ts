import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
  CartesiaConfig,
  CartesiaSessionState,
  CartesiaTTSEvent,
  CartesiaGenerationRequest,
  CartesiaCancelRequest,
  CARTESIA_DEFAULTS,
} from './cartesiaTypes';

export class CartesiaTTSSession extends EventEmitter {
  private config: CartesiaConfig;
  private ws: WebSocket | null = null;
  private sessionState: CartesiaSessionState = 'disconnected';
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private currentContextId: string | null = null;

  constructor(config: Partial<CartesiaConfig>) {
    super();
    this.config = { ...CARTESIA_DEFAULTS, ...config };
  }

  getState(): CartesiaSessionState {
    return this.sessionState;
  }

  connect() {
    if (this.sessionState === 'connected' || this.sessionState === 'connecting') {
      return;
    }

    this.intentionalClose = false;
    this.setState('connecting');

    const url = new URL('wss://api.cartesia.ai/tts/websocket');
    url.searchParams.set('cartesia_version', this.config.cartesiaVersion);

    try {
      this.ws = new WebSocket(url.toString(), {
        headers: {
          'X-API-Key': this.config.apiKey,
        },
      });

      this.ws.on('open', () => {
        console.log('🔊 Cartesia TTS connected');
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.startKeepalive();
        this.emit('connected');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err: Error) => {
        console.error('⚠️ Cartesia TTS error:', err.message);
        this.emit('error', err);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`🔊 Cartesia TTS closed: ${code} ${reason.toString()}`);
        this.stopKeepalive();
        this.setState('disconnected');
        if (!this.intentionalClose) {
          this.attemptReconnect();
        }
      });
    } catch (err) {
      console.error('⚠️ Cartesia TTS connection failed:', err);
      this.setState('failed');
      this.emit('error', err);
    }
  }

  disconnect() {
    this.intentionalClose = true;
    this.stopKeepalive();
    if (this.ws) {
      try {
        this.ws.close(1000, 'intentional');
      } catch (err) {
        console.error('⚠️ Cartesia TTS disconnect error:', err);
      }
      this.ws = null;
    }
    this.setState('disconnected');
  }

  startContext(): string {
    this.currentContextId = randomUUID();
    return this.currentContextId;
  }

  getCurrentContextId(): string | null {
    return this.currentContextId;
  }

  sendText(text: string, contextId: string, isContinuation: boolean = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ Cannot send TTS text — WebSocket not open');
      return false;
    }

    const request: CartesiaGenerationRequest = {
      model_id: this.config.ttsModel,
      transcript: text,
      voice: { mode: 'id', id: this.config.ttsVoiceId },
      output_format: this.config.ttsOutputFormat,
      context_id: contextId,
      continue: isContinuation,
      max_buffer_delay_ms: isContinuation ? 3000 : 0,
    };

    try {
      this.ws.send(JSON.stringify(request));
      return true;
    } catch (err) {
      console.error('⚠️ Failed to send TTS request:', err);
      return false;
    }
  }

  flushContext(contextId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      const request: CartesiaGenerationRequest = {
        model_id: this.config.ttsModel,
        transcript: '',
        voice: { mode: 'id', id: this.config.ttsVoiceId },
        output_format: this.config.ttsOutputFormat,
        context_id: contextId,
        continue: false,
        flush: true,
      };
      this.ws.send(JSON.stringify(request));
      return true;
    } catch (err) {
      console.error('⚠️ Failed to flush TTS context:', err);
      return false;
    }
  }

  cancelContext(contextId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const request: CartesiaCancelRequest = { context_id: contextId, cancel: true };
    try {
      this.ws.send(JSON.stringify(request));
      this.currentContextId = null;
      return true;
    } catch (err) {
      console.error('⚠️ Failed to cancel TTS context:', err);
      return false;
    }
  }

  private handleMessage(data: WebSocket.Data) {
    try {
      const text = data.toString();
      const event = JSON.parse(text) as CartesiaTTSEvent;

      switch (event.type) {
        case 'chunk':
          this.emit('audio.delta', {
            contextId: event.context_id,
            base64Audio: event.data,
            done: event.done,
          });
          if (event.done) {
            this.emit('audio.done', { contextId: event.context_id });
          }
          break;
        case 'flush_done':
          this.emit('flush.done', event);
          break;
        case 'done':
          this.emit('audio.done', { contextId: event.context_id });
          break;
        case 'error':
          console.error('⚠️ Cartesia TTS server error:', event.message);
          this.emit('error', new Error(event.message));
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('⚠️ Failed to parse Cartesia TTS event:', err);
    }
  }

  private setState(state: CartesiaSessionState) {
    if (this.sessionState === state) return;
    this.sessionState = state;
    this.emit('stateChange', state);
  }

  private attemptReconnect() {
    const maxAttempts = this.config.maxReconnectAttempts || CARTESIA_DEFAULTS.maxReconnectAttempts!;

    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`⚠️ Cartesia TTS reconnect failed after ${maxAttempts} attempts`);
      this.setState('failed');
      this.emit('reconnectFailed');
      return;
    }

    this.reconnectAttempts++;
    this.setState('reconnecting');

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    console.log(`🔊 Cartesia TTS reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`);

    setTimeout(() => {
      if (!this.intentionalClose) {
        this.connect();
      }
    }, delay);
  }

  private startKeepalive() {
    this.stopKeepalive();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 60000);
  }

  private stopKeepalive() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }
}
