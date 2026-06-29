// AudioWorklet processor for capturing PCM16 audio at 24kHz
class PCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(480); // 20ms at 24kHz
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0]) {
      const channelData = input[0];
      
      for (let i = 0; i < channelData.length; i++) {
        this.buffer[this.bufferIndex++] = channelData[i];
        
        if (this.bufferIndex >= this.buffer.length) {
          // Convert Float32 to PCM16
          const pcm16 = new Int16Array(this.buffer.length);
          for (let j = 0; j < this.buffer.length; j++) {
            const s = Math.max(-1, Math.min(1, this.buffer[j]));
            pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          
          // Send to main thread
          this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
          
          // Reset buffer
          this.buffer = new Float32Array(480);
          this.bufferIndex = 0;
        }
      }
    }
    
    return true;
  }
}

registerProcessor('pcm16-processor', PCM16Processor);
