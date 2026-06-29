class RealtimePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 0;
    this._buffer = new Float32Array(4800);
    this._targetChunkMs = 20;
    this._samplesPerChunk = Math.floor(sampleRate * this._targetChunkMs / 1000);
    this._writeIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channelData = input[0];

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._writeIndex++] = channelData[i];

      if (this._writeIndex >= this._samplesPerChunk) {
        const pcm16 = this.float32ToPCM16(this._buffer.subarray(0, this._writeIndex));
        this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
        this._writeIndex = 0;
      }
    }

    return true;
  }

  float32ToPCM16(float32Array) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }
}

registerProcessor('realtime-pcm-processor', RealtimePCMProcessor);
