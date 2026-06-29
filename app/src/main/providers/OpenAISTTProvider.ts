import { STTProvider } from './types';
import OpenAI, { toFile } from 'openai';

/**
 * Bud — OpenAI Whisper STT Provider
 *
 * Uses the OpenAI SDK to transcribe audio buffers with Whisper.
 * Provides very low-latency transcription (~1 second).
 */
export class OpenAISTTProvider implements STTProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      console.warn('⚠️ OpenAI API key is missing. STT will fail.');
    }
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(audioBuffer: Buffer): Promise<{ text: string }> {
    if (audioBuffer.length === 0) {
      console.warn('⚠️ Empty audio buffer sent to STT');
      return { text: '' };
    }

    console.log(`🎤 OpenAI Whisper request: ${(audioBuffer.length / 1024).toFixed(1)}KB audio`);

    try {
      // Convert buffer to file-like object for the OpenAI SDK
      const file = await toFile(audioBuffer, 'audio.wav');

      const transcript = await this.client.audio.transcriptions.create({
        file: file,
        model: 'gpt-4o-mini-transcribe',
        language: 'en', // Optional but improves speed/accuracy
      });

      console.log(`🎤 OpenAI Whisper transcript: "${transcript.text}"`);
      return { text: transcript.text || '' };
    } catch (err: any) {
      console.error('❌ OpenAI Whisper API error:', err);
      throw err;
    }
  }
}
