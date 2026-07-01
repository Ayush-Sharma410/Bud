/**
 * Bud — Settings Manager (Excalidraw Voice Copilot)
 *
 * Persistent JSON settings in the app data directory. Cross-platform.
 * Owns model name, hotkeys, and the Excalidraw canvas config.
 */
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export type CanvasTheme = 'light' | 'dark' | 'auto';

export interface ExcalidrawSettings {
  /** Accelerator that toggles the canvas voice session. */
  toggleHotkey: string;
  /** Directory where autosaved session files are written. */
  saveDirectory: string;
  /** Autosave interval in milliseconds. */
  autosaveIntervalMs: number;
  /** Maximum number of recent sessions to keep in the index. */
  maxRecentSessions: number;
  /** Canvas UI theme. */
  theme: CanvasTheme;
  /** Safety-gate thresholds for immediate vs. proposed edits. */
  safetyThresholds: {
    maxElementsPerImmediateApply: number;
    maxElementsPerDelete: number;
  };
  /** Snapshot-ring limits for undo fallback. */
  snapshotRing: {
    maxOperations: number;
    maxAgeMs: number;
  };
}

export interface AppSettings {
  /** Chat/voice LLM model name (env OPENAI_MODEL overrides). */
  model: string;
  /** Accelerator that toggles mute. */
  muteHotkey: string;
  /** Excalidraw canvas config. */
  excalidraw: ExcalidrawSettings;
}

const SETTINGS_FILE = 'settings.json';

const DEFAULT_EXCALIDRAW_SETTINGS: ExcalidrawSettings = {
  toggleHotkey: 'CommandOrControl+Shift+Space',
  saveDirectory: path.join(app.getPath('userData'), 'excalidraw-sessions'),
  autosaveIntervalMs: 5000,
  maxRecentSessions: 20,
  theme: 'auto',
  safetyThresholds: {
    maxElementsPerImmediateApply: 5,
    maxElementsPerDelete: 3,
  },
  snapshotRing: {
    maxOperations: 50,
    maxAgeMs: 1_800_000, // 30 minutes
  },
};

export class SettingsManager {
  private filePath: string;
  private currentSettings: AppSettings;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), SETTINGS_FILE);
    this.currentSettings = this.loadSettings();
  }

  private defaults(): AppSettings {
    return {
      model: process.env.OPENAI_MODEL || 'gpt-5.1',
      muteHotkey: 'CommandOrControl+Alt+M',
      excalidraw: DEFAULT_EXCALIDRAW_SETTINGS,
    };
  }

  private loadSettings(): AppSettings {
    const defaults = this.defaults();
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        console.log('⚙️ Settings loaded from:', this.filePath);
        return {
          ...defaults,
          ...parsed,
          excalidraw: {
            ...defaults.excalidraw,
            ...(parsed.excalidraw || {}),
            safetyThresholds: {
              ...defaults.excalidraw.safetyThresholds,
              ...(parsed.excalidraw?.safetyThresholds || {}),
            },
            snapshotRing: {
              ...defaults.excalidraw.snapshotRing,
              ...(parsed.excalidraw?.snapshotRing || {}),
            },
          },
        };
      }
    } catch (err) {
      console.error('⚠️ Failed to load settings, falling back to defaults:', err);
    }
    return defaults;
  }

  getSettings(): AppSettings {
    return this.currentSettings;
  }

  saveSettings(settings: Partial<AppSettings>) {
    this.currentSettings = {
      ...this.currentSettings,
      ...settings,
      excalidraw: {
        ...this.currentSettings.excalidraw,
        ...(settings.excalidraw || {}),
        safetyThresholds: {
          ...this.currentSettings.excalidraw.safetyThresholds,
          ...(settings.excalidraw?.safetyThresholds || {}),
        },
        snapshotRing: {
          ...this.currentSettings.excalidraw.snapshotRing,
          ...(settings.excalidraw?.snapshotRing || {}),
        },
      },
    };
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.currentSettings, null, 2), 'utf-8');
      console.log('⚙️ Settings saved successfully');
    } catch (err) {
      console.error('⚠️ Failed to save settings:', err);
    }
  }
}
