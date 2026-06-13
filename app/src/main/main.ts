/**
 * Bud — Main Process Entry Point
 *
 * This is the Electron main process. It creates:
 * - System tray icon (lives in notification area)
 * - Transparent overlay window (companion cursor, spans all monitors)
 * - Control panel window (settings, status — opens from tray click)
 * - Global hotkey listener (mute toggle, agent kill switch)
 * - AgentManager (Computer Use)
 * - RealtimeVoiceManager (primary voice pipeline)
 *
 * Replaces: leanring_buddyApp.swift
 */
import '../logger';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { openai } from '@ai-sdk/openai';
import { streamText, tool, jsonSchema, stepCountIs } from 'ai';
import { bus } from './bus';
import { fork } from 'child_process';
import { randomUUID } from 'crypto';

// Simple custom .env loader to avoid external dependencies
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const firstEquals = trimmed.indexOf('=');
        if (firstEquals === -1) continue;
        const key = trimmed.slice(0, firstEquals).trim();
        let value = trimmed.slice(firstEquals + 1).trim();
        // Remove surrounding quotes if any
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
      console.log('⚙️ Environment loaded from:', envPath);
    } catch (err) {
      console.error('⚠️ Failed to load .env:', err);
    }
  }
}
loadEnv();
import { TrayManager } from './tray';
import { OverlayManager } from './overlay';
import { GlobalHotkey } from './globalHotkey';
import { ScreenCapture } from './screenCapture';
import { ModalVisionProvider } from './providers/ModalVisionProvider';
import { ModalTTSProvider, AudioPlaybackManager } from './providers/ModalTTSProvider';
import { OpenAITTSProvider } from './providers/OpenAITTSProvider';
import { OllamaVisionProvider } from './providers/OllamaVisionProvider';
import { LocalTTSProvider } from './providers/LocalTTSProvider';
import { SettingsManager } from './settings';
import { VisionProvider, TTSProvider, DEFAULT_PROVIDER_CONFIG } from './providers/types';
import { AgentManager } from './agentManager';
import { COMPANION_PROMPT, BUD_SYSTEM_PROMPT } from './agentPrompts';
import {
  createComputerUseTool,
  searchWebTool,
  createSpawnWorkerTool,
  windowsTool,
  appsTool,
  createMemoryTool,
} from './tools';
import { RealtimeVoiceManager } from './realtime/RealtimeVoiceManager';
import { ToolExecutor } from './realtime/RealtimeToolBridge';
import { RealtimeSDPServer } from './realtime/RealtimeSDPServer';
import { AnnotationController } from './annotations/AnnotationController';
import { createDrawAnnotationTools } from './annotations/createDrawAnnotationTool';

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Hide from taskbar — Bud lives in the system tray only
app.setLoginItemSettings({ openAtLogin: false }); // User can enable in settings

let trayManager: TrayManager;
let overlayManager: OverlayManager;
let panelWindow: BrowserWindow | null = null;
let globalHotkey: GlobalHotkey;
let audioPlayback: AudioPlaybackManager;
let settingsManager: SettingsManager;
let agentManager: AgentManager;
let realtimeVoiceManager: RealtimeVoiceManager;
let sdpServer: RealtimeSDPServer;
let annotationController: AnnotationController;
let providers: any;
let memoryDir: string;
let chatHistory: any[] = [
  {
    id: 'welcome',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Hello! I am Bud, your desktop companion. Ask me a question, drag & drop files, or ask me to perform desktop tasks!' }]
  }
];

function createProviders(settings: any) {
  if (settings.mode === 'modal') {
    return {
      visionProvider: new ModalVisionProvider(settings.modal.vlmEndpoint, settings.model),
      ttsProvider: new OpenAITTSProvider(),
    };
  } else {
    return {
      visionProvider: new OllamaVisionProvider(settings.local.ollamaEndpoint, settings.local.ollamaModel),
      ttsProvider: new LocalTTSProvider(),
    };
  }
}

function toToolExecutor(name: string, toolObj: any): ToolExecutor {
  return {
    name,
    description: toolObj.description || '',
    parameters: toolObj.inputSchema?.jsonSchema || toolObj.inputSchema || toolObj.parameters || { type: 'object', properties: {} },
    execute: async (args: any) => {
      if (typeof toolObj.execute === 'function') {
        return toolObj.execute(args, { toolCallId: `rt-${Date.now()}`, messages: [] });
      }
      return { success: false, error: 'No execute function' };
    },
  };
}

