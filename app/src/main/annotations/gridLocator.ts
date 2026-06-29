/**
 * Bud — Two-stage grid-locator for pixel-pointing with vision LLMs.
 *
 * Port of the Python universal_locator.py / grid_locator.py (Bitshank-2338/clicky-windows).
 * Used by AnnotationController when the LLM provides a natural-language "target"
 * description instead of raw pixel coordinates.
 *
 * Algorithm:
 *   Stage 1 (coarse, 12x8 = 96 cells):
 *     - Draw a numbered red grid overlay on the screenshot.
 *     - Ask the LLM: "Which numbered cell contains <target>?"
 *     - LLM picks 1-96.
 *
 *   Stage 2 (fine, 6x6 = 36 sub-cells in 3x3 region around the pick):
 *     - Crop a 3x3-cell region around the chosen Stage-1 cell.
 *     - Draw a 6x6 sub-grid on the crop.
 *     - Ask again: "Which sub-cell contains <target>?"
 *     - LLM picks 1-36 within the crop.
 *
 *   Final: Map the centre of the chosen sub-cell back to original screen
 *   pixels.
 *
 * Accuracy: ~25-50px on a 1080p screen. Adequate for buttons, menu items,
 * links, icons. Far more reliable than asking the LLM to return raw pixel
 * coordinates (which fails when the image is downscaled for inference).
 */
import sharp from 'sharp';
import { generateText } from 'ai';
import { createLanguageModel, getDefaultOrchestratorModelName } from '../llmProvider';

const STAGE1_COLS = 12;
const STAGE1_ROWS = 8;
const STAGE2_COLS = 6;
const STAGE2_ROWS = 6;
const ZOOM_RADIUS_CELLS = 1;
const MAX_INFERENCE_WIDTH = 1280;

export interface LocateResult {
  x: number;
  y: number;
}

export interface GridLocatorOptions {
  modelName?: string;
}

export class GridLocator {
  private modelName: string;

  constructor(options?: GridLocatorOptions) {
    this.modelName = options?.modelName || getDefaultOrchestratorModelName();
  }

  async locate(
    screenshotBase64: string,
    originalWidth: number,
    originalHeight: number,
    query: string,
  ): Promise<LocateResult | null> {
    const screenshotBuffer = Buffer.from(screenshotBase64, 'base64');

    const scale = Math.min(1, MAX_INFERENCE_WIDTH / originalWidth);
    const inferenceWidth = Math.round(originalWidth * scale);
    const inferenceHeight = Math.round(originalHeight * scale);

    const inferenceBuffer = await sharp(screenshotBuffer)
      .resize(inferenceWidth, inferenceHeight)
      .jpeg()
      .toBuffer();

    const stage1Svg = buildGridSVG(inferenceWidth, inferenceHeight, STAGE1_COLS, STAGE1_ROWS);
    const stage1GridPng = await sharp(Buffer.from(stage1Svg)).png().toBuffer();
    const stage1Image = await sharp(inferenceBuffer)
      .composite([{ input: stage1GridPng, blend: 'over' }])
      .jpeg({ quality: 80 })
      .toBuffer();

    const stage1Max = STAGE1_COLS * STAGE1_ROWS;
    const stage1Pick = await this.askGridPick(stage1Image, query, stage1Max);
    if (stage1Pick === null || stage1Pick === 0) return null;

    const idx = stage1Pick - 1;
    const s1Row = Math.floor(idx / STAGE1_COLS);
    const s1Col = idx % STAGE1_COLS;
    const cellW = inferenceWidth / STAGE1_COLS;
    const cellH = inferenceHeight / STAGE1_ROWS;

    const c0 = Math.max(0, s1Col - ZOOM_RADIUS_CELLS);
    const r0 = Math.max(0, s1Row - ZOOM_RADIUS_CELLS);
    const c1 = Math.min(STAGE1_COLS - 1, s1Col + ZOOM_RADIUS_CELLS);
    const r1 = Math.min(STAGE1_ROWS - 1, s1Row + ZOOM_RADIUS_CELLS);

    const cropLeft = Math.round(c0 * cellW);
    const cropTop = Math.round(r0 * cellH);
    const cropRight = Math.round((c1 + 1) * cellW);
    const cropBottom = Math.round((r1 + 1) * cellH);
    const cropWidth = cropRight - cropLeft;
    const cropHeight = cropBottom - cropTop;

    let cropBuffer = await sharp(inferenceBuffer)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .jpeg()
      .toBuffer();

    const targetCropWidth = Math.max(cropWidth, 768);
    let cropActualWidth = cropWidth;
    let cropActualHeight = cropHeight;
    if (cropWidth < targetCropWidth) {
      const cropScale = targetCropWidth / cropWidth;
      cropActualWidth = targetCropWidth;
      cropActualHeight = Math.round(cropHeight * cropScale);
      cropBuffer = await sharp(cropBuffer)
        .resize(cropActualWidth, cropActualHeight)
        .jpeg()
        .toBuffer();
    }

    const stage2Svg = buildGridSVG(cropActualWidth, cropActualHeight, STAGE2_COLS, STAGE2_ROWS);
    const stage2GridPng = await sharp(Buffer.from(stage2Svg)).png().toBuffer();
    const stage2Image = await sharp(cropBuffer)
      .composite([{ input: stage2GridPng, blend: 'over' }])
      .jpeg({ quality: 85 })
      .toBuffer();

    const stage2Max = STAGE2_COLS * STAGE2_ROWS;
    const stage2Pick = await this.askGridPick(stage2Image, query, stage2Max);

    let inferX: number;
    let inferY: number;
    if (stage2Pick === null || stage2Pick === 0) {
      inferX = (s1Col + 0.5) * cellW;
      inferY = (s1Row + 0.5) * cellH;
    } else {
      const s2Idx = stage2Pick - 1;
      const s2Row = Math.floor(s2Idx / STAGE2_COLS);
      const s2Col = s2Idx % STAGE2_COLS;
      const s2CellW = cropWidth / STAGE2_COLS;
      const s2CellH = cropHeight / STAGE2_ROWS;
      inferX = cropLeft + (s2Col + 0.5) * s2CellW;
      inferY = cropTop + (s2Row + 0.5) * s2CellH;
    }

    const originalX = inferX / scale;
    const originalY = inferY / scale;

    return {
      x: Math.round(originalX),
      y: Math.round(originalY),
    };
  }

