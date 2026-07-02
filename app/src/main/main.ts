/**
 * Bud — Main Process Entry Point (Excalidraw Voice Copilot)
 *
 * Cross-platform (Windows, macOS, Linux) Electron main process. Owns:
 * - System tray
 * - Floating Pill / Chat Agent Panel window
 * - Excalidraw canvas controller + window manager
 * - Cartesia voice pipeline (STT → Orchestrator → TTS)
 * - Global hotkeys (canvas session toggle + mute)
 * - The four tools: searchWeb, excalidraw, memory, spawnAgent
 */
import '../logger';
import { app, BrowserWindow, ipcMain, screen, session } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';

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
import { GlobalHotkey } from './globalHotkey';
import { VoiceInputManager } from './voiceInputManager';
import { bus } from './bus';
import { SettingsManager } from './settings';
import { OrchestratorAgent, ORCHESTRATOR_SYSTEM_PROMPT } from './orchestrator';
import { searchWebTool, createMemoryTool, createSpawnAgentTool } from './tools';
import {
  CartesiaRealtimeVoiceManager,
  UISink,
} from './realtime/CartesiaRealtimeVoiceManager';
import { ToolExecutor } from './realtime/RealtimeToolBridge';
import { createExcalidrawTools } from './excalidraw/createExcalidrawTools';
import { ExcalidrawWindowManager } from './excalidraw/ExcalidrawWindowManager';
import { ExcalidrawController } from './excalidraw/ExcalidrawController';
import { SessionStore } from './excalidraw/SessionStore';
import type {
  CanvasApplyResponse,
  CanvasGhostResponse,
  CanvasRedoNativeResponse,
  CanvasRestoreSnapshotResponse,
  CanvasSceneResponse,
  CanvasSnapshotResponse,
  CanvasUndoNativeResponse,
  SceneSummary,
} from './excalidraw/excalidrawTypes';

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.setLoginItemSettings({ openAtLogin: false });

let trayManager: TrayManager;
let panelWindow: BrowserWindow | null = null;
let globalHotkey: GlobalHotkey;
let voiceInputManager: VoiceInputManager | undefined;
let settingsManager: SettingsManager;
let realtimeVoiceManager: CartesiaRealtimeVoiceManager | undefined;
let chatOrchestrator: OrchestratorAgent;
let excalidrawWindowManager: ExcalidrawWindowManager;
let excalidrawController: ExcalidrawController;
let excalidrawSessionStore: SessionStore | undefined;
let memoryDir: string;

let chatHistory: any[] = [
  {
    id: 'welcome',
    role: 'assistant',
    parts: [{ type: 'text', text: "Hey, I'm Bud — your Excalidraw voice copilot. Press Ctrl/Cmd+Shift+Space to open the canvas, then tell me what to draw." }],
  },
];

function sendToPanel(channel: string, data: any) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send(channel, data);
  }
}