// --- App Lifecycle ---

app.whenReady().then(async () => {
  // Let worker processes find the DB
  process.env.BUD_USER_DATA = app.getPath('userData');
  memoryDir = path.join(app.getPath('userData'), 'memory');
  console.log('Bud starting...');

  // 1. Create system tray
  trayManager = new TrayManager({
    onTrayClick: () => togglePanel(),
    onQuit: () => app.quit(),
  });

  // 2. Create overlay window (transparent, always on top)
  overlayManager = new OverlayManager();

  // 2.5 Create annotation controller (shared by realtime and chat)
  annotationController = new AnnotationController({
    sendToOverlay: (channel: string, data: any) => overlayManager.sendToOverlay(channel, data),
    getOverlayWindow: () => overlayManager.getWindow(),
  });

  // 3. Create audio playback manager (uses overlay window for audio)
  audioPlayback = new AudioPlaybackManager();
  // The overlay window is the playback target — it has audio context
  const overlayWindow = overlayManager.getWindow();
  if (overlayWindow) {
    audioPlayback.setTargetWindow(overlayWindow);
  }

  // Listen for playback-ended from the overlay renderer
  ipcMain.on('audio-playback-ended', () => {
    audioPlayback.onPlaybackEnded();
  });

  // 5. Initialize Settings & Create AI providers
  settingsManager = new SettingsManager();
  const currentSettings = settingsManager.getSettings();
  providers = createProviders(currentSettings);

  // 6. Create Agent Manager for Computer Use
  agentManager = new AgentManager({
    visionProvider: providers.visionProvider,
    ttsProvider: providers.ttsProvider,
    audioPlayback,
  });

  // Wire agent narration → TTS playback
  agentManager.setOnNarrate(async (text: string) => {
    try {
      const buffer = await providers.ttsProvider.synthesize(text);
      if (buffer.length > 0) {
        // Play audio in the background concurrently with agent execution
        audioPlayback.playAudio(buffer).catch((err) => {
          console.error('⚠️ Playback error:', err);
        });
      }
    } catch (err) {
      console.error('⚠️ Agent narration TTS failed:', err);
    }
  });

  // 6.5 Create RealtimeVoiceManager — primary voice pipeline (WebRTC)
  const realtimeApiKey = process.env.OPENAI_API_KEY || '';
  if (realtimeApiKey) {
    sdpServer = new RealtimeSDPServer({
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
      apiKey: realtimeApiKey,
      voice: process.env.OPENAI_REALTIME_VOICE || 'cedar',
      instructions: BUD_SYSTEM_PROMPT,
    });

    const sdpPort = await sdpServer.start();
    const sdpEndpoint = sdpServer.getEndpoint();
    console.log(`🔌 SDP relay ready at ${sdpEndpoint}`);

    realtimeVoiceManager = new RealtimeVoiceManager({
      config: {
        model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
        apiKey: realtimeApiKey,
        voice: process.env.OPENAI_REALTIME_VOICE || 'cedar',
        instructions: BUD_SYSTEM_PROMPT,
      },
      sdpEndpoint,
      overlayManager: {
        sendToOverlay: (channel: string, data: any) => overlayManager.sendToOverlay(channel, data),
        getWindow: () => overlayManager.getWindow(),
      },
      panelWindow: () => panelWindow,
      onFallbackTriggered: (reason: string) => {
        console.log(`⚠️ Realtime fallback triggered: ${reason}`);
      },
    });
    realtimeVoiceManager.on('speech.started', () => {
      annotationController.clearAnnotations();
    });

    realtimeVoiceManager.on('interruption', () => {
      annotationController.clearAnnotations();
    });

    console.log('🔌 RealtimeVoiceManager created (WebRTC) — will register tools after panel init');
  } else {
    console.warn('⚠️ OPENAI_API_KEY not set — Realtime voice disabled');
  }

  // 7. Register global hotkey → Agent kill switch + Mute toggle
  // Push-to-talk is disabled — Realtime pipeline is always-on
  globalHotkey = new GlobalHotkey({
    onPushToTalkStart: () => {
      annotationController.clearAnnotations();
    },
    onPushToTalkEnd: () => {},
    onEscapePressed: () => {
      if (agentManager.hasActiveTasks()) {
        console.log('🛑 Escape pressed — aborting all Agent Tasks');
        agentManager.abortAll();
      }
    },
    onMuteToggle: () => {
      if (realtimeVoiceManager) {
        const isMuted = realtimeVoiceManager.toggleMute();
        console.log(`🎙️ Mute toggled: ${isMuted ? 'muted' : 'unmuted'}`);
      }
    },
  });

  // 9. Spawn the Floating Pill panel on startup
  togglePanel();

  // 10. Register tools with RealtimeVoiceManager and start it
  if (realtimeVoiceManager) {
    const drawAnnotationTools = createDrawAnnotationTools(annotationController);

    const captureScreenExecutor: ToolExecutor = {
      name: 'captureScreen',
      description: 'Capture a screenshot of all displays. Returns base64 JPEG images. Use this when you need to see the screen to answer a question or decide on an action.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const captures = await ScreenCapture.captureAllScreens();
        if (captures && captures.length > 0) {
          return {
            success: true,
            screens: captures.map((c, i) => ({
              screenIndex: i,
              width: c.width,
              height: c.height,
              imageBase64: c.imageBase64,
            })),
          };
        }
        return { success: false, error: 'No screens captured' };
      },
    };

    const waitForUserExecutor: ToolExecutor = {
      name: 'wait_for_user',
      description: 'Call this when the latest audio does not need a spoken response, such as silence, background noise, hold music, TV audio, side conversation, or speech not addressed to the assistant. This tool helps end the turn without a spoken reply.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        return { success: true, detail: 'Waiting for user input' };
      },
    };

    const toolExecutors: ToolExecutor[] = [
      toToolExecutor('apps', appsTool),
      toToolExecutor('windows', windowsTool),
      toToolExecutor('searchWeb', searchWebTool),
      toToolExecutor('memory', createMemoryTool(memoryDir)),
      toToolExecutor('computerUse', createComputerUseTool(agentManager)),
      toToolExecutor('spawnWorker', createSpawnWorkerTool(() => panelWindow)),
      captureScreenExecutor,
      waitForUserExecutor,
      drawAnnotationTools.realtimeExecutor,
    ];
    realtimeVoiceManager.registerTools(toolExecutors);
    console.log('🚀 Realtime tools registered — WebRTC connect will fire when panel is ready');
  }

  console.log('Bud ready. Press Ctrl+Alt to talk. Press Escape to stop Agent Tasks.');
});

