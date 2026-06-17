// Cartesia realtime audio capture and playback for Bud panel renderer.
// Captures microphone audio as pcm_s16le chunks and plays TTS audio chunks via Web Audio.

(function () {
  const SAMPLE_RATE = 24000;
  const TARGET_CHUNK_MS = 100;
  const SAMPLES_PER_CHUNK = Math.floor((SAMPLE_RATE * TARGET_CHUNK_MS) / 1000);
  const BYTES_PER_SAMPLE = 2; // s16le

  let micStream = null;
  let audioCtx = null;
  let workletNode = null;
  let mediaSource = null;
  let isCapturing = false;
  let isMuted = false;

  let audioQueue = [];
  let nextStartTime = 0;
  let activeSources = [];
  let pendingChunks = new Int16Array(0);

  function ab2b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function concatInt16(a, b) {
    const result = new Int16Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  }

  async function ensureMic() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.error('[CartesiaRealtime] Mic access denied:', err);
      micStream = null;
      throw err;
    }
  }

  async function startCapture() {
    if (isCapturing) return;
    await ensureMic();

    try {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await audioCtx.audioWorklet.addModule('realtime-worklet.js');

      workletNode = new AudioWorkletNode(audioCtx, 'realtime-pcm-processor');
      mediaSource = audioCtx.createMediaStreamSource(micStream);
      mediaSource.connect(workletNode);

      // Keep the worklet in the audio graph without playing it back to speakers.
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(audioCtx.destination);
      workletNode.connect(silentGain);

      let chunkBuffer = new Int16Array(0);

      workletNode.port.onmessage = (e) => {
        if (isMuted) return;
        const pcm16 = new Int16Array(e.data);
        chunkBuffer = concatInt16(chunkBuffer, pcm16);

        while (chunkBuffer.length >= SAMPLES_PER_CHUNK) {
          const batch = chunkBuffer.slice(0, SAMPLES_PER_CHUNK);
          chunkBuffer = chunkBuffer.slice(SAMPLES_PER_CHUNK);

          const bytes = new Uint8Array(batch.buffer);
          const base64 = ab2b64(bytes);
          window.budAPI?.sendRealtimePCM?.(base64);
        }
      };

      isCapturing = true;
      console.log('[CartesiaRealtime] Capture started');
    } catch (err) {
      console.error('[CartesiaRealtime] Failed to start capture:', err);
      stopCapture();
    }
  }

  function stopCapture() {
    if (!isCapturing) return;
    isCapturing = false;

    if (workletNode) {
      workletNode.disconnect();
      workletNode = null;
    }
    if (mediaSource) {
      mediaSource.disconnect();
      mediaSource = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }

    console.log('[CartesiaRealtime] Capture stopped');
  }

  function setMuted(muted) {
    isMuted = muted;
    if (micStream) {
      micStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
  }

  function stopPlayback() {
    activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (err) {
        // ignore
      }
    });
    activeSources = [];
    audioQueue = [];
    nextStartTime = 0;
    pendingChunks = new Int16Array(0);
  }

  function base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }

  function playAudioChunk(base64Audio) {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }

    const samples = base64ToInt16(base64Audio);
    pendingChunks = concatInt16(pendingChunks, samples);

    // Schedule complete sample frames
    const frameCount = Math.floor(pendingChunks.length);
    if (frameCount === 0) return;

    const frames = pendingChunks.slice(0, frameCount);
    pendingChunks = pendingChunks.slice(frameCount);

    const buffer = audioCtx.createBuffer(1, frames.length, SAMPLE_RATE);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < frames.length; i++) {
      channelData[i] = frames[i] / 32768;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);

    const startTime = Math.max(nextStartTime, audioCtx.currentTime);
    source.start(startTime);
    nextStartTime = startTime + buffer.duration;

    activeSources.push(source);
    source.onended = () => {
      const idx = activeSources.indexOf(source);
      if (idx >= 0) activeSources.splice(idx, 1);
    };
  }

  function handleAudioEvent(event) {
    playAudioChunk(event.base64Audio);
  }

  if (window.budAPI) {
    window.budAPI.onCartesiaStartCapture?.(() => startCapture());
    window.budAPI.onCartesiaStopCapture?.(() => stopCapture());
    window.budAPI.onCartesiaMute?.((muted) => setMuted(muted));
    window.budAPI.onCartesiaTTSAudio?.((event) => handleAudioEvent(event));
    window.budAPI.onCartesiaTTSStop?.(() => stopPlayback());
  }


  window.cartesiaRealtime = {
    startCapture,
    stopCapture,
    setMuted,
    stopPlayback,
  };
})();