const uiSink: UISink = {
  sendState: (state) => sendToPanel('state-change', state),
  sendToUI: (channel, data) => sendToPanel(channel, data),
};

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
  process.env.BUD_USER_DATA = app.getPath('userData');
  memoryDir = path.join(app.getPath('userData'), 'memory');
  console.log('Bud starting...');

  // Auto-grant media (microphone) access so the panel renderer can capture
  // audio even when it doesn't have window focus — Bud is driven by global
  // hotkeys, so the user may trigger PTT / always-on while another app is
  // focused. Without this, getUserMedia can prompt or silently fail off-focus.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
  });

  // 1. System tray
  trayManager = new TrayManager({
    onTrayClick: () => togglePanel(),
    onQuit: () => app.quit(),
  });

  // 2. Excalidraw canvas controller + window manager
  excalidrawWindowManager = new ExcalidrawWindowManager();
  excalidrawController = new ExcalidrawController({
    windowManager: excalidrawWindowManager,
  });

  ipcMain.on('canvas:scene-response', (_event, response: CanvasSceneResponse) => {
    excalidrawController.handleSceneResponse(response);
  });
  ipcMain.on('canvas:scene-change', (_event, scene: SceneSummary) => {
    excalidrawController.onSceneChange(scene);
  });
  ipcMain.on('canvas:apply-response', (_event, response: CanvasApplyResponse) => {
    excalidrawController.handleApplyResponse(response);
  });
  ipcMain.on('canvas:ghost-response', (_event, response: CanvasGhostResponse) => {
    excalidrawController.handleGhostResponse(response);
  });
  ipcMain.on('canvas:snapshot-response', (_event, response: CanvasSnapshotResponse) => {
    excalidrawController.handleSnapshotResponse(response);
  });
  ipcMain.on('canvas:undo-native-response', (_event, response: CanvasUndoNativeResponse) => {
    excalidrawController.handleUndoNativeResponse(response);
  });
  ipcMain.on('canvas:restore-snapshot-response', (_event, response: CanvasRestoreSnapshotResponse) => {
    excalidrawController.handleRestoreSnapshotResponse(response);
  });
  ipcMain.on('canvas:redo-native-response', (_event, response: CanvasRedoNativeResponse) => {
    excalidrawController.handleRedoNativeResponse(response);
  });
  console.log('🎨 Excalidraw canvas controller initialized');

  // 3. Settings + session store
  settingsManager = new SettingsManager();
  excalidrawController.setSettingsProvider(() => settingsManager.getSettings());
  const currentSettings = settingsManager.getSettings();
  excalidrawSessionStore = new SessionStore(
    currentSettings.excalidraw.saveDirectory,
    currentSettings.excalidraw.maxRecentSessions,
  );
  excalidrawController.setSessionStore(excalidrawSessionStore);

  // 4. Cartesia voice pipeline
  const cartesiaApiKey = process.env.CARTESIA_API_KEY || '';
  if (cartesiaApiKey) {
    realtimeVoiceManager = new CartesiaRealtimeVoiceManager({
      config: {
        apiKey: cartesiaApiKey,
        ttsModel: process.env.CARTESIA_TTS_MODEL || 'sonic-3.5',
        ttsVoiceId: process.env.CARTESIA_TTS_VOICE_ID || '',
        sttModel: process.env.CARTESIA_STT_MODEL || 'ink-2',
        sttSampleRate: parseInt(process.env.CARTESIA_STT_SAMPLE_RATE || '24000', 10),
      },
      uiSink,
      onFallbackTriggered: (reason: string) => {
        console.log(`⚠️ Cartesia realtime fallback triggered: ${reason}`);
      },
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    });

    realtimeVoiceManager.on('speech.started', () => {
      excalidrawController.clearProposals();
    });
    realtimeVoiceManager.on('interruption', () => {
      excalidrawController.clearProposals();
    });

    console.log('🎙️ CartesiaRealtimeVoiceManager created — will register tools after panel init');
  } else {
    console.warn('⚠️ CARTESIA_API_KEY not configured — voice disabled');
  }

  // 5. Shared chat orchestrator (text chat path)
  chatOrchestrator = new OrchestratorAgent({
    tools: {},
    system: ORCHESTRATOR_SYSTEM_PROMPT,
  });

  // 6. Global hotkey (canvas toggle). Voice input modes (PTT / always-on /
  //    Escape) are driven by VoiceInputManager via a native keyboard hook.
  globalHotkey = new GlobalHotkey({
    onCanvasToggle: () => {
      excalidrawController.toggleSession().catch((err) => {
        console.error('⚠️ Excalidraw session toggle failed:', err);
      });
    },
    canvasToggleAccelerator: currentSettings.excalidraw.toggleHotkey,
  });

  // 7. Spawn the Floating Pill panel on startup
  togglePanel();

  // 8. Register the four tools with the voice manager + wire voice input modes
  if (realtimeVoiceManager) {
    const excalidrawTools = createExcalidrawTools(excalidrawController);
    const toolExecutors: ToolExecutor[] = [
      toToolExecutor('searchWeb', searchWebTool),
      toToolExecutor('memory', createMemoryTool(memoryDir)),
      toToolExecutor('spawnAgent', createSpawnAgentTool(() => panelWindow)),
      ...excalidrawTools.realtimeExecutors,
    ];
    realtimeVoiceManager.registerTools(toolExecutors);
    console.log('🚀 Voice tools registered — Cartesia connect will fire when panel is ready');

    // 8b. Voice input modes: hold Ctrl+Alt (PTT), Ctrl x3 (always-on), Esc (exit).
    voiceInputManager = new VoiceInputManager({
      onEnterListening: () => realtimeVoiceManager?.setListening(true),
      onExitListening: () => realtimeVoiceManager?.setListening(false),
      onInterrupt: () => realtimeVoiceManager?.interrupt(),
      onModeChange: (mode) => sendToPanel('voice-mode', mode),
    });
  }

  console.log('Bud ready. Hold Ctrl+Alt to talk, Ctrl x3 for always-on, Esc to exit. Ctrl/Cmd+Shift+Space toggles the canvas.');
});

