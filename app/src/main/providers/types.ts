/**
 * Bud — Provider Type Definitions
 *
 * Interfaces for the pluggable AI backends (vision, STT, TTS).
 * Two implementations exist for each: Modal (cloud GPU) and Local (Ollama/Piper).
 */

import { ScreenCaptureResult } from '../screenCapture';

// --- Conversation History ---

export interface ConversationEntry {
  userTranscript: string;
  assistantResponse: string;
}

// --- Vision Provider ---

export interface VisionRequest {
  /** Screenshots of all connected displays */
  images: ScreenCaptureResult[];
  /** The user's spoken transcript */
  transcript: string;
  /** Prior conversation exchanges for multi-turn context */
  conversationHistory: ConversationEntry[];
  /** System prompt defining Bud's personality and pointing rules */
  systemPrompt: string;
  /** Callback invoked with accumulated text as SSE chunks arrive */
  onChunk?: (accumulatedText: string) => void;
}

export interface VisionResponse {
  /** The full response text (including any [POINT:...] tag) */
  text: string;
}

export interface VisionProvider {
  analyzeScreenWithTranscript(request: VisionRequest): Promise<VisionResponse>;
}

// --- Speech-to-Text Provider ---

export interface STTProvider {
  /** Transcribe audio (WAV buffer) to text */
  transcribe(audioBuffer: Buffer): Promise<{ text: string }>;
}

// --- Text-to-Speech Provider ---

export interface TTSProvider {
  /** Convert text to audio. Returns WAV/MP3 audio bytes. */
  synthesize(text: string): Promise<Buffer>;
}

// --- Provider Configuration ---

export type ProviderMode = 'modal' | 'local';

export interface ProviderConfig {
  mode: ProviderMode;
  modal: {
    vlmEndpoint: string;
    sttEndpoint: string;
    ttsEndpoint: string;
  };
  local: {
    ollamaEndpoint: string;
    ollamaModel: string;
  };
  /** The VLM model name to use (for Modal: served model name) */
  model: string;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  mode: 'modal',
  modal: {
    vlmEndpoint: process.env.MODAL_VLM_ENDPOINT || 'https://lautonomy--bud-vlm-serve-sglangserver.us-east.modal.direct',
    sttEndpoint: process.env.MODAL_STT_ENDPOINT || 'https://asharma--bud-stt-serve-whisperstt-transcribe.modal.run',
    ttsEndpoint: process.env.MODAL_TTS_ENDPOINT || 'https://asharma--bud-tts-serve-chatterboxtts-synthesize.modal.run',
  },
  local: {
    ollamaEndpoint: 'http://localhost:11434',
    ollamaModel: 'llava',
  },
  model: 'google/gemma-4-26B-A4B-it',
};
