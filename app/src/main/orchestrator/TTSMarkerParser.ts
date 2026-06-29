/**
 * Bud — TTS Marker Parser
 *
 * Streaming parser that extracts <TTS>...</TTS> spoken snippets from the
 * model's text stream. Text outside tags is forwarded as normal text.
 */

export interface TTSMarkerChunk {
  /** Plain text to show in the UI. */
  text: string;
  /** Spoken text to send to TTS, if a complete marker was found. */
  tts?: string;
}

export class TTSMarkerParser {
  private buffer = '';
  private insideTTS = false;
  private ttsBuffer = '';

  /**
   * Push a raw text chunk from the model stream.
   * Returns an array of { text, tts? } chunks. `tts` is present only when a
   * complete <TTS>...</TTS> block has been closed in this chunk.
   */
  push(chunk: string): TTSMarkerChunk[] {
    const results: TTSMarkerChunk[] = [];

    for (const char of chunk) {
      if (this.insideTTS) {
        // Check for closing tag character by character
        this.ttsBuffer += char;
        if (this.ttsBuffer.endsWith('</TTS>')) {
          const spoken = this.ttsBuffer.slice(0, -'</TTS>'.length);
          if (spoken) {
            results.push({ text: '', tts: spoken });
          }
          this.ttsBuffer = '';
          this.insideTTS = false;
        }
      } else {
        this.buffer += char;
        if (this.buffer.endsWith('<TTS>')) {
          const text = this.buffer.slice(0, -'<TTS>'.length);
          if (text) {
            results.push({ text });
          }
          this.buffer = '';
          this.insideTTS = true;
        }
      }
    }

    // Flush remaining plain text if not inside a TTS block
    if (!this.insideTTS && this.buffer) {
      results.push({ text: this.buffer });
      this.buffer = '';
    }

    return results;
  }

  /**
   * Call when the stream ends. Returns any leftover plain text (or drops
   * incomplete TTS markers to avoid speaking partial tags).
   */
  flush(): string {
    const leftover = this.insideTTS ? '' : this.buffer;
    this.buffer = '';
    this.ttsBuffer = '';
    this.insideTTS = false;
    return leftover;
  }
}