app.on('window-all-closed', () => {
  // Bud lives in the tray — don't quit when windows close.
});

app.on('before-quit', () => {
  voiceInputManager?.destroy();
  realtimeVoiceManager?.destroy();
  excalidrawController?.dispose();
  excalidrawWindowManager?.destroy();
  globalHotkey?.destroy();
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
      // Keep the renderer (mic capture + TTS playback) running at full speed
      // even when the panel doesn't have focus. Without this, Chromium throttles
      // background AudioContexts, so global-hotkey-triggered capture stalls
      // while another app is focused — making the hotkeys feel non-global.
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is the highest always-on-top level on Windows/macOS/Linux,
  // keeping the pill above other always-on-top windows so it's visible on top
  // of every application.
  panelWindow.setAlwaysOnTop(true, 'screen-saver');

  panelWindow.loadFile(
    path.join(__dirname, '..', '..', 'src', 'renderer', 'panel', 'index.html')
  );

  panelWindow.once('ready-to-show', () => {
    panelWindow?.show();
    // Do NOT auto-start mic capture here — Bud is idle by default. Capture is
    // driven by VoiceInputManager (PTT / always-on) via setListening().
    if (realtimeVoiceManager) {
      console.log('🔌 Panel ready — connecting Cartesia STT/TTS');
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

ipcMain.on('send-realtime-context', (_event, data: { text?: string }) => {
  if (!realtimeVoiceManager?.isConnected()) return;
  realtimeVoiceManager.injectContext(data.text || '');
});

ipcMain.on('realtime-pcm-chunk', (_event, base64PCM: string) => {
  realtimeVoiceManager?.handleAudioChunk(base64PCM);
});

function convertCustomHistoryToCoreMessages(history: any[]): any[] {
  return history.map(msg => {
    if (msg.role === 'system') {
      return { role: 'system', content: msg.parts?.[0]?.text || msg.text || '' };
    }

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
            }),
          };
        }
      }
      return { role: 'assistant', content: msg.parts?.[0]?.text || msg.text || '' };
    }

    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: (msg.parts || []).map((p: any) => {
          if (p.type === 'tool-result') {
            return { type: 'tool-result', toolCallId: p.toolCallId, toolName: p.toolName, result: p.result !== undefined ? p.result : p.output };
          }
          return p;
        }),
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
                if (commaIdx !== -1) base64Data = base64Data.substring(commaIdx + 1);
              }
              if (!base64Data) return null;
              return { type: 'image', image: base64Data, mediaType };
            }
            const mediaType = part.mediaType || part.mimeType || 'text/plain';
            const fileName = part.name || part.filename || 'attached file';
            const fileData = part.data || part.content;
            if (fileData && typeof fileData === 'string' && mediaType.startsWith('text/')) {
              return { type: 'text', text: `[Attached file: ${fileName}]\n${fileData}` };
            }
            return { type: 'text', text: `[Attached file: ${fileName} (${mediaType})]` };
          }
          return null;
        }).filter(Boolean);
        return { role: 'user', content };
      }
      return { role: 'user', content: msg.text || '' };
    }

    return { role: msg.role || 'user', content: msg.text || '' };
  });
}

