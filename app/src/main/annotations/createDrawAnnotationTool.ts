import { tool, jsonSchema } from 'ai';
import { AnnotationController } from './AnnotationController';
import { ToolExecutor } from '../realtime/RealtimeToolBridge';

export function createDrawAnnotationTools(controller: AnnotationController) {
  const execute = async (args: any) => {
    console.log('[DEBUG-ann2] drawAnnotation raw args:', JSON.stringify(args));
    return controller.render(args);
  };

  const parameters = jsonSchema({
    type: 'object',
    properties: {
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['point', 'arrow', 'circle', 'rectangle', 'label'],
            },
            screenIndex: {
              type: 'integer',
              description:
                '0-based index of the screen from the most recent captureScreen result. Defaults to the screen the cursor is on.',
            },
            target: {
              type: 'string',
              description:
                'Natural-language description of the UI element to point at (e.g., "the save button", "the search bar"). When provided, Bud uses a two-stage grid locator to find the exact pixel position — MORE accurate than raw coordinates since screenshots may be downscaled. PREFER this over x/y for pointing at visible UI elements. Omit x/y when using target.',
            },
            x: {
              type: 'number',
              description:
                'X coordinate in screenshot pixels. Omit when using "target". Anchor depends on type: arrow tail, circle/rectangle center, label top-left, point center.',
            },
            y: {
              type: 'number',
              description:
                'Y coordinate in screenshot pixels. Omit when using "target". Anchor depends on type: arrow tail, circle/rectangle center, label top-left, point center.',
            },
            endX: {
              type: 'number',
              description: 'For arrow: x coordinate of the arrow head.',
            },
            endY: {
              type: 'number',
              description: 'For arrow: y coordinate of the arrow head.',
            },
            radius: {
              type: 'number',
              description: 'For circle: radius in screenshot pixels.',
            },
            width: {
              type: 'number',
              description: 'For rectangle: width in screenshot pixels.',
            },
            height: {
              type: 'number',
              description: 'For rectangle: height in screenshot pixels.',
            },
            text: {
              type: 'string',
              description: 'For label: text to display.',
            },
            label: {
              type: 'string',
              description: 'For point: short 1-3 word description.',
            },
          },
          required: ['type'],
        },
      },
    },
    required: ['annotations'],
  });

  const vercelTool = tool({
    description:
      'Draw annotations on the user\'s screen to point, highlight, or label UI elements. Use when explaining or guiding the user through something visible on screen. PREFER using the "target" field (natural-language description of the UI element) over raw x/y coordinates — Bud uses a grid-based locator to find the exact position, which is far more accurate than raw pixel coordinates.',
    inputSchema: parameters,
    execute,
  });

  const realtimeExecutor: ToolExecutor = {
    name: 'drawAnnotation',
    description:
      'Draw annotations on the user\'s screen to point, highlight, or label UI elements. Use when explaining or guiding the user through something visible on screen. PREFER using the "target" field (natural-language description of the UI element) over raw x/y coordinates — Bud uses a grid-based locator to find the exact position, which is far more accurate than raw pixel coordinates.',
    parameters: parameters.jsonSchema,
    execute,
  };

  return { vercelTool, realtimeExecutor };
}