app.on('window-all-closed', () => {
  // Don't quit when windows close — Bud lives in the tray
  // On Windows, not calling app.quit() keeps the app running
});

app.on('before-quit', () => {
  if (realtimeVoiceManager) {
    realtimeVoiceManager.destroy();
  }
  if (sdpServer) {
    sdpServer.stop();
  }
});

// --- Panel Window ---

function togglePanel() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isVisible()) {
      panelWindow.hide();
    } else {
      panelWindow.show();
      panelWindow.focus();
    }
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const PILL_W = 260;
  const PILL_H = 42;
  const BOTTOM_GAP = 12;

  panelWindow = new BrowserWindow({
    width: PILL_W,
    height: PILL_H,
    x: Math.round((screenWidth - PILL_W) / 2) + primaryDisplay.workArea.x,
    y: primaryDisplay.workArea.y + screenHeight - PILL_H - BOTTOM_GAP,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  panelWindow.loadFile(
    path.join(__dirname, '..', '..', 'src', 'renderer', 'panel', 'index.html')
  );

  panelWindow.once('ready-to-show', () => {
    panelWindow?.show();
    panelWindow?.webContents.send('start-realtime-capture');
    if (realtimeVoiceManager) {
      console.log('🔌 Panel ready — starting WebRTC connect');
      realtimeVoiceManager.start();
    }
  });
}

// --- IPC Handlers ---

ipcMain.handle('resize-panel', (_event, { width, height }) => {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const current = panelWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: current.x + current.width / 2, y: current.y + current.height / 2 });
  const work = display.workArea;
  const centerX = current.x + current.width / 2;
  const bottomY = current.y + current.height;
  let x = Math.round(centerX - width / 2);
  let y = bottomY - height;
  if (x < work.x) x = work.x;
  if (x + width > work.x + work.width) x = work.x + work.width - width;
  if (y < work.y) y = work.y;
  if (y + height > work.y + work.height) y = work.y + work.height - height;
  panelWindow.setBounds({ x, y, width: Math.min(width, work.width), height: Math.min(height, work.height) });
});

