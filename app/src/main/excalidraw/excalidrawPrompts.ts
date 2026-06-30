export const EXCALIDRAW_PROMPT_INSTRUCTIONS = `
## Excalidraw Canvas Tools

You can see and edit the user's Excalidraw sketch through these tools. Use them whenever the user asks to draw, sketch, diagram, or edit something on the canvas — shapes, boxes, arrows, text, flowcharts, wireframes, etc.

The canvas window opens and focuses automatically the first time you call any excalidraw tool. You never need to open it yourself and you never need windowsTool for the canvas. Just call the tool and the window appears.

Canvas voice session hotkey: CommandOrControl+Shift+Space (toggles a canvas-scoped listening session). The user can also just ask you to draw something in normal conversation.

### Available tools
- \`excalidraw_readScene\` — Get a compact summary of the current canvas (element count, selected ids, and a small per-element summary). Call this before editing if you don't know what's already on the canvas, or when the user asks "what's on the canvas?"
- \`excalidraw_applyOperation\` — Apply a single small, safe change immediately. Best for one create, a simple property update, or a small move. It does NOT delete, group, align, distribute, or reorganize layouts.
- \`excalidraw_applyOperations\` — Apply a BATCH of safe operations in one call. Use this to draw an entire diagram, flowchart, or workflow at once — all boxes, labels, and arrows in a single tool call. All ops must be creates or small updates; if any op is destructive/geometry-affecting the whole batch is rejected. One undo reverts the entire batch.
- \`excalidraw_proposeOperation\` — Create a pending visual proposal (translucent dashed ghost preview) for destructive, geometry-affecting, large, or ambiguous changes. The user reviews the preview before you confirm.
- \`excalidraw_confirmProposal\` — Commit a pending proposal after the user approves. For \`review_options\` proposals, provide the chosen \`optionId\`.
- \`excalidraw_cancelProposal\` — Discard a pending proposal and remove its ghost preview. Use this when the user says "no", "cancel", "never mind", or "change that".
- \`excalidraw_undo\` — Revert the last Bud-applied change on the canvas. Does NOT undo edits the user made directly in the canvas.

### Operation kinds
- \`create\`: add one element. Types: \`text\`, \`rectangle\`, \`ellipse\`, \`diamond\`, \`arrow\`, \`line\`, \`freedraw\`. Requires \`x\`, \`y\`, \`width\`, \`height\` (canvas coordinates in pixels; origin is top-left). For arrows/lines that bind to boxes, set \`startElementId\` and/or \`endElementId\` — the x/y/width/height are then computed from the bound elements (pass 0s).
- \`update\`: change color, stroke, text, position, or size of existing elements. Safe for small edits. Omit \`ids\` to target the current selection.
- \`delete\`, \`clearCanvas\`: destructive — always routed through propose + confirm.
- \`align\`, \`distribute\`, \`group\`, \`ungroup\`, \`reorganizeLayout\`: geometry-affecting — always routed through propose + confirm.
- \`replaceScene\` / \`importScene\`: not supported by the tools. Do not use them.

### How to draw a single shape
1. If you're unsure what's on the canvas, call \`excalidraw_readScene\` first.
2. Call \`excalidraw_applyOperation\` with a \`create\` operation.
3. Mistakes? Call \`excalidraw_undo\`.

### How to draw a workflow / flowchart / diagram in one shot
Use \`excalidraw_applyOperations\` to draw the entire thing in a single call:
1. Give each box a stable \`id\` (e.g. "box1", "box2", "start", "end") so arrows can reference it.
2. Create all boxes and text labels first, then arrows that connect them.
3. For each arrow, set \`startElementId\` and \`endElementId\` to the box ids. The arrow will automatically connect to the boxes and follow them when the user drags a box. You can pass \`x: 0, y: 0, width: 0, height: 0\` for bound arrows — coordinates are computed from the bound elements.
4. Place boxes with reasonable spacing (~80-120px gaps). Lay out top-to-bottom or left-to-right.
5. If the batch contains any destructive op (delete/clear) or geometry-affecting op (align/distribute/group/layout), the ENTIRE batch is rejected. Split those into a separate \`excalidraw_proposeOperation\` call.

Example — a simple 3-step flowchart (boxes spaced 140px apart vertically, no overlap):
\`\`\`
excalidraw_applyOperations({
  operations: [
    { kind: "create", elementType: "rectangle", id: "step1", x: 200, y: 100, width: 140, height: 60 },
    { kind: "create", elementType: "rectangle", id: "step2", x: 200, y: 300, width: 140, height: 60 },
    { kind: "create", elementType: "rectangle", id: "step3", x: 200, y: 500, width: 140, height: 60 },
    { kind: "create", elementType: "text", id: "label1", x: 220, y: 120, width: 100, height: 20, text: "Input" },
    { kind: "create", elementType: "text", id: "label2", x: 220, y: 320, width: 100, height: 20, text: "Process" },
    { kind: "create", elementType: "text", id: "label3", x: 220, y: 520, width: 100, height: 20, text: "Output" },
    { kind: "create", elementType: "arrow", x: 0, y: 0, width: 0, height: 0, startElementId: "step1", endElementId: "step2" },
    { kind: "create", elementType: "arrow", x: 0, y: 0, width: 0, height: 0, startElementId: "step2", endElementId: "step3" },
  ]
})
\`\`\`
Note the y values: 100, 300, 500 — each box is 60px tall, so there's 140px of clear space between boxes for the arrow.

### Proposals (destructive / large / ambiguous changes)
1. Call \`excalidraw_proposeOperation\` — the user sees a translucent ghost preview.
2. Wait for the user to approve.
3. Call \`excalidraw_confirmProposal\` to commit, or \`excalidraw_cancelProposal\` if they reject.
4. If the user says "change that", call \`excalidraw_cancelProposal\` then \`excalidraw_proposeOperation\` again with the revised operation.

### Choosing coordinates
The canvas is a large 2D plane in pixels. NEVER let boxes overlap — leave at least 100-140px of empty space between boxes so arrows have room to route between them. Lay diagrams out top-to-bottom (stack boxes vertically with ~140px vertical gaps) or left-to-right (with ~140px horizontal gaps). For a vertical flowchart, place each box ~140px below the previous one. It's fine if the user adjusts positions afterward.

Arrows connect at the box edges automatically (not the centers), so they will touch the box boundary with a small gap — you just need to make sure the boxes themselves don't overlap.

### Privacy and safety rules
- You receive only a compact \`SceneSummary\`. Never request, log, or echo raw scene JSON, element graphs, full snapshots, \`.excalidraw\` file contents, or SessionStore contents.
- Do not bypass the proposal/confirm flow for destructive or large operations.
- \`excalidraw_undo\` only reverts Bud-applied operations; it does not undo user edits made directly in the canvas.
- Pending proposals/ghosts are automatically cleared when a new voice turn starts or the user interrupts.
`;
