/**
 * Bud — Settings Manager
 *
 * Handles persistent settings storage (JSON file in app data directory).
 * Saves provider choice, model configuration, custom endpoint URLs, and UI settings.
 */
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { ProviderConfig, DEFAULT_PROVIDER_CONFIG } from './providers/types';

export type CanvasTheme = 'light' | 'dark' | 'auto';

export interface ExcalidrawSettings {
  /** Accelerator that toggles the canvas voice session. */
  toggleHotkey: string;
  /** Directory where autosaved session files are written. */
  saveDirectory: string;
  /** Autosave interval in milliseconds. */
  autosaveIntervalMs: number;
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

export interface AppSettings extends ProviderConfig {
  cursorEnabled: boolean;
  excalidraw: ExcalidrawSettings;
}

const SETTINGS_FILE = 'settings.json';

const DEFAULT_EXCALIDRAW_SETTINGS: ExcalidrawSettings = {
  toggleHotkey: 'CommandOrControl+Shift+Space',
  saveDirectory: path.join(app.getPath('userData'), 'excalidraw-sessions'),
  autosaveIntervalMs: 5000,
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

  private loadSettings(): AppSettings {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data);
        console.log('⚙️ Settings loaded from:', this.filePath);
        return {
          ...DEFAULT_PROVIDER_CONFIG,
          cursorEnabled: true,
          ...parsed,
          // Nested merges to ensure sub-objects are not overridden entirely
          modal: {
            ...DEFAULT_PROVIDER_CONFIG.modal,
            ...(parsed.modal || {}),
          },
          local: {
            ...DEFAULT_PROVIDER_CONFIG.local,
            ...(parsed.local || {}),
          },
          excalidraw: {
            ...DEFAULT_EXCALIDRAW_SETTINGS,
            ...(parsed.excalidraw || {}),
            safetyThresholds: {
              ...DEFAULT_EXCALIDRAW_SETTINGS.safetyThresholds,
              ...(parsed.excalidraw?.safetyThresholds || {}),
            },
            snapshotRing: {
              ...DEFAULT_EXCALIDRAW_SETTINGS.snapshotRing,
              ...(parsed.excalidraw?.snapshotRing || {}),
            },
          },
        };
      }
    } catch (err) {
      console.error('⚠️ Failed to load settings, falling back to defaults:', err);
    }
    return {
      ...DEFAULT_PROVIDER_CONFIG,
      cursorEnabled: true,
      excalidraw: DEFAULT_EXCALIDRAW_SETTINGS,
    };
  }

  getSettings(): AppSettings {
    return this.currentSettings;
  }

  saveSettings(settings: Partial<AppSettings>) {
    this.currentSettings = {
      ...this.currentSettings,
      ...settings,
      modal: {
        ...this.currentSettings.modal,
        ...(settings.modal || {}),
      },
      local: {
        ...this.currentSettings.local,
        ...(settings.local || {}),
      },
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
