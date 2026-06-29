/**
 * Bud — Local TTS Provider
 *
 * Pluggable text-to-speech fallback.
 * Uses Windows SAPI (Speech API) via PowerShell to synthesize speech to a local
 * WAV file, which is then read into a Buffer and returned for HTML5 Audio playback.
 * This runs fully local, offline, and with zero external dependencies on Windows.
 */
import { TTSProvider } from './types';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class LocalTTSProvider implements TTSProvider {
  async synthesize(text: string): Promise<Buffer> {
    console.log(`🔊 Local SAPI TTS request: "${text.substring(0, 60)}..."`);

    return new Promise((resolve, reject) => {
      const tempWav = path.join(os.tmpdir(), `bud-local-tts-${Date.now()}.wav`);
      
      // PowerShell command to save SAPI synthesis to WAV file
      // Escaping single quotes in the text by doubling them
      const escapedText = text.replace(/'/g, "''");
      const psCommand = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.SetOutputToWaveFile('${tempWav}'); $synth.Speak('${escapedText}'); $synth.Dispose();`;

      const ps = spawn('powershell', ['-Command', psCommand]);

      let stderr = '';
      ps.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ps.on('close', (code) => {
        if (code !== 0) {
          console.error('⚠️ PowerShell SAPI synthesis failed:', stderr);
          reject(new Error(`PowerShell SAPI exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          if (fs.existsSync(tempWav)) {
            const buffer = fs.readFileSync(tempWav);
            // Clean up temp file asynchronously
            fs.unlink(tempWav, () => {});
            resolve(buffer);
          } else {
            reject(new Error('SAPI output file was not created'));
          }
        } catch (err) {
          reject(err);
        }
      });

      ps.on('error', (err) => {
        reject(err);
      });
    });
  }
}
