import { tool, jsonSchema } from 'ai';
import { ExcalidrawController } from './ExcalidrawController';
import { ToolExecutor } from '../realtime/RealtimeToolBridge';

const colorSchema = { type: 'string', description: 'CSS color string (e.g., #ff0000, red).' };
const strokeStyleSchema = { type: 'string', enum: ['solid', 'dashed', 'dotted'] };
const fillStyleSchema = { type: 'string', enum: ['hachure', 'cross-hatch', 'solid', 'zigzag'] };

const elementChangesSchema = jsonSchema({
  type: 'object',
  description: 'Allowed immediate-safe changes to existing elements.',
  properties: {
    strokeColor: colorSchema,
    backgroundColor: colorSchema,
    fillStyle: fillStyleSchema,
    strokeWidth: { type: 'number', description: 'Stroke width in pixels.' },
    strokeStyle: strokeStyleSchema,
    roughness: { type: 'number' },
    opacity: { type: 'number', minimum: 0, maximum: 100 },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    angle: { type: 'number', description: 'Rotation in radians.' },
    text: { type: 'string', description: 'New text for text elements.' },
  },
});

const operationSchema = jsonSchema({
  type: 'object',
  description: 'A single high-level Excalidraw operation.',
  oneOf: [
    {
      type: 'object',
      description: 'Create a new element.',
      properties: {
        kind: { type: 'string', enum: ['create'] },
        elementType: { type: 'string', enum: ['text', 'rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'freedraw'] },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        id: { type: 'string', description: 'Optional stable id for the new element.' },
        text: { type: 'string' },
        strokeColor: colorSchema,
        backgroundColor: colorSchema,
        strokeWidth: { type: 'number' },
        roughness: { type: 'number' },
        opacity: { type: 'number', minimum: 0, maximum: 100 },
        angle: { type: 'number' },
        fillStyle: fillStyleSchema,
      },
      required: ['kind', 'elementType', 'x', 'y', 'width', 'height'],
    },
    {
      type: 'object',
      description: 'Update existing elements. Omit ids to target the current selection.',
      properties: {
        kind: { type: 'string', enum: ['update'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'Optional explicit target ids.' },
        changes: elementChangesSchema.jsonSchema,
      },
      required: ['kind', 'changes'],
    },
    {
      type: 'object',
      description: 'Delete elements. Destructive — always routed through the proposal flow.',
      properties: {
        kind: { type: 'string', enum: ['delete'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'Optional explicit target ids.' },
      },
      required: ['kind'],
    },
    {
      type: 'object',
      description: 'Align elements. Geometry-affecting — routed through the proposal flow.',
      properties: {
        kind: { type: 'string', enum: ['align'] },
        ids: { type: 'array', items: { type: 'string' } },
        alignment: { type: 'string', enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] },
      },
      required: ['kind', 'alignment'],
    },
    {
      type: 'object',
      description: 'Distribute elements. Geometry-affecting — routed through the proposal flow.',
      properties: {
        kind: { type: 'string', enum: ['distribute'] },
        ids: { type: 'array', items: { type: 'string' } },
        direction: { type: 'string', enum: ['horizontal', 'vertical'] },
      },
      required: ['kind', 'direction'],
    },
    {
      type: 'object',
      description: 'Group elements. Geometry-affecting — routed through the proposal flow.',
      properties: {
        kind: { type: 'string', enum: ['group'] },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind'],
    },
    {
      type: 'object',
      description: 'Ungroup elements. Geometry-affecting — routed through the proposal flow.',
      properties: {
        kind: { type: 'string', enum: ['ungroup'] },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind'],
    },
    {
      type: 'object',
      description: 'Clear the entire canvas. Destructive — routed through the proposal flow.',
      properties: {
        kind: { type: 'string', enum: ['clearCanvas'] },
      },
      required: ['kind'],
    },
    {
      type: 'object',
      description: 'Reorganize layout. Geometry-affecting — routed through the proposal flow.',
      properties: {
        kind: { type: 'string', enum: ['reorganizeLayout'] },
        ids: { type: 'array', items: { type: 'string' } },
        layout: { type: 'string', enum: ['grid', 'tree', 'flow', 'auto'] },
      },
      required: ['kind', 'layout'],
    },
  ],
});

const proposalOptionsSchema = jsonSchema({
  type: 'object',
  description: 'Optional proposal metadata.',
  properties: {
    ttlMs: { type: 'number', description: 'Proposal time-to-live in milliseconds. Default 10 minutes.' },
    summary: { type: 'string', description: 'Short summary of what the proposal does.' },
    mode: { type: 'string', enum: ['diagram_patch', 'review_options'], description: 'Default diagram_patch.' },
    reason: { type: 'string', description: 'Why the proposal was created.' },
    options: {
      type: 'array',
      description: 'For review_options mode: alternative option sets.',
      items: {
        type: 'object',
        properties: {
          optionId: { type: 'string' },
          title: { type: 'string' },
          rationale: { type: 'string' },
          operations: { type: 'array', items: operationSchema.jsonSchema },
        },
        required: ['optionId', 'title', 'operations'],
      },
    },
  },
});

function createToolPair(
  controller: ExcalidrawController,
  name: string,
  description: string,
  parameters: ReturnType<typeof jsonSchema>,
  execute: (args: any) => Promise<any>
) {
  const vercelTool = tool({
    description,
    inputSchema: parameters,
    execute,
  });

  const realtimeExecutor: ToolExecutor = {
    name,
    description,
    parameters: parameters.jsonSchema,
    execute,
  };

  return { vercelTool, realtimeExecutor };
}

export function createExcalidrawTools(controller: ExcalidrawController) {
  const readScenePair = createToolPair(
    controller,
    'excalidraw_readScene',
    'Read a compact summary of the current Excalidraw canvas. Returns element count, selected ids, canvas size, and a small summary of elements. Never returns raw full scene JSON.',
    jsonSchema({
      type: 'object',
      properties: {},
      required: [],
    }),
    async () => controller.readScene()
  );

  const applyOperationPair = createToolPair(
    controller,
    'excalidraw_applyOperation',
    'Apply a single safe Excalidraw operation immediately. Use only for small, non-destructive changes such as creating one element or updating a few element properties. Destructive/geometry-affecting/large operations will return requires_confirmation — use excalidraw_proposeOperation for those.',
    jsonSchema({
      type: 'object',
      properties: {
        operation: operationSchema.jsonSchema,
      },
      required: ['operation'],
    }),
    async (args: any) => controller.applyOperation(args.operation)
  );

  const proposeOperationPair = createToolPair(
    controller,
    'excalidraw_proposeOperation',
    'Create a pending visual proposal (translucent ghost) for destructive, geometry-affecting, large, or ambiguous changes. The user reviews the preview before you call excalidraw_confirmProposal or excalidraw_cancelProposal.',
    jsonSchema({
      type: 'object',
      properties: {
        operation: operationSchema.jsonSchema,
        options: proposalOptionsSchema.jsonSchema,
      },
      required: ['operation'],
    }),
    async (args: any) => controller.proposeOperation(args.operation, args.options)
  );

  const confirmProposalPair = createToolPair(
    controller,
    'excalidraw_confirmProposal',
    'Commit a pending Excalidraw proposal. For review_options proposals, include the optionId chosen by the user.',
    jsonSchema({
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        optionId: { type: 'string', description: 'Required when confirming a review_options proposal.' },
      },
      required: ['proposalId'],
    }),
    async (args: any) => controller.confirmProposal(args.proposalId, args.optionId)
  );

  const cancelProposalPair = createToolPair(
    controller,
    'excalidraw_cancelProposal',
    'Cancel a pending Excalidraw proposal and remove its ghost preview without committing it.',
    jsonSchema({
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
      },
      required: ['proposalId'],
    }),
    async (args: any) => controller.cancelProposal(args.proposalId)
  );

  const undoPair = createToolPair(
    controller,
    'excalidraw_undo',
    'Undo the last Bud-applied Excalidraw change. Does not undo edits made directly by the user in the canvas.',
    jsonSchema({
      type: 'object',
      properties: {},
      required: [],
    }),
    async () => controller.undo()
  );

  const pairs = [
    readScenePair,
    applyOperationPair,
    proposeOperationPair,
    confirmProposalPair,
    cancelProposalPair,
    undoPair,
  ];

  const vercelTools: Record<string, any> = {};
  const realtimeExecutors: ToolExecutor[] = [];

  for (const pair of pairs) {
    vercelTools[pair.realtimeExecutor.name] = pair.vercelTool;
    realtimeExecutors.push(pair.realtimeExecutor);
  }

  return { vercelTools, realtimeExecutors };
}