ipcMain.on('send-realtime-context', (_event, data: { text?: string; images?: Array<{ dataUrl: string; mediaType: string }> }) => {
  if (!realtimeVoiceManager?.isConnected()) return;
  const text = data.text || '';
  const images = (data.images || []).map(img => ({
    base64: img.dataUrl.replace(/^data:[^;]+;base64,/, ''),
    mediaType: img.mediaType,
  }));
  realtimeVoiceManager.injectContext(text, images.length ? images : undefined);
});

function convertCustomHistoryToCoreMessages(history: any[]): any[] {
  return history.map(msg => {
    if (msg.role === 'system') {
      return {
        role: 'system',
        content: msg.parts?.[0]?.text || msg.text || ''
      };
    }
    
    // Handle assistant messages — may contain text or tool-call parts
    if (msg.role === 'assistant') {
      if (msg.parts && Array.isArray(msg.parts)) {
        const hasToolCalls = msg.parts.some((p: any) => p.type === 'tool-call');
        if (hasToolCalls) {
          return {
            role: 'assistant',
            content: msg.parts.map((p: any) => {
              if (p.type === 'tool-call') {
                return { type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, args: p.args || p.input };
              }
              return { type: 'text', text: p.text || '' };
            })
          };
        }
      }
      return {
        role: 'assistant',
        content: msg.parts?.[0]?.text || msg.text || ''
      };
    }
    
    // Handle tool result messages
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: (msg.parts || []).map((p: any) => {
          if (p.type === 'tool-result') {
            return { type: 'tool-result', toolCallId: p.toolCallId, toolName: p.toolName, result: p.result !== undefined ? p.result : p.output };
          }
          return p;
        })
      };
    }
    
    if (msg.role === 'user') {
      if (msg.parts && Array.isArray(msg.parts)) {
        const content = msg.parts.map((part: any) => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
          } else if (part.type === 'file' || part.type === 'image') {
            const isImage = part.type === 'image' || part.mediaType?.startsWith('image/') || part.url?.startsWith('data:image/');
            if (isImage) {
              let base64Data = part.url || part.data || part.image;
              let mediaType = part.mediaType || part.mimeType || 'image/jpeg';
              
              if (typeof base64Data === 'string' && base64Data.startsWith('data:')) {
                const commaIdx = base64Data.indexOf(',');
                if (commaIdx !== -1) {
                  base64Data = base64Data.substring(commaIdx + 1);
                }
              }
              
              // Ensure we don't pass undefined. If no data, skip.
              if (!base64Data) return null;
              
              return {
                type: 'image',
                image: base64Data,
                mediaType: mediaType
              };
            } else {
              let fileData = part.url || part.data || part.content;
              if (!fileData) return null;
              return {
                type: 'file',
                data: fileData,
                mediaType: part.mediaType || part.mimeType || 'text/plain'
              };
            }
          }
          return null;
        }).filter(Boolean);
        
        return {
          role: 'user',
          content
        };
      }
      
      return {
        role: 'user',
        content: msg.text || ''
      };
    }
    
    return {
      role: msg.role || 'user',
      content: msg.text || ''
    };
  });
}

export async function executeChatCompletion(
  onChunk: (text: string) => void,
  onEnd: (finalText: string) => void,
  onError: (err: string) => void
) {
  try {
    const modelName = process.env.OPENAI_MODEL || 'gpt-5.1';
    console.log(`🤖 Chat completion starting with model: ${modelName}, history size: ${chatHistory.length}`);

    let currentMessages = convertCustomHistoryToCoreMessages(chatHistory);

    // Define tools for the orchestrator
    const drawAnnotationTools = createDrawAnnotationTools(annotationController);

    const tools: any = {
      computerUse: createComputerUseTool(agentManager),
      searchWeb: searchWebTool,
      spawnWorker: createSpawnWorkerTool(() => panelWindow),
      windows: windowsTool,
      apps: appsTool,
      memory: createMemoryTool(memoryDir),
      drawAnnotation: drawAnnotationTools.vercelTool,
      captureScreen: tool({
        description: 'Capture screenshots of all displays for visual context. Use when you need to see the screen to answer questions or decide on actions.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {},
          required: [],
        }),
        execute: async () => {
          const captures = await ScreenCapture.captureAllScreens();
          if (captures && captures.length > 0) {
            return {
              success: true,
              screens: captures.map((c, i) => ({
                screenIndex: i,
                width: c.width,
                height: c.height,
                imageBase64: c.imageBase64,
              })),
            };
          }
          return { success: false, error: 'No screens captured' };
        },
      }),
    };

    console.log(`🤖 Streaming response with maxSteps: 20...`);
    const result = streamText({
      model: openai(modelName),
      messages: currentMessages,
      system: COMPANION_PROMPT,
      tools: tools,
      stopWhen: stepCountIs(20),
      async onStepFinish({ toolCalls }) {
        if (toolCalls.length > 0) {
          const names = toolCalls.map(tc => tc.toolName).join(', ');
          console.log(`🤖 Step finished — tools used: ${names}`);
        }
      }
    });

    let finalText = '';
    for await (const chunk of result.textStream) {
      finalText += chunk;
      onChunk(chunk);
    }

    // Removed manual responseMessages persistence as Vercel AI SDK handles history natively

    // Broadcast history update to the panel renderer
    panelWindow?.webContents.send('chat-history-updated', chatHistory);

    onEnd(finalText);

  } catch (err: any) {
    console.error('Error in executeChatCompletion:', err);
    onError(err.message || 'Unknown error');
  }
}

