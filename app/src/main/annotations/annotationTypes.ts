export type AnnotationType = 'point' | 'arrow' | 'circle' | 'rectangle' | 'label';

export interface Annotation {
  type: AnnotationType;
  screenIndex?: number;
  x: number;
  y: number;
  // arrow: (x,y) is tail, (endX,endY) is head
  endX?: number;
  endY?: number;
  // circle: (x,y) is center
  radius?: number;
  // rectangle: (x,y) is center
  width?: number;
  height?: number;
  // label: (x,y) is top-left anchor of the pill
  text?: string;
  // point: (x,y) is dot center
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
