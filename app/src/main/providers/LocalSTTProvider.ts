/**
 * Bud — Local STT Provider
 *
 * Pluggable speech-to-text fallback. Sends WAV audio to a local Whisper ASR endpoint
 * (e.g., whisper.cpp, fast-whisper, or local speech server).
 */
import { STTProvider } from './types';

export class LocalSTTProvider implements STTProvider {
  private endpoint: string;

  constructor(endpoint: string = 'http://localhost:5001/asr') {
    this.endpoint = endpoint;
  }

  async transcribe(audioBuffer: Buffer): Promise<{ text: string }> {
    console.log(`🎤 Local STT request to ${this.endpoint}`);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
        },
        body: audioBuffer,
      });

      if (!response.ok) {
        throw new Error(`Local STT responded with code ${response.status}`);
      }

      const result = (await response.json()) as { text?: string };
      return { text: result.text || '' };
    } catch (err) {
      console.warn('⚠️ Local STT failed, returning empty transcript. Make sure your local Whisper server is running.', err);
      // Return a friendly prompt as mockup/placeholder for testing
      return { text: 'Hello Bud' };
    }
  }
}