ipcMain.on('send-chat-message', async (event, userMessage) => {
  try {
    annotationController.resetLifecycle();

    chatHistory.push(userMessage);
    panelWindow?.webContents.send('chat-history-updated', chatHistory);

    await executeChatCompletion(
      (chunk) => {
        panelWindow?.webContents.send('chat-chunk', chunk);
      },
      (finalText) => {
        panelWindow?.webContents.send('chat-end');
      },
      (errText) => {
        panelWindow?.webContents.send('chat-error', errText);
      }
    );
  } catch (err: any) {
    console.error('Error in send-chat-message:', err);
    panelWindow?.webContents.send('chat-error', err.message || 'Unknown error');
  }
});

ipcMain.handle('get-chat-history', () => {
  return chatHistory;
});

ipcMain.handle('get-status', () => {
  return {
    state: realtimeVoiceManager?.getVoiceState() || 'idle',
    settings: settingsManager.getSettings(),
  };
});

ipcMain.handle('capture-screen', async () => {
  const captures = await ScreenCapture.captureAllScreens();
  return captures;
});

ipcMain.handle('set-provider', (_event, providerMode: 'modal' | 'local') => {
  console.log(`Provider switch requested: ${providerMode}`);
  settingsManager.saveSettings({ mode: providerMode });
  
  const newProviders = createProviders(settingsManager.getSettings());
  agentManager.setProviders(newProviders);
  return settingsManager.getSettings();
});

ipcMain.handle('set-model', (_event, model: string) => {
  console.log(`Model switch requested: ${model}`);
  settingsManager.saveSettings({ model });
  
  const newProviders = createProviders(settingsManager.getSettings());
  agentManager.setProviders(newProviders);
  return settingsManager.getSettings();
});

ipcMain.handle('toggle-cursor', (_event, enabled: boolean) => {
  console.log(`Cursor toggle: ${enabled}`);
  settingsManager.saveSettings({ cursorEnabled: enabled });
  overlayManager.sendToOverlay('toggle-cursor', enabled);
  return settingsManager.getSettings();
});

ipcMain.handle('get-agent-tasks', () => {
  return agentManager?.getActiveTasks() || [];
});

ipcMain.handle('abort-agent-tasks', () => {
  agentManager?.abortAll();
  return { success: true };
});

ipcMain.handle('toggle-realtime-mute', () => {
  if (realtimeVoiceManager) {
    const isMuted = realtimeVoiceManager.toggleMute();
    return { muted: isMuted };
  }
  return { muted: false, error: 'Realtime not available' };
});

ipcMain.handle('get-realtime-state', () => {
  if (realtimeVoiceManager) {
    return {
      voiceState: realtimeVoiceManager.getVoiceState(),
      muted: realtimeVoiceManager.getMuted(),
      connected: realtimeVoiceManager.isConnected(),
    };
  }
  return { voiceState: 'idle', muted: false, connected: false };
});
// --- Background Agent Task IPC ---

ipcMain.handle('get-background-tasks', () => {
  return bus.getAll();
});

ipcMain.handle('get-background-task', (_event, id: string) => {
  return bus.get(id);
});

// Renderer can also set up a poll — push updates every 2s while tasks are running
setInterval(() => {
  const tasks = bus.getAll();
  const hasActive = tasks.some(t => t.status === 'running' || t.status === 'pending');
  if (hasActive && panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('agent-tasks-poll', tasks);
  }
}, 2000);