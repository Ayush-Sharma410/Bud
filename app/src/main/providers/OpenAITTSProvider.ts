import { TTSProvider } from './types';

/**
 * Bud — OpenAI TTS Provider
 *
 * Uses the OpenAI REST API to generate speech.
 */
export class OpenAITTSProvider implements TTSProvider {
  private voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

  constructor(voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = 'nova') {
    this.voice = voice;
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!text || text.trim().length === 0) {
      return Buffer.from([]);
    }

    try {
      console.log(`🔊 OpenAI TTS synthesizing ${text.length} chars...`);
      
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          input: text,
          voice: this.voice,
          response_format: 'opus',
          speed: 1
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`OpenAI TTS error: ${await response.text()}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err: any) {
      console.error('❌ OpenAI TTS API error:', err);
      throw err;
    }
  }
}
