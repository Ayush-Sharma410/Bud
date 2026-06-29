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

export interface AppSettings extends ProviderConfig {
  cursorEnabled: boolean;
}

const SETTINGS_FILE = 'settings.json';

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
        };
      }
    } catch (err) {
      console.error('⚠️ Failed to load settings, falling back to defaults:', err);
    }
    return {
      ...DEFAULT_PROVIDER_CONFIG,
      cursorEnabled: true,
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
    };
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.currentSettings, null, 2), 'utf-8');
      console.log('⚙️ Settings saved successfully');
    } catch (err) {
      console.error('⚠️ Failed to save settings:', err);
    }
  }
}
