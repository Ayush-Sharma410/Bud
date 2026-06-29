export type AnnotationType = 'point' | 'arrow' | 'circle' | 'rectangle' | 'label';

export interface Annotation {
  type: AnnotationType;
  screenIndex?: number;
  x?: number;
  y?: number;
  target?: string;
  endX?: number;
  endY?: number;
  radius?: number;
  width?: number;
  height?: number;
  text?: string;
  label?: string;
}

export interface DrawAnnotationArgs {
  annotations: Annotation[];
}

export interface AnnotationResult {
  success: boolean;
  count?: number;
  error?: string;
}

export interface NormalizedAnnotation extends Annotation {
  overlayX: number;
  overlayY: number;
  overlayEndX?: number;
  overlayEndY?: number;
}
