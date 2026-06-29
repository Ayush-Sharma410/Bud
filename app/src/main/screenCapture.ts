/**
 * Bud — Screen Capture Utility
 *
 * Captures all connected monitors as JPEG images with metadata
 * (dimensions, cursor position, cursor screen).
 *
 * Replaces: CompanionScreenCaptureUtility.swift
 */
import { screen } from 'electron';

export interface ScreenCaptureResult {
  screenIndex: number;
  width: number;
  height: number;
  scaleFactor: number;
  isCursorScreen: boolean;
  imageBase64: string; // JPEG base64
}

export class ScreenCapture {
  /**
   * Capture all connected screens and return JPEG base64 data.
   * Identifies which screen the cursor is on.
   */
  static async captureAllScreens(): Promise<ScreenCaptureResult[]> {
    const displays = screen.getAllDisplays();
    const cursorPoint = screen.getCursorScreenPoint();
    const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);

    const results: ScreenCaptureResult[] = [];

    try {
      // Use screenshot-desktop for reliable cross-platform capture
      const screenshot = require('screenshot-desktop');
      const screenshots: Buffer[] = await screenshot.listDisplays().then(
        (displays: any[]) =>
          Promise.all(
            displays.map((_: any, i: number) =>
              screenshot({ screen: i, format: 'jpg' })
            )
          )
      );

      for (let i = 0; i < displays.length; i++) {
        const display = displays[i];
        const imgBuffer = screenshots[i] || Buffer.alloc(0);

        // screenshot-desktop captures in physical pixels, while Electron's
        // display.size/display.bounds are logical/DIP. Report the actual image
        // dimensions so downstream coordinate systems stay consistent.
        const scaleFactor = display.scaleFactor || 1;
        const reportedWidth = Math.round(display.size.width * scaleFactor);
        const reportedHeight = Math.round(display.size.height * scaleFactor);
        console.log(`[DEBUG-ann2] captureScreen ${i}: display.size=${display.size.width}x${display.size.height}, scale=${scaleFactor}, reported=${reportedWidth}x${reportedHeight}, bufferBytes=${imgBuffer.length}`);
        results.push({
          screenIndex: i,
          width: reportedWidth,
          height: reportedHeight,
          scaleFactor: display.scaleFactor,
          isCursorScreen: display.id === cursorDisplay.id,
          imageBase64: imgBuffer.toString('base64'),
        });
      }
    } catch (err) {
      console.error('Screen capture failed, falling back to empty:', err);

      // Fallback: return metadata without images
      for (let i = 0; i < displays.length; i++) {
        const display = displays[i];
        const scaleFactor = display.scaleFactor || 1;
        results.push({
          screenIndex: i,
          width: Math.round(display.size.width * scaleFactor),
          height: Math.round(display.size.height * scaleFactor),
          scaleFactor: display.scaleFactor,
          isCursorScreen: display.id === cursorDisplay.id,
          imageBase64: '',
        });
      }
    }

    return results;
  }
}
