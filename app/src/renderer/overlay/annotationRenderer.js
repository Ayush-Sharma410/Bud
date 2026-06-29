/**
 * Bud Overlay Annotation Renderer
 *
 * Draws agent-controlled annotations (point, arrow, circle, rectangle, label)
 * on the transparent overlay window.
 */

(function () {
  const ANNOTATION_COLOR = '#4285F4';
  const CONTAINER_ID = 'annotations';

  function getContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.style.position = 'fixed';
      container.style.inset = '0';
      container.style.pointerEvents = 'none';
      container.style.zIndex = '900';
      document.body.appendChild(container);
    }
    return container;
  }

  function clearAnnotations() {
    if (window.budCursorCancelTour) {
      window.budCursorCancelTour();
    }
    const container = getContainer();
    const children = Array.from(container.children);
    for (const child of children) {
      child.style.transition = 'opacity 300ms ease';
      child.style.opacity = '0';
      setTimeout(() => {
        if (child.parentNode) child.parentNode.removeChild(child);
      }, 300);
    }
  }

  function renderAnnotations(data) {
    clearAnnotations();

    if (!data || !Array.isArray(data.annotations) || data.annotations.length === 0) {
      return;
    }

    console.log('[DEBUG-ann2] renderer: window.innerWidth/Height =', window.innerWidth, window.innerHeight, 'devicePixelRatio =', window.devicePixelRatio);
    console.log('[DEBUG-ann2] renderer: received annotations:', data.annotations);

    const container = getContainer();
    const newElements = [];

    for (const annotation of data.annotations) {
      const element = renderAnnotation(annotation);
      if (element) {
        container.appendChild(element);
        newElements.push(element);
      }
    }

    // Trigger entrance animation on next frame, only on newly added elements
    requestAnimationFrame(() => {
      for (const element of newElements) {
        element.style.opacity = '1';
        element.style.transform = 'scale(1)';
      }
    });

    const tourPoints = data.annotations
      .filter(a => a.type === 'point')
      .map(a => ({ x: a.overlayX, y: a.overlayY }));

    if (tourPoints.length > 0 && window.budCursorTour) {
      window.budCursorTour(tourPoints);
    }
  }

  function renderAnnotation(annotation) {
    switch (annotation.type) {
      case 'point':
        return renderPoint(annotation);
      case 'arrow':
        return renderArrow(annotation);
      case 'circle':
        return renderCircle(annotation);
      case 'rectangle':
        return renderRectangle(annotation);
      case 'label':
        return renderLabel(annotation);
      default:
        return null;
    }
  }

  function createWrapper() {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'fixed';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.opacity = '0';
    wrapper.style.transform = 'scale(0.8)';
    wrapper.style.transition = 'opacity 200ms ease, transform 200ms ease';
    wrapper.style.transformOrigin = 'top left';
    return wrapper;
  }

  function renderPoint(annotation) {
    const wrapper = createWrapper();
    wrapper.style.left = `${annotation.overlayX}px`;
    wrapper.style.top = `${annotation.overlayY}px`;

    const dot = document.createElement('div');
    dot.style.width = '12px';
    dot.style.height = '12px';
    dot.style.borderRadius = '50%';
    dot.style.background = ANNOTATION_COLOR;
    dot.style.marginLeft = '-6px';
    dot.style.marginTop = '-6px';
    dot.style.boxShadow = `0 0 8px ${ANNOTATION_COLOR}`;
    dot.style.animation = 'annotation-pulse 1.5s ease-in-out infinite';

    wrapper.appendChild(dot);

    if (annotation.label) {
      const label = document.createElement('div');
      label.textContent = annotation.label;
      label.style.position = 'absolute';
      label.style.left = '14px';
      label.style.top = '-4px';
      label.style.padding = '2px 6px';
      label.style.background = 'rgba(0, 0, 0, 0.75)';
      label.style.color = '#fff';
      label.style.fontSize = '11px';
      label.style.borderRadius = '4px';
      label.style.whiteSpace = 'nowrap';
      label.style.border = `1px solid ${ANNOTATION_COLOR}`;
      wrapper.appendChild(label);
    }

    return wrapper;
  }

  function renderArrow(annotation) {
    const wrapper = createWrapper();

    const x1 = annotation.overlayX;
    const y1 = annotation.overlayY;
    const x2 = annotation.overlayEndX ?? x1 + 60;
    const y2 = annotation.overlayEndY ?? y1 + 60;

    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    const maxX = Math.max(x1, x2);
    const maxY = Math.max(y1, y2);

    const padding = 12;
    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;

    wrapper.style.left = `${minX - padding}px`;
    wrapper.style.top = `${minY - padding}px`;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.overflow = 'visible';

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x1 - minX + padding));
    line.setAttribute('y1', String(y1 - minY + padding));
    line.setAttribute('x2', String(x2 - minX + padding));
    line.setAttribute('y2', String(y2 - minY + padding));
    line.setAttribute('stroke', ANNOTATION_COLOR);
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');

    const arrowHead = createArrowHead(x1 - minX + padding, y1 - minY + padding, x2 - minX + padding, y2 - minY + padding);

    svg.appendChild(line);
    svg.appendChild(arrowHead);
    wrapper.appendChild(svg);

    return wrapper;
  }

  function createArrowHead(x1, y1, x2, y2) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLength = 10;
    const headAngle = Math.PI / 6;

    const p1x = x2 - headLength * Math.cos(angle - headAngle);
    const p1y = y2 - headLength * Math.sin(angle - headAngle);
    const p2x = x2 - headLength * Math.cos(angle + headAngle);
    const p2y = y2 - headLength * Math.sin(angle + headAngle);

    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', `${p1x},${p1y} ${x2},${y2} ${p2x},${p2y}`);
    polygon.setAttribute('fill', ANNOTATION_COLOR);
    return polygon;
  }

  function renderCircle(annotation) {
    const wrapper = createWrapper();
    const radius = annotation.radius || 40;
    const size = radius * 2;

    wrapper.style.left = `${annotation.overlayX - radius}px`;
    wrapper.style.top = `${annotation.overlayY - radius}px`;
    wrapper.style.width = `${size}px`;
    wrapper.style.height = `${size}px`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.overflow = 'visible';

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(radius));
    circle.setAttribute('cy', String(radius));
    circle.setAttribute('r', String(radius));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', ANNOTATION_COLOR);
    circle.setAttribute('stroke-width', '2');
    circle.style.filter = `drop-shadow(0 0 6px ${ANNOTATION_COLOR})`;

    svg.appendChild(circle);
    wrapper.appendChild(svg);

    return wrapper;
  }

  function renderRectangle(annotation) {
    const wrapper = createWrapper();
    const width = annotation.width || 80;
    const height = annotation.height || 40;

    wrapper.style.left = `${annotation.overlayX - width / 2}px`;
    wrapper.style.top = `${annotation.overlayY - height / 2}px`;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.overflow = 'visible';

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('rx', '6');
    rect.setAttribute('ry', '6');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', ANNOTATION_COLOR);
    rect.setAttribute('stroke-width', '2');

    svg.appendChild(rect);
    wrapper.appendChild(svg);

    return wrapper;
  }

  function renderLabel(annotation) {
    const wrapper = createWrapper();
    wrapper.style.left = `${annotation.overlayX}px`;
    wrapper.style.top = `${annotation.overlayY}px`;

    const pill = document.createElement('div');
    pill.textContent = annotation.text || '';
    pill.style.padding = '4px 8px';
    pill.style.background = 'rgba(0, 0, 0, 0.75)';
    pill.style.color = '#fff';
    pill.style.fontSize = '12px';
    pill.style.borderRadius = '6px';
    pill.style.whiteSpace = 'nowrap';
    pill.style.border = `1px solid ${ANNOTATION_COLOR}`;
    pill.style.boxShadow = `0 2px 8px rgba(0, 0, 0, 0.4)`;

    wrapper.appendChild(pill);
    return wrapper;
  }

  function injectStyles() {
    if (document.getElementById('annotation-styles')) return;
    const style = document.createElement('style');
    style.id = 'annotation-styles';
    style.textContent = `
      @keyframes annotation-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.25); opacity: 0.8; }
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    injectStyles();

    if (window.budAPI) {
      window.budAPI.onDrawAnnotations((data) => {
        renderAnnotations(data);
      });

      window.budAPI.onClearAnnotations(() => {
        clearAnnotations();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
