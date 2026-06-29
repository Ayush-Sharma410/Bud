/**
 * Bud — System Tray Manager
 *
 * Creates the system tray icon and context menu.
 * Replaces: MenuBarPanelManager.swift (NSStatusItem part)
 */
import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';

interface TrayManagerOptions {
  onTrayClick: () => void;
  onQuit: () => void;
}

export class TrayManager {
  private tray: Tray;

  constructor(private options: TrayManagerOptions) {
    // Create a simple 16x16 tray icon (blue circle as placeholder)
    const icon = nativeImage.createFromBuffer(
      this.createPlaceholderIcon()
    );

    this.tray = new Tray(icon.resize({ width: 16, height: 16 }));
    this.tray.setToolTip('Bud — Desktop Companion');

    // Left-click opens panel
    this.tray.on('click', () => {
      this.options.onTrayClick();
    });

    // Right-click shows context menu
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Bud Panel',
        click: () => this.options.onTrayClick(),
      },
      { type: 'separator' },
      {
        label: 'Quit Bud',
        click: () => this.options.onQuit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  getTrayBounds() {
    return this.tray.getBounds();
  }

  /**
   * Creates a simple blue circle icon as a placeholder.
   * Replace with actual icon file later.
   */
  private createPlaceholderIcon(): Buffer {
    const width = 16;
    const height = 16;
    const headerSize = 54;
    const pixelSize = width * height * 4;
    const fileSize = headerSize + pixelSize;
    const buffer = Buffer.alloc(fileSize);

    // --- BMP Header ---
    buffer.write('BM', 0); // Signature
    buffer.writeUInt32LE(fileSize, 2); // File size
    buffer.writeUInt32LE(0, 6); // Reserved
    buffer.writeUInt32LE(headerSize, 10); // Offset to pixel data

    // --- DIB Header (BITMAPINFOHEADER) ---
    buffer.writeUInt32LE(40, 14); // DIB Header size
    buffer.writeInt32LE(width, 18); // Width
    buffer.writeInt32LE(-height, 22); // Height (negative for top-down)
    buffer.writeUInt16LE(1, 26); // Planes
    buffer.writeUInt16LE(32, 28); // Bits per pixel (32-bit for RGBA)
    buffer.writeUInt32LE(0, 30); // Compression (0 = BI_RGB)
    buffer.writeUInt32LE(pixelSize, 34); // Image size
    buffer.writeInt32LE(0, 38); // X pixels per meter
    buffer.writeInt32LE(0, 42); // Y pixels per meter
    buffer.writeUInt32LE(0, 46); // Colors used
    buffer.writeUInt32LE(0, 50); // Important colors

    // --- Pixel Data (BGRA format for BMP) ---
    const channels = 4;
    const startOffset = headerSize;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = startOffset + (y * width + x) * channels;
        const cx = x - width / 2;
        const cy = y - height / 2;
        const dist = Math.sqrt(cx * cx + cy * cy);

        if (dist < width / 2 - 1) {
          // Blue circle (BGRA)
          buffer[idx] = 244;     // B
          buffer[idx + 1] = 133; // G
          buffer[idx + 2] = 66;  // R
          buffer[idx + 3] = 255; // A
        } else {
          // Transparent
          buffer[idx + 3] = 0;
        }
      }
    }

    return buffer;
  }
}
