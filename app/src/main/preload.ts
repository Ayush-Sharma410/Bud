/**
 * Bud — Preload Script
 *
 * Exposes a safe API to renderer processes via contextBridge.
 * Renderers (overlay, panel) use window.budAPI to communicate
 * with the main process.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('budAPI', {
  // --- Status ---
  getStatus: () => ipcRenderer.invoke('get-status'),

  // --- Screen Capture ---
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  // --- Settings ---
  setProvider: (provider: string) => ipcRenderer.invoke('set-provider', provider),
  setModel: (model: string) => ipcRenderer.invoke('set-model', model),
  toggleCursor: (enabled: boolean) => ipcRenderer.invoke('toggle-cursor', enabled),

  // --- Realtime Audio Capture ---
  sendRealtimePCM: (base64: string) => ipcRenderer.send('realtime-pcm-chunk', base64),
  onStartRealtimeCapture: (callback: () => void) => {
    ipcRenderer.on('start-realtime-capture', callback);
  },
  onStopRealtimeCapture: (callback: () => void) => {
    ipcRenderer.on('stop-realtime-capture', callback);
  },

  // --- Realtime WebRTC ---
  onWebRTCConnect: (callback: (config: { sdpEndpoint: string }) => void) => {
    ipcRenderer.on('realtime-webrtc-connect', (_event, config) => callback(config));
  },
  onWebRTCDisconnect: (callback: () => void) => {
    ipcRenderer.on('realtime-webrtc-disconnect', callback);
  },
  onWebRTCSend: (callback: (event: any) => void) => {
    ipcRenderer.on('realtime-webrtc-send', (_event, data) => callback(data));
  },
  onWebRTCMute: (callback: (muted: boolean) => void) => {
    ipcRenderer.on('realtime-webrtc-mute', (_event, muted) => callback(muted));
  },
  sendWebRTCEvent: (event: any) => ipcRenderer.send('realtime-webrtc-event', event),
  sendWebRTCConnected: () => ipcRenderer.send('realtime-webrtc-connected'),
  sendWebRTCDataChannelOpen: () => ipcRenderer.send('realtime-webrtc-datachannel-open'),
  sendWebRTCDisconnected: (reason: string) => ipcRenderer.send('realtime-webrtc-disconnected', reason),
  sendWebRTCError: (error: string) => ipcRenderer.send('realtime-webrtc-error', error),

  // --- Audio Playback (TTS) ---
  // Main process → renderer: play audio from base64 WAV data
  onPlayAudio: (callback: (base64: string) => void) => {
    ipcRenderer.on('play-audio', (_event, base64) => callback(base64));
  },
  onStopAudio: (callback: () => void) => {
    ipcRenderer.on('stop-audio', callback);
  },
  // Renderer → main: report playback state
  audioPlaybackEnded: () => ipcRenderer.send('audio-playback-ended'),

  // --- Cartesia Realtime ---
  onCartesiaStartCapture: (callback: () => void) => {
    ipcRenderer.on('cartesia-start-capture', callback);
  },
  onCartesiaStopCapture: (callback: () => void) => {
    ipcRenderer.on('cartesia-stop-capture', callback);
  },
  onCartesiaMute: (callback: (muted: boolean) => void) => {
    ipcRenderer.on('cartesia-mute', (_event, muted) => callback(muted));
  },
  onCartesiaTTSAudio: (callback: (event: { contextId: string; base64Audio: string; done: boolean }) => void) => {
    ipcRenderer.on('cartesia-tts-audio', (_event, event) => callback(event));
  },
  onCartesiaTTSStop: (callback: () => void) => {
    ipcRenderer.on('cartesia-tts-stop', callback);
  },

  // --- Event listeners (overlay) ---
  onPushToTalkStart: (callback: () => void) => {
    ipcRenderer.on('ptt-start', callback);
  },
  onPushToTalkEnd: (callback: () => void) => {
    ipcRenderer.on('ptt-end', callback);
  },
  onStateChange: (callback: (state: string) => void) => {
    ipcRenderer.on('state-change', (_event, state) => callback(state));
  },
  onResponse: (callback: (text: string) => void) => {
    ipcRenderer.on('response-text', (_event, text) => callback(text));
  },
  onPointTo: (
    callback: (data: { x: number; y: number; label: string }) => void
  ) => {
    ipcRenderer.on('point-to', (_event, data) => callback(data));
  },
  onDrawAnnotations: (callback: (data: any) => void) => {
    ipcRenderer.on('draw-annotations', (_event, data) => callback(data));
  },
  onClearAnnotations: (callback: () => void) => {
    ipcRenderer.on('clear-annotations', (_event) => callback());
  },
  onToggleCursor: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('toggle-cursor', (_event, enabled) => callback(enabled));
  },

  // --- Floating Pill & Chat Agent Panel ---
  resizePanel: (bounds: { width: number; height: number }) =>
    ipcRenderer.invoke('resize-panel', bounds),
  sendChatMessage: (userMessage: any) =>
    ipcRenderer.send('send-chat-message', userMessage),
  getChatHistory: () =>
    ipcRenderer.invoke('get-chat-history'),
  onChatHistoryUpdated: (callback: (history: any[]) => void) => {
    ipcRenderer.on('chat-history-updated', (_event, history) => callback(history));
  },
  onChatChunk: (callback: (text: string) => void) => {
    ipcRenderer.on('chat-chunk', (_event, text) => callback(text));
  },
  onChatEnd: (callback: () => void) => {
    ipcRenderer.on('chat-end', callback);
  },
  onChatError: (callback: (err: string) => void) => {
    ipcRenderer.on('chat-error', (_event, err) => callback(err));
  },
  // --- Background Agent Tasks ---
  getBackgroundTasks: () => ipcRenderer.invoke('get-background-tasks'),
  getBackgroundTask: (id: string) => ipcRenderer.invoke('get-background-task', id),
  onAgentTaskUpdated: (callback: (task: any) => void) => {
    ipcRenderer.on('agent-task-updated', (_event, task) => callback(task));
  },
  onAgentTasksPoll: (callback: (tasks: any[]) => void) => {
    ipcRenderer.on('agent-tasks-poll', (_event, tasks) => callback(tasks));
  },

  // --- Realtime Voice ---
  toggleRealtimeMute: () => ipcRenderer.invoke('toggle-realtime-mute'),
  getRealtimeState: () => ipcRenderer.invoke('get-realtime-state'),
  sendRealtimeContext: (text?: string, images?: Array<{ dataUrl: string; mediaType: string }>) =>
    ipcRenderer.send('send-realtime-context', { text, images }),
  saveStagedFile: (file: { name: string; mediaType: string; base64: string }) =>
    ipcRenderer.invoke('save-staged-file', file),
  onRealtimeTranscript: (callback: (transcript: string) => void) => {
    ipcRenderer.on('realtime-transcript', (_event, transcript) => callback(transcript));
  },
  onRealtimeResponseChunk: (callback: (text: string) => void) => {
    ipcRenderer.on('realtime-response-chunk', (_event, text) => callback(text));
  },
  onRealtimeResponseText: (callback: (text: string) => void) => {
    ipcRenderer.on('realtime-response-text', (_event, text) => callback(text));
  },
  onRealtimeResponseDone: (callback: () => void) => {
    ipcRenderer.on('realtime-response-done', callback);
  },
  onRealtimeToolResult: (callback: (data: any) => void) => {
    ipcRenderer.on('realtime-tool-result', (_event, data) => callback(data));
  },
  onMuteStateChange: (callback: (muted: boolean) => void) => {
    ipcRenderer.on('mute-state', (_event, muted) => callback(muted));
  },
  onInterruption: (callback: () => void) => {
    ipcRenderer.on('interruption', callback);
  },
});
