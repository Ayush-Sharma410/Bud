import { screen, BrowserWindow } from 'electron';
import {
  Annotation,
  AnnotationType,
  AnnotationResult,
  DrawAnnotationArgs,
  NormalizedAnnotation,
} from './annotationTypes';
import { GridLocator } from './gridLocator';
import { ScreenCapture, ScreenCaptureResult } from '../screenCapture';

const DEFAULT_CLEAR_TIMEOUT_MS = 10000;

export interface AnnotationControllerOptions {
  sendToOverlay: (channel: string, data: any) => void;
  getOverlayWindow: () => BrowserWindow | null;
  gridLocator?: GridLocator;
  captureScreensFn?: () => Promise<ScreenCaptureResult[]>;
}

export class AnnotationController {
  private sendToOverlay: (channel: string, data: any) => void;
  private getOverlayWindow: () => BrowserWindow | null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private gridLocator: GridLocator;
  private captureScreensFn: () => Promise<ScreenCaptureResult[]>;

  constructor(options: AnnotationControllerOptions) {
    this.sendToOverlay = options.sendToOverlay;
    this.getOverlayWindow = options.getOverlayWindow;
    this.gridLocator = options.gridLocator ?? new GridLocator();
    this.captureScreensFn = options.captureScreensFn ?? (() => ScreenCapture.captureAllScreens());
  }

  /**
   * Render a batch of annotations on the overlay.
   * Replaces any annotations currently shown.
   */
  async render(args: DrawAnnotationArgs): Promise<AnnotationResult> {
    const overlayWindow = this.getOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      console.warn('⚠️ AnnotationController: overlay window not available');
      return { success: false, error: 'Overlay window not available' };
    }

    const displays = screen.getAllDisplays();
    if (displays.length === 0) {
      return { success: false, error: 'No displays found' };
    }

    const cursorPoint = screen.getCursorScreenPoint();
    const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const cursorScreenIndex = displays.findIndex((d) => d.id === cursorDisplay.id);

    // The overlay window spans all displays and its client coordinate system
    // starts at the top-left of the combined bounds rectangle. We need every
    // annotation's overlayX/overlayY relative to that origin.
    const combinedBounds = this.getCombinedBounds(displays);

