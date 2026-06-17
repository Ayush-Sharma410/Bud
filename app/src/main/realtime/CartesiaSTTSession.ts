import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  CartesiaConfig,
  CartesiaSessionState,
  CartesiaSTTEvent,
  CARTESIA_DEFAULTS,
} from './cartesiaTypes';

export class CartesiaSTTSession extends EventEmitter {
  private config: CartesiaConfig;
  private ws: WebSocket | null = null;
  private sessionState: CartesiaSessionState = 'disconnected';
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

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

    const url = new URL('wss://api.cartesia.ai/stt/turns/websocket');
    url.searchParams.set('model', this.config.sttModel);
    url.searchParams.set('encoding', this.config.sttEncoding);
    url.searchParams.set('sample_rate', String(this.config.sttSampleRate));
    url.searchParams.set('cartesia_version', this.config.cartesiaVersion);

    try {
      this.ws = new WebSocket(url.toString(), {
        headers: {
          'X-API-Key': this.config.apiKey,
        },
      });

      this.ws.on('open', () => {
        console.log('🎙️ Cartesia STT connected');
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.startKeepalive();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err: Error) => {
        console.error('⚠️ Cartesia STT error:', err.message);
        this.emit('error', err);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`🎙️ Cartesia STT closed: ${code} ${reason.toString()}`);
        this.stopKeepalive();
        this.setState('disconnected');
        if (!this.intentionalClose) {
          this.attemptReconnect();
        }
      });
    } catch (err) {
      console.error('⚠️ Cartesia STT connection failed:', err);
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
        console.error('⚠️ Cartesia STT disconnect error:', err);
      }
      this.ws = null;
    }
    this.setState('disconnected');
  }

  sendAudioChunk(pcmBuffer: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(pcmBuffer);
      return true;
    } catch (err) {
      console.error('⚠️ Failed to send STT audio chunk:', err);
      return false;
    }
  }

  private handleMessage(data: WebSocket.Data) {
    try {
      const text = data.toString();
      const event = JSON.parse(text) as CartesiaSTTEvent;

      switch (event.type) {
        case 'connected':
          console.log(`🎙️ Cartesia STT session: ${event.request_id}`);
          this.emit('connected', event);
          break;
        case 'turn.start':
          this.emit('turn.start', event);
          break;
        case 'turn.update':
          this.emit('turn.update', event);
          break;
        case 'turn.eager_end':
          this.emit('turn.eager_end', event);
          break;
        case 'turn.resume':
          this.emit('turn.resume', event);
          break;
        case 'turn.end':
          this.emit('turn.end', event);
          break;
        case 'error':
          console.error('⚠️ Cartesia STT server error:', event.message);
          this.emit('error', new Error(event.message));
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('⚠️ Failed to parse Cartesia STT event:', err);
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
      console.error(`⚠️ Cartesia STT reconnect failed after ${maxAttempts} attempts`);
      this.setState('failed');
      this.emit('reconnectFailed');
      return;
    }

    this.reconnectAttempts++;
    this.setState('reconnecting');

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    console.log(`🎙️ Cartesia STT reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`);

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
