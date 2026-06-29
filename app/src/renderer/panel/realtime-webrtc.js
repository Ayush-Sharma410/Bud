class RealtimeWebRTC {
  constructor() {
    this.pc = null;
    this.dc = null;
    this.audioElement = null;
    this.micStream = null;
    this.connected = false;
    this.sdpEndpoint = '';
    this.eventHandlers = new Map();
    this.playbackStopped = false;
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const h of handlers) {
        try { h(data); } catch (err) { console.error(`[RealtimeWebRTC] handler error (${event}):`, err); }
      }
    }
  }

  setSDPEndpoint(endpoint) {
    this.sdpEndpoint = endpoint;
  }

  async connect() {
    if (this.connected) return;

    if (this.pc) {
      console.log('[RealtimeWebRTC] Cleaning up stale peer connection before reconnect');
      this.cleanup();
    }

    try {
      this.pc = new RTCPeerConnection();

      this.audioElement = document.createElement('audio');
      this.audioElement.autoplay = true;
      this.pc.ontrack = (e) => {
        this.audioElement.srcObject = e.streams[0];
        console.log('[RealtimeWebRTC] Remote audio track received');
        this.emit('audio.track', e.streams[0]);
      };

      if (!this.micStream) {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 24000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }
      this.micStream.getTracks().forEach((track) => this.pc.addTrack(track));

      this.dc = this.pc.createDataChannel('oai-events');
      this.dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'input_audio_buffer.speech_started') {
            this.stopPlayback();
          }
          if (event.type === 'response.created') {
            this.resumePlayback();
          }
          this.emit('server-event', event);
        } catch (err) {
          console.error('[RealtimeWebRTC] Failed to parse server event:', err);
        }
      };
      this.dc.onopen = () => {
        console.log('[RealtimeWebRTC] Data channel open');
        this.emit('datachannel.open');
      };
      this.dc.onclose = () => {
        console.log('[RealtimeWebRTC] Data channel closed');
        this.emit('datachannel.close');
        this.cleanup();
        this.emit('disconnected', 'datachannel-closed');
      };

      this.pc.oniceconnectionstatechange = () => {
        console.log('[RealtimeWebRTC] ICE state:', this.pc.iceConnectionState);
        this.emit('ice-state', this.pc.iceConnectionState);
        if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
          this.connected = true;
          this.emit('connected');
        } else if (this.pc.iceConnectionState === 'disconnected' || this.pc.iceConnectionState === 'failed') {
          this.connected = false;
          this.emit('disconnected', this.pc.iceConnectionState);
        }
      };

      this.pc.onconnectionstatechange = () => {
        console.log('[RealtimeWebRTC] Connection state:', this.pc.connectionState);
        this.emit('connection-state', this.pc.connectionState);
      };

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const sdpResponse = await fetch(this.sdpEndpoint, {
        method: 'POST',
        body: offer.sdp,
        headers: { 'Content-Type': 'application/sdp' },
      });

      if (!sdpResponse.ok) {
        const errText = await sdpResponse.text();
        throw new Error(`SDP exchange failed (${sdpResponse.status}): ${errText}`);
      }

      const answerSDP = await sdpResponse.text();
      await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSDP });

      console.log('[RealtimeWebRTC] SDP exchange complete, connecting...');
    } catch (err) {
      console.error('[RealtimeWebRTC] Connection failed:', err);
      this.emit('error', err);
      this.cleanup();
      throw err;
    }
  }

  disconnect() {
    this.cleanup();
    this.emit('disconnected', 'intentional');
  }

  cleanup() {
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }
    this.playbackStopped = false;
    this.connected = false;
  }

  send(event) {
    if (!this.dc || this.dc.readyState !== 'open') {
      console.warn('[RealtimeWebRTC] Cannot send — data channel not open');
      return false;
    }
    try {
      const payload = JSON.stringify(event);
      if (payload.length > 200000) {
        console.warn(`[RealtimeWebRTC] Message too large (${payload.length} bytes), dropping:`, event.type);
        return false;
      }
      this.dc.send(payload);
      return true;
    } catch (err) {
      console.error('[RealtimeWebRTC] Failed to send event:', err);
      return false;
    }
  }

  setMuted(muted) {
    if (this.micStream) {
      this.micStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
  }

  stopPlayback() {
    if (this.audioElement) {
      this.audioElement.pause();
      this.playbackStopped = true;
      console.log('[RealtimeWebRTC] Playback interrupted — audio paused');
    }
  }

  resumePlayback() {
    if (this.audioElement && this.playbackStopped) {
      this.playbackStopped = false;
      this.audioElement.play().catch((err) => {
        console.warn('[RealtimeWebRTC] Resume playback failed:', err);
      });
      console.log('[RealtimeWebRTC] Playback resumed');
    }
  }

  stopMic() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
  }

  isConnected() {
    return this.connected && this.pc && this.pc.connectionState === 'connected';
  }
}

window.realtimeWebRTC = new RealtimeWebRTC();
