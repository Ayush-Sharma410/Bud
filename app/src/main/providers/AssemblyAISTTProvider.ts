import { AssemblyAI } from 'assemblyai';
import { STTProvider } from './types';

/**
 * Bud — AssemblyAI STT Provider
 *
 * Uses the AssemblyAI SDK to transcribe raw audio buffers.
 * Connects to the pre-recorded audio transcription API.
 */
export class AssemblyAISTTProvider implements STTProvider {
  private client: AssemblyAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      console.warn('⚠️ AssemblyAI API key is missing. STT will fail.');
    }
    this.client = new AssemblyAI({ apiKey });
  }

  async transcribe(audioBuffer: Buffer): Promise<{ text: string }> {
    if (audioBuffer.length === 0) {
      console.warn('⚠️ Empty audio buffer sent to STT');
      return { text: '' };
    }

    console.log(`🎤 AssemblyAI request: ${(audioBuffer.length / 1024).toFixed(1)}KB audio`);

    try {
      const transcript = await this.client.transcripts.transcribe({
        audio: audioBuffer,
        speech_models: ['universal-3-pro', 'universal-2'],
      });

      if (transcript.status === 'error') {
        throw new Error(`AssemblyAI Error: ${transcript.error}`);
      }

      console.log(`🎤 AssemblyAI transcript: "${transcript.text}"`);
      return { text: transcript.text || '' };
    } catch (err: any) {
      console.error('❌ AssemblyAI API error:', err);
      throw err;
    }
  }
}
