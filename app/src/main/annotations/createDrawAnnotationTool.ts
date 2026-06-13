import { tool, jsonSchema } from 'ai';
import { AnnotationController } from './AnnotationController';
import { ToolExecutor } from '../realtime/RealtimeToolBridge';

export function createDrawAnnotationTools(controller: AnnotationController) {
  const execute = async (args: any) => {
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
            x: {
              type: 'number',
              description:
                'X coordinate in screenshot pixels. Anchor depends on type: arrow tail, circle/rectangle center, label top-left, point center.',
            },
            y: {
              type: 'number',
              description:
                'Y coordinate in screenshot pixels. Anchor depends on type: arrow tail, circle/rectangle center, label top-left, point center.',
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
          required: ['type', 'x', 'y'],
        },
      },
    },
    required: ['annotations'],
  });

  const vercelTool = tool({
    description:
      'Draw annotations on the user\'s screen to point, highlight, or label UI elements. Use when explaining or guiding the user through something visible on screen. Coordinates are in the screenshot pixel space from the most recent captureScreen result.',
    inputSchema: parameters,
    execute,
  });

  const realtimeExecutor: ToolExecutor = {
    name: 'drawAnnotation',
    description:
      'Draw annotations on the user\'s screen to point, highlight, or label UI elements. Use when explaining or guiding the user through something visible on screen. Coordinates are in the screenshot pixel space from the most recent captureScreen result.',
    parameters: parameters.jsonSchema,
    execute,
  };

  return { vercelTool, realtimeExecutor };
}
