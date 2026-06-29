/**
 * Bud — Modal TTS Provider
 *
 * Sends text to the Modal-hosted Chatterbox TTS endpoint.
 * The endpoint accepts a POST with text parameter and returns WAV audio bytes.
 *
 * Audio playback is handled by sending the WAV data to the overlay
 * renderer window, which plays it via the Web Audio API. This avoids
 * needing native audio playback libraries in the main process.
 *
 * Endpoint contract (from tts_serve.py):
 *   POST /?text=...&exaggeration=0.5
 *   Response: audio/wav stream
 *
 * Port of: ElevenLabsTTSClient.swift
 */

import { BrowserWindow } from 'electron';
import { TTSProvider } from './types';

export class ModalTTSProvider implements TTSProvider {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!text.trim()) {
      return Buffer.alloc(0);
    }

    console.log(`🔊 TTS request: "${text.substring(0, 80)}..."`);

    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    if (elevenLabsApiKey) {
      console.log('🎙️ Routing TTS to ElevenLabs');
      const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Default: Adam
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': elevenLabsApiKey,
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`ElevenLabs TTS API error (${response.status}): ${errorBody}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);
        console.log(`🔊 ElevenLabs TTS received: ${(audioBuffer.length / 1024).toFixed(1)}KB audio`);
        return audioBuffer;
      } catch (err: any) {
        console.warn(`⚠️ ElevenLabs TTS failed: ${err.message || err}. Falling back to Modal TTS...`);
      }
    }

    // Chatterbox endpoint uses query params for text and exaggeration
    const url = new URL(this.endpoint);
    url.searchParams.set('text', text);
    url.searchParams.set('exaggeration', '0.5');

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'audio/wav',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`TTS API error (${response.status}): ${errorBody}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    console.log(`🔊 TTS received: ${(audioBuffer.length / 1024).toFixed(1)}KB audio`);
    return audioBuffer;
  }
}

// --- Audio Playback Manager ---

/**
 * Manages audio playback by sending WAV data to a renderer window.
 * The renderer plays audio via HTML5 Audio and reports back when done.
 *
 * Supports a queue: if playAudio() is called while audio is already playing,
 * the new audio is queued and plays after the current one finishes.
 * This prevents narration interruption (e.g., "done" cutting off the opening narration).
 */
export class AudioPlaybackManager {
  private targetWindow: BrowserWindow | null = null;
  private _isPlaying = false;
  private playbackResolve: (() => void) | null = null;
  private audioQueue: { buffer: Buffer; resolve: () => void }[] = [];

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /** Set the renderer window that will handle audio playback */
  setTargetWindow(window: BrowserWindow) {
    this.targetWindow = window;
  }

  /**
   * Play WAV audio data. Returns a promise that resolves when playback ends.
   * If audio is already playing, the new audio is queued and will play
   * after the current (and any previously queued) audio finishes.
   */
  playAudio(audioBuffer: Buffer): Promise<void> {
    return new Promise((resolve) => {
      if (!this.targetWindow || this.targetWindow.isDestroyed()) {
        console.warn('⚠️ No target window for audio playback');
        resolve();
        return;
      }

      if (audioBuffer.length === 0) {
        resolve();
        return;
      }

      // If already playing, queue this audio
      if (this._isPlaying) {
        console.log(`🔊 Audio queued (${(audioBuffer.length / 1024).toFixed(1)}KB) — waiting for current playback`);
        this.audioQueue.push({ buffer: audioBuffer, resolve });
        return;
      }

      this.playNow(audioBuffer, resolve);
    });
  }

  /**
   * Immediately start playing an audio buffer.
   * Called for the first item and for dequeued items.
   */
  private playNow(audioBuffer: Buffer, resolve: () => void) {
    if (!this.targetWindow || this.targetWindow.isDestroyed()) {
      resolve();
      return;
    }

    this.playbackResolve = resolve;
    this._isPlaying = true;

    // Send base64 audio to the renderer for playback
    const base64 = audioBuffer.toString('base64');
    this.targetWindow.webContents.send('play-audio', base64);

    // Safety timeout — resolve after 60s max
    setTimeout(() => {
      if (this._isPlaying) {
        this._isPlaying = false;
        this.playbackResolve?.();
        this.playbackResolve = null;
        this.playNext();
      }
    }, 60000);
  }

  /** Called by the renderer when audio playback finishes */
  onPlaybackEnded() {
    this._isPlaying = false;
    this.playbackResolve?.();
    this.playbackResolve = null;
    this.playNext();
  }

  /**
   * Play the next item from the queue, if any.
   */
  private playNext() {
    if (this.audioQueue.length === 0) return;

    const next = this.audioQueue.shift()!;
    console.log(`🔊 Playing next queued audio (${(next.buffer.length / 1024).toFixed(1)}KB, ${this.audioQueue.length} remaining)`);
    this.playNow(next.buffer, next.resolve);
  }

  /** Stop any in-progress playback and clear the queue */
  stopPlayback() {
    // Resolve all queued promises so callers don't hang
    for (const queued of this.audioQueue) {
      queued.resolve();
    }
    this.audioQueue = [];

    this._isPlaying = false;
    this.playbackResolve?.();
    this.playbackResolve = null;

    // The renderer will handle stopping via its own logic
    if (this.targetWindow && !this.targetWindow.isDestroyed()) {
      this.targetWindow.webContents.send('stop-audio');
    }
  }
}

