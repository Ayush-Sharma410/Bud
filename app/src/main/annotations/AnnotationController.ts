import { screen, BrowserWindow } from 'electron';
import {
  Annotation,
  AnnotationType,
  AnnotationResult,
  DrawAnnotationArgs,
  NormalizedAnnotation,
} from './annotationTypes';

const DEFAULT_CLEAR_TIMEOUT_MS = 10000;

export interface AnnotationControllerOptions {
  sendToOverlay: (channel: string, data: any) => void;
  getOverlayWindow: () => BrowserWindow | null;
}

export class AnnotationController {
  private sendToOverlay: (channel: string, data: any) => void;
  private getOverlayWindow: () => BrowserWindow | null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AnnotationControllerOptions) {
    this.sendToOverlay = options.sendToOverlay;
    this.getOverlayWindow = options.getOverlayWindow;
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
      const clampedX = this.clamp(annotation.x, 0, bounds.width);
      const clampedY = this.clamp(annotation.y, 0, bounds.height);

      const overlayX = bounds.x + clampedX;
      const overlayY = bounds.y + clampedY;

      const normalizedAnnotation: NormalizedAnnotation = {
        ...annotation,
        screenIndex,
        x: clampedX,
        y: clampedY,
        overlayX,
        overlayY,
      };

      if (type === 'arrow') {
        const endX = this.clamp(annotation.endX ?? clampedX + 60, 0, bounds.width);
        const endY = this.clamp(annotation.endY ?? clampedY + 60, 0, bounds.height);
        normalizedAnnotation.endX = endX;
        normalizedAnnotation.endY = endY;
        normalizedAnnotation.overlayEndX = bounds.x + endX;
        normalizedAnnotation.overlayEndY = bounds.y + endY;
      }

      if (type === 'circle' && (!normalizedAnnotation.radius || normalizedAnnotation.radius <= 0)) {
        normalizedAnnotation.radius = 40;
      }

      if (type === 'rectangle') {
        if (!normalizedAnnotation.width || normalizedAnnotation.width <= 0) {
          normalizedAnnotation.width = 80;
        }
        if (!normalizedAnnotation.height || normalizedAnnotation.height <= 0) {
          normalizedAnnotation.height = 40;
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

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }
}
