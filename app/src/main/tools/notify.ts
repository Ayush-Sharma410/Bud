import { tool, jsonSchema } from 'ai';
import { AudioPlaybackManager } from '../providers/ModalTTSProvider';
import { TTSProvider } from '../providers/types';

export const createNotifyTool = (ttsProvider: TTSProvider | undefined, audioPlayback: AudioPlaybackManager) => tool({
  description: `**Notify Tool** — Give intermediate spoken status updates to the user.

Use this tool ONLY for intermediate updates during multi-step execution:
- Acknowledge a command before starting a long task ("on it", "got it")
- Give a status update ("checking...", "almost done")

DO NOT use this tool for your final response or to answer questions. Your final text response will be automatically spoken to the user.

Set \`type\` to classify the notification:
- "status" — progress update or acknowledgement (default)
- "error" — something went wrong

Always keep text short and spoken-style.`,
  inputSchema: jsonSchema<{
    text: string;
    type?: 'status' | 'error';
  }>({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to speak aloud to the user' },
      type: {
        type: 'string',
        description: 'Notification type: "status" (progress/ack), "error" (something failed)',
        enum: ['status', 'error']
      },
    },
    required: ['text']
  }),
  execute: async ({ text, type = 'status' }) => {
    const label = type === 'error' ? '❌ Error' : '💬 Status';
    console.log(`🛠️ Tool: notify [${label}] — "${text}"`);

    if (ttsProvider) {
      try {
        const buffer = await ttsProvider.synthesize(text);
        if (buffer.length > 0) {
          await audioPlayback.playAudio(buffer);
          return { success: true, detail: `Notified user: "${text}"`, type };
        }
      } catch (err: any) {
        console.error('⚠️ Notify TTS failed:', err.message);
        // Still return success for the notification intent — TTS failure is non-fatal
        return { success: true, detail: `Notification logged (TTS unavailable): "${text}"`, type, ttsError: err.message };
      }
    }

    // TTS provider not available — notification still logged
    return { success: true, detail: `Notification logged (no TTS): "${text}"`, type };
  }
});
