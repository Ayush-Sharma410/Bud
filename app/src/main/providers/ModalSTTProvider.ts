/**
 * Bud — Modal STT Provider
 *
 * Sends WAV audio to the Modal-hosted Whisper Large v3 endpoint.
 * The endpoint accepts raw audio bytes via HTTP POST and returns
 * a JSON transcript.
 *
 * Endpoint contract (from stt_serve.py):
 *   POST /  (body: raw audio bytes)
 *   Response: { "text": "transcript...", "model": "openai/whisper-large-v3" }
 */

import { STTProvider } from './types';

export class ModalSTTProvider implements STTProvider {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async transcribe(audioBuffer: Buffer): Promise<{ text: string }> {
    if (audioBuffer.length === 0) {
      console.warn('⚠️ Empty audio buffer sent to STT');
      return { text: '' };
    }

    console.log(`🎤 STT request: ${(audioBuffer.length / 1024).toFixed(1)}KB audio`);

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`STT API error (${response.status}): ${errorBody}`);
    }

    const result = (await response.json()) as { text: string; model: string };
    console.log(`🎤 STT transcript: "${result.text}"`);
    return { text: result.text };
  }
}