export async function executeChatCompletion(
  onChunk: (text: string) => void,
  onEnd: (finalText: string) => void,
  onError: (err: string) => void
) {
  try {
    const excalidrawTools = createExcalidrawTools(excalidrawController);

    const tools: any = OrchestratorAgent.wrapToolsWithRetry(
      {
        searchWeb: searchWebTool,
        memory: createMemoryTool(memoryDir),
        spawnAgent: createSpawnAgentTool(() => panelWindow),
        ...excalidrawTools.vercelTools,
      },
      chatOrchestrator.events,
      3
    );

    chatOrchestrator.setTools(tools);
    chatOrchestrator.setHistory(convertCustomHistoryToCoreMessages(chatHistory));

    const unsubscribe: (() => void)[] = [];
    let finalText = '';

    unsubscribe.push(
      chatOrchestrator.events.on('text', (chunk) => {
        finalText += chunk;
        onChunk(chunk);
      })
    );

    unsubscribe.push(
      chatOrchestrator.events.on('tts', (text) => {
        console.log('🗣️ Chat TTS snippet:', text);
      })
    );

    unsubscribe.push(
      chatOrchestrator.events.on('toolCall', ({ name }) => {
        console.log(`🔧 Chat tool call: ${name}`);
      })
    );

    unsubscribe.push(
      chatOrchestrator.events.on('error', ({ message }) => {
        onError(message);
      })
    );

    const { finalText: resultText } = await chatOrchestrator.run({
      request: chatHistory[chatHistory.length - 1]?.text || '',
    });

    for (const fn of unsubscribe) fn();

    sendToPanel('chat-history-updated', chatHistory);
    onEnd(resultText || finalText);
  } catch (err: any) {
    console.error('Error in executeChatCompletion:', err);
    onError(err.message || 'Unknown error');
  }
}

ipcMain.on('send-chat-message', async (_event, userMessage) => {
  try {
    chatHistory.push(userMessage);
    sendToPanel('chat-history-updated', chatHistory);

    await executeChatCompletion(
      (chunk) => sendToPanel('chat-chunk', chunk),
      () => sendToPanel('chat-end', null),
      (errText) => sendToPanel('chat-error', errText)
    );
  } catch (err: any) {
    console.error('Error in send-chat-message:', err);
    sendToPanel('chat-error', err.message || 'Unknown error');
  }
});

ipcMain.handle('get-chat-history', () => chatHistory);

ipcMain.handle('save-staged-file', (_event, file: { name: string; mediaType: string; base64: string }) => {
  try {
    const safeName = file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const tmpDir = path.join(os.tmpdir(), 'bud-staged');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `bud-staged-${Date.now()}-${safeName}`);
    fs.writeFileSync(tmpPath, Buffer.from(file.base64, 'base64'));
    return { success: true, path: tmpPath };
  } catch (err: any) {
    console.error('[save-staged-file] Failed:', err);
    return { success: false, error: err.message || 'Failed to save staged file' };
  }
});

ipcMain.handle('get-status', () => {
  return {
    state: realtimeVoiceManager?.getVoiceState() || 'idle',
    settings: settingsManager.getSettings(),
    excalidraw: {
      recentSessions: excalidrawSessionStore?.getRecentSessions(10) ?? [],
    },
  };
});

// Panel settings UI still calls these (provider/cursor are gone); keep no-op
// stubs so the invoke promises resolve and syncSettings runs cleanly.
// TODO: prune the panel settings UI in a follow-up.
ipcMain.handle('set-provider', () => settingsManager.getSettings());
ipcMain.handle('set-model', (_event, model: string) => {
  settingsManager.saveSettings({ model });
  return settingsManager.getSettings();
});
ipcMain.handle('toggle-cursor', () => settingsManager.getSettings());

ipcMain.handle('get-realtime-state', () => {
  if (realtimeVoiceManager) {
    return {
      voiceState: realtimeVoiceManager.getVoiceState(),
      listening: realtimeVoiceManager.getListening(),
      voiceMode: voiceInputManager?.getMode() ?? 'idle',
      connected: realtimeVoiceManager.isConnected(),
    };
  }
  return { voiceState: 'idle', listening: false, voiceMode: 'idle', connected: false };
});

// --- Background Agent Task IPC ---

ipcMain.handle('get-background-tasks', () => bus.getAll());
ipcMain.handle('get-background-task', (_event, id: string) => bus.get(id));

setInterval(() => {
  const tasks = bus.getAll();
  const hasActive = tasks.some(t => t.status === 'running' || t.status === 'pending');
  if (hasActive) sendToPanel('agent-tasks-poll', tasks);
}, 2000);
