export interface CartesiaConfig {
  apiKey: string;
  ttsModel: string;
  ttsVoiceId: string;
  sttModel: string;
  sttSampleRate: number;
  sttEncoding: 'pcm_s16le' | 'pcm_s32le' | 'pcm_f16le' | 'pcm_f32le' | 'pcm_mulaw' | 'pcm_alaw';
  ttsOutputFormat: {
    container: 'raw';
    encoding: 'pcm_f32le' | 'pcm_s16le' | 'pcm_mulaw' | 'pcm_alaw';
    sampleRate: 8000 | 16000 | 22050 | 24000 | 44100 | 48000;
  };
  cartesiaVersion: string;
  instructions?: string;
  maxReconnectAttempts?: number;
}

export const CARTESIA_DEFAULTS: CartesiaConfig = {
  apiKey: '',
  ttsModel: 'sonic-3.5',
  ttsVoiceId: '',
  sttModel: 'ink-2',
  sttSampleRate: 24000,
  sttEncoding: 'pcm_s16le',
  ttsOutputFormat: {
    container: 'raw',
    encoding: 'pcm_s16le',
    sampleRate: 24000,
  },
  cartesiaVersion: '2026-03-01',
  instructions: '',
  maxReconnectAttempts: 3,
};

export type CartesiaVoiceState =
  | 'idle'
  | 'listening'
  | 'speech-detected'
  | 'processing'
  | 'responding'
  | 'muted'
  | 'fallback';

export type CartesiaSessionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

// STT events
export interface CartesiaSTTConnectedEvent {
  type: 'connected';
  request_id: string;
}

export interface CartesiaSTTTurnStartEvent {
  type: 'turn.start';
  request_id: string;
}

export interface CartesiaSTTTurnUpdateEvent {
  type: 'turn.update';
  transcript: string;
  request_id: string;
}

export interface CartesiaSTTTurnEagerEndEvent {
  type: 'turn.eager_end';
  transcript: string;
  request_id: string;
}

export interface CartesiaSTTTurnResumeEvent {
  type: 'turn.resume';
  request_id: string;
}

export interface CartesiaSTTTurnEndEvent {
  type: 'turn.end';
  transcript: string;
  request_id: string;
}

export interface CartesiaSTTErrorEvent {
  type: 'error';
  error_code?: string;
  status_code: number;
  title: string;
  message: string;
  doc_url?: string;
  request_id?: string;
}

export type CartesiaSTTEvent =
  | CartesiaSTTConnectedEvent
  | CartesiaSTTTurnStartEvent
  | CartesiaSTTTurnUpdateEvent
  | CartesiaSTTTurnEagerEndEvent
  | CartesiaSTTTurnResumeEvent
  | CartesiaSTTTurnEndEvent
  | CartesiaSTTErrorEvent;

// TTS events
export interface CartesiaTTSChunkEvent {
  type: 'chunk';
  data: string;
  done: boolean;
  status_code: number;
  step_time: number;
  context_id: string;
}

export interface CartesiaTTSFlushDoneEvent {
  type: 'flush_done';
  done: boolean;
  flush_done: boolean;
  flush_id: number;
  status_code: number;
  context_id: string;
}

export interface CartesiaTTSDoneEvent {
  type: 'done';
  done: boolean;
  status_code: number;
  context_id: string;
}

export interface CartesiaTTSErrorEvent {
  type: 'error';
  done?: boolean;
  error_code?: string;
  status_code: number;
  title: string;
  message: string;
  doc_url?: string;
  request_id?: string;
  context_id?: string;
}

export type CartesiaTTSEvent =
  | CartesiaTTSChunkEvent
  | CartesiaTTSFlushDoneEvent
  | CartesiaTTSDoneEvent
  | CartesiaTTSErrorEvent;

export interface CartesiaGenerationRequest {
  model_id: string;
  transcript: string;
  voice: { mode: 'id'; id: string };
  output_format: {
    container: 'raw';
    encoding: 'pcm_f32le' | 'pcm_s16le' | 'pcm_mulaw' | 'pcm_alaw';
    sample_rate: 8000 | 16000 | 22050 | 24000 | 44100 | 48000;
  };
  context_id: string;
  language?: string;
  continue?: boolean;
  max_buffer_delay_ms?: number;
  flush?: boolean;
}

export interface CartesiaCancelRequest {
  context_id: string;
  cancel: true;
}
