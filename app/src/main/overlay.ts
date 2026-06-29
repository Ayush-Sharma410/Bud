/**
 * Bud — Overlay Window Manager
 *
 * Creates and manages the transparent, always-on-top overlay window
 * that displays the companion cursor, response text, waveform, and
 * pointing animations.
 *
 * Replaces: OverlayWindow.swift
 */
import { BrowserWindow, screen } from 'electron';
import path from 'path';

export class OverlayManager {
  private overlayWindow: BrowserWindow | null = null;

  constructor() {
    this.createOverlay();
    this.registerDisplayChangeHandlers();
  }

  private registerDisplayChangeHandlers() {
    // Recreate the overlay when the display layout changes so combined bounds,
    // scale factors and origins stay in sync with AnnotationController.
    const recreate = () => {
      console.log('[DEBUG-ann2] overlay: display configuration changed, recreating overlay');
      this.destroy();
      this.createOverlay();
    };

    screen.on('display-added' as any, recreate);
    screen.on('display-removed' as any, recreate);
    screen.on('display-metrics-changed' as any, recreate);
  }

  private createOverlay() {
    // Get the combined bounds of all displays
    const displays = screen.getAllDisplays();
    const bounds = this.getCombinedBounds(displays);

    this.overlayWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      thickFrame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      // Click-through: mouse events pass to windows below
      // We'll selectively enable input when needed
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Make click-through on Windows
    this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });

    // Keep always on top at screen-saver level
    this.overlayWindow.setAlwaysOnTop(true, 'screen-saver');

    // Load overlay HTML
    this.overlayWindow.loadFile(
      path.join(__dirname, '..', '..', 'src', 'renderer', 'overlay', 'index.html')
    );

    // Don't show in alt-tab
    this.overlayWindow.setSkipTaskbar(true);
  }

  /**
   * Get the overlay BrowserWindow instance.
   * Used to route audio playback through the overlay renderer.
   */
  getWindow(): BrowserWindow | null {
    return this.overlayWindow;
  }

  /**
   * Send a message to the overlay renderer process via IPC.
   */
  sendToOverlay(channel: string, data: any) {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.webContents.send(channel, data);
    }
  }

  /**
   * Calculate the bounding rectangle that covers all monitors.
   */
  private getCombinedBounds(
    displays: Electron.Display[]
  ): { x: number; y: number; width: number; height: number } {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const display of displays) {
      const { x, y, width, height } = display.bounds;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  destroy() {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
  }
}
