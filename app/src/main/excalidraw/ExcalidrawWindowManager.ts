import { app, BrowserWindow } from 'electron';
import path from 'path';

/**
 * Lifecycle manager for the embedded Excalidraw canvas BrowserWindow.
 *
 * - Lazily creates the window.
 * - Loads the Vite-built canvas renderer.
 * - Uses the dedicated canvas preload (not the panel/overlay preload).
 * - Reuses and focuses an existing live window.
 *
 * S1 scope: no global hotkey/session toggle wiring.
 */
export class ExcalidrawWindowManager {
  private window: BrowserWindow | null = null;

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  /**
   * Create the canvas window if it does not exist, or show/focus the existing one.
   * Resolves once the underlying webContents has finished loading.
   */
  async openOrFocus(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) {
        this.window.restore();
      }
      this.window.show();
      this.window.focus();
      return this.window;
    }

    const preloadPath = path.join(app.getAppPath(), 'dist', 'main', 'canvasPreload.js');
    const htmlPath = path.join(app.getAppPath(), 'dist', 'renderer', 'canvas', 'index.html');

    this.window = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      title: 'Bud Canvas',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const loadFinished = new Promise<void>((resolve) => {
      this.window!.webContents.once('did-finish-load', () => resolve());
    });

    this.window.once('closed', () => {
      this.window = null;
    });

    await this.window.loadFile(htmlPath);
    await loadFinished;

    this.window.show();
    this.window.focus();

    return this.window;
  }

  /**
   * Send an IPC message to the canvas renderer if the window is alive.
   */
  sendToCanvas(channel: string, data: unknown): void {
    if (!this.window || this.window.isDestroyed()) {
      console.warn(`⚠️ Cannot send ${channel}: canvas window is not available`);
      return;
    }
    this.window.webContents.send(channel, data);
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }
}