    console.log('[DEBUG-ann2] displays:', displays.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      size: d.size,
      scaleFactor: d.scaleFactor,
    })));
    console.log('[DEBUG-ann2] combinedBounds:', combinedBounds);
    console.log('[DEBUG-ann2] overlayWindow.getBounds():', overlayWindow.getBounds());

    const normalized: NormalizedAnnotation[] = [];

    for (const annotation of args.annotations) {
      const type = annotation.type;
      if (!this.isValidAnnotationType(type)) {
        console.warn(`⚠️ AnnotationController: skipping unknown annotation type "${type}"`);
        continue;
      }

      const screenIndex =
        typeof annotation.screenIndex === 'number' && annotation.screenIndex >= 0
          ? annotation.screenIndex
          : Math.max(0, cursorScreenIndex);

      const display = displays[screenIndex];
      if (!display) {
        console.warn(`⚠️ AnnotationController: screenIndex ${screenIndex} out of range`);
        continue;
      }

      const bounds = display.bounds;
      const scaleFactor = display.scaleFactor || 1;

      let annotationX = annotation.x;
      let annotationY = annotation.y;

      if (annotation.target && (annotationX === undefined || annotationY === undefined)) {
        const located = await this.locateViaGrid(screenIndex, annotation.target);
        if (located === null) {
          console.warn(`⚠️ AnnotationController: grid locator couldn't find "${annotation.target}" on screen ${screenIndex}`);
          continue;
        }
        annotationX = located.x;
        annotationY = located.y;
        console.log(`[DEBUG-ann2] grid-locator found "${annotation.target}" at physical (${annotationX}, ${annotationY}) on screen ${screenIndex}`);
      }

      if (annotationX === undefined || annotationY === undefined) {
        console.warn(`⚠️ AnnotationController: annotation missing both coordinates and target`);
        continue;
      }

      const logicalX = annotationX / scaleFactor;
      const logicalY = annotationY / scaleFactor;

      const clampedX = this.clamp(logicalX, 0, bounds.width);
      const clampedY = this.clamp(logicalY, 0, bounds.height);

      // Screen logical coordinate, then shifted so the overlay client origin
      // is the top-left of the combined bounds rectangle.
      const overlayX = bounds.x + clampedX - combinedBounds.x;
      const overlayY = bounds.y + clampedY - combinedBounds.y;

      console.log('[DEBUG-ann2] annotation:', annotation, '-> logical:', { logicalX, logicalY, clampedX, clampedY }, '-> overlay:', { overlayX, overlayY });

      const normalizedAnnotation: NormalizedAnnotation = {
        ...annotation,
        screenIndex,
        x: clampedX,
        y: clampedY,
        overlayX,
        overlayY,
      };

      if (type === 'arrow') {
        // Explicit end coordinates are in screenshot (physical) pixels and
        // must be scaled. The default tail-to-head offset stays a logical
        // 60px so arrows look consistent across DPIs.
        const endLogicalX = annotation.endX != null ? annotation.endX / scaleFactor : clampedX + 60;
        const endLogicalY = annotation.endY != null ? annotation.endY / scaleFactor : clampedY + 60;
        const endX = this.clamp(endLogicalX, 0, bounds.width);
        const endY = this.clamp(endLogicalY, 0, bounds.height);
        normalizedAnnotation.endX = endX;
        normalizedAnnotation.endY = endY;
        normalizedAnnotation.overlayEndX = bounds.x + endX - combinedBounds.x;
        normalizedAnnotation.overlayEndY = bounds.y + endY - combinedBounds.y;
      }

      if (type === 'circle' && (!normalizedAnnotation.radius || normalizedAnnotation.radius <= 0)) {
        normalizedAnnotation.radius = 40;
      } else if (type === 'circle' && normalizedAnnotation.radius) {
        normalizedAnnotation.radius = normalizedAnnotation.radius / scaleFactor;
      }

      if (type === 'rectangle') {
        if (!normalizedAnnotation.width || normalizedAnnotation.width <= 0) {
          normalizedAnnotation.width = 80;
        } else {
          normalizedAnnotation.width = normalizedAnnotation.width / scaleFactor;
        }
        if (!normalizedAnnotation.height || normalizedAnnotation.height <= 0) {
          normalizedAnnotation.height = 40;
        } else {
          normalizedAnnotation.height = normalizedAnnotation.height / scaleFactor;
        }
      }

      if (type === 'label' && !normalizedAnnotation.text) {
        normalizedAnnotation.text = '';
      }

      normalized.push(normalizedAnnotation);
    }

    if (normalized.length === 0) {
      return { success: true, count: 0 };
    }

    this.sendToOverlay('draw-annotations', { annotations: normalized });
    this.scheduleClear();

    return { success: true, count: normalized.length };
  }

  /**
   * Immediately clear all annotations from the overlay.
   */
  clearAnnotations(): void {
    this.cancelClearTimer();
    this.sendToOverlay('clear-annotations', {});
  }

  /**
   * Reset the auto-clear timer. Called when a new response starts so
   * annotations from a previous turn don't linger.
   */
  resetLifecycle(): void {
    this.cancelClearTimer();
    this.sendToOverlay('clear-annotations', {});
  }

  private scheduleClear(): void {
    this.cancelClearTimer();
    this.clearTimer = setTimeout(() => {
      this.sendToOverlay('clear-annotations', {});
      this.clearTimer = null;
    }, DEFAULT_CLEAR_TIMEOUT_MS);
  }

  private cancelClearTimer(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  private isValidAnnotationType(type: string): type is AnnotationType {
    return ['point', 'arrow', 'circle', 'rectangle', 'label'].includes(type);
  }

  private async locateViaGrid(
    screenIndex: number,
    target: string,
  ): Promise<{ x: number; y: number } | null> {
    try {
      const captures = await this.captureScreensFn();
      const capture = captures[screenIndex];
      if (!capture || !capture.imageBase64) {
        console.warn(`⚠️ AnnotationController.locateViaGrid: no screenshot for screen ${screenIndex}`);
        return null;
      }
      return await this.gridLocator.locate(
        capture.imageBase64,
        capture.width,
        capture.height,
        target,
      );
    } catch (err) {
      console.error(`⚠️ AnnotationController.locateViaGrid error:`, err);
      return null;
    }
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Calculate the bounding rectangle that covers all monitors.
   * Mirrors OverlayManager.getCombinedBounds so coordinate systems stay in sync.
   */
  private getCombinedBounds(displays: Electron.Display[]): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

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
}
