import { OpenAISTTProvider } from './src/main/providers/OpenAISTTProvider';
import fs from 'fs';
import path from 'path';

// Load env
const envPath = path.join(__dirname, '.env');
const content = fs.readFileSync(envPath, 'utf-8');
for (const line of content.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const firstEquals = trimmed.indexOf('=');
  if (firstEquals === -1) continue;
  const key = trimmed.slice(0, firstEquals).trim();
  let value = trimmed.slice(firstEquals + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.env[key] = value;
}

async function run() {
  const apiKey = process.env.OPENAI_API_KEY || '';
  const provider = new OpenAISTTProvider(apiKey);
  
  const audioBuffer = fs.readFileSync('node_modules/@ai-sdk/openai/src/transcription/transcription-test.mp3');

  console.time('OpenAI Whisper Transcribe');
  try {
    const result = await provider.transcribe(audioBuffer);
    console.timeEnd('OpenAI Whisper Transcribe');
    console.log('Result:', result.text);
  } catch (err) {
    console.timeEnd('OpenAI Whisper Transcribe');
    console.error(err);
  }
}

run().catch(console.error);