  private async askGridPick(imageBuffer: Buffer, query: string, maxN: number): Promise<number | null> {
    const prompt =
      `You are looking at a screenshot with a red numbered grid overlay. ` +
      `Cells are numbered 1 to ${maxN}, left-to-right, top-to-bottom.\n\n` +
      `The user asked: "${query}"\n\n` +
      `Identify the SINGLE numbered cell that most precisely contains the ` +
      `UI element the user is asking about (button, link, menu item, icon, ` +
      `text field, etc.).\n\n` +
      `Respond with ONLY this JSON, nothing else:  {"cell": <number>}\n\n` +
      `If there's no specific UI element to point at (purely conceptual ` +
      `question), respond exactly:  {"cell": 0}`;

    try {
      const model = createLanguageModel(this.modelName);
      const result = await generateText({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'file', data: imageBuffer, mediaType: 'image/jpeg' },
            ],
          },
        ],
      });
      return parseCellNumber(result.text, maxN);
    } catch (err) {
      console.error('[GridLocator] LLM call failed:', err);
      return null;
    }
  }
}

export function buildGridSVG(width: number, height: number, cols: number, rows: number): string {
  const cellW = width / cols;
  const cellH = height / rows;
  const fontSize = Math.max(12, Math.min(28, Math.floor(Math.min(cellW, cellH) / 3.5)));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;

  for (let c = 1; c < cols; c++) {
    const x = Math.round(c * cellW);
    svg += `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="rgba(255,0,0,0.78)" stroke-width="1"/>`;
  }
  for (let r = 1; r < rows; r++) {
    const y = Math.round(r * cellH);
    svg += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(255,0,0,0.78)" stroke-width="1"/>`;
  }

  let n = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = Math.round(c * cellW) + 2;
      const cy = Math.round(r * cellH) + 2;
      const label = String(n);
      const labelWidth = Math.ceil(fontSize * label.length * 0.65) + 5;
      const labelHeight = fontSize + 5;
      svg += `<rect x="${cx - 1}" y="${cy - 1}" width="${labelWidth}" height="${labelHeight}" fill="rgba(255,0,0,0.86)"/>`;
      svg += `<text x="${cx + 2}" y="${cy + fontSize}" fill="white" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold">${label}</text>`;
      n++;
    }
  }

  svg += `</svg>`;
  return svg;
}

export function parseCellNumber(text: string, maxN: number): number | null {
  const jsonMatch = text.match(/\{[^{}]*\}/s);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      for (const key of ['cell', 'number', 'n', 'answer']) {
        if (key in obj) {
          const n = parseInt(obj[key], 10);
          if (!isNaN(n) && n >= 0 && n <= maxN) return n;
        }
      }
    } catch {
      // fall through to integer scan
    }
  }

  const matches = text.match(/\b(\d{1,5})\b/g);
  if (matches) {
    for (const tok of matches) {
      const n = parseInt(tok, 10);
      if (!isNaN(n) && n >= 0 && n <= maxN) return n;
    }
  }

  return null;
}
