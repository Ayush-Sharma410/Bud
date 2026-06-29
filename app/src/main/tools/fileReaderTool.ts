/**
 * Bud — File Reader Tool
 *
 * Reads and extracts usable text from files on disk.
 * Supports plain text, PDF, DOCX, CSV, and images (base64).
 * Falls back gracefully for unsupported binary formats.
 *
 * This tool is the canonical way for Bud to consume attached files,
 * replacing the old pattern of asking the user for a path or running
 * shell commands like `pdftotext` that fail on Windows.
 */
import { tool, jsonSchema } from 'ai';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

// Dynamic imports keep startup fast and isolate parser failures.
async function loadPdfParse(): Promise<typeof import('pdf-parse').PDFParse> {
  const mod = await import('pdf-parse');
  return mod.PDFParse;
}

async function loadMammoth() {
  return import('mammoth');
}

const readFileAsync = promisify(fs.readFile);
const statAsync = promisify(fs.stat);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.jsx', '.ts', '.tsx',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.xml', '.yaml',
  '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.sh', '.bash',
  '.zsh', '.ps1', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp',
  '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerignore', '.editorconfig',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
]);

const PDF_EXTENSIONS = new Set(['.pdf']);
const DOCX_EXTENSIONS = new Set(['.docx']);
const CSV_EXTENSIONS = new Set(['.csv']);

function getMediaType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.csv': 'text/csv',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (PDF_EXTENSIONS.has(ext) || DOCX_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) return false;

  // If no extension, attempt a quick binary heuristic on the first 512 bytes.
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, header, 0, 512, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (header[i] === 0) return false; // binary
    }
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(filePath: string, maxBytes?: number): Promise<string> {
  const stats = await statAsync(filePath);
  const limit = maxBytes ?? 2_000_000; // 2 MB default cap
  if (stats.size > limit) {
    const text = await readFileAsync(filePath, 'utf-8');
    return text.slice(0, limit) + '\n\n[File truncated at ' + limit + ' bytes]';
  }
  return readFileAsync(filePath, 'utf-8');
}

async function readPdf(filePath: string, maxBytes?: number): Promise<string> {
  const stats = await statAsync(filePath);
  const limit = maxBytes ?? 10_000_000; // 10 MB default cap for PDFs
  if (stats.size > limit) {
    throw new Error(`PDF is too large (${stats.size} bytes). Max supported: ${limit} bytes.`);
  }

  const data = await readFileAsync(filePath);
  const PDFParseClass = await loadPdfParse();
  const parser = new PDFParseClass({ data });
  try {
    const result = await parser.getText();
    return result.text?.trim() || '[No extractable text in PDF]';
  } finally {
    await parser.destroy();
  }
}

async function readDocx(filePath: string): Promise<string> {
  const mammoth = await loadMammoth();
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages && result.messages.length > 0) {
    // Log non-fatal messages but don't fail; text may still be usable.
    console.log('[readFileTool] DOCX messages:', result.messages.map((m: any) => m.message).join('; '));
  }
  return result.value?.trim() || '[No extractable text in DOCX]';
}

async function readCsv(filePath: string, maxBytes?: number): Promise<string> {
  const stats = await statAsync(filePath);
  const limit = maxBytes ?? 2_000_000;
  let text: string;
  if (stats.size > limit) {
    text = await readFileAsync(filePath, { encoding: 'utf-8' });
    text = text.slice(0, limit);
  } else {
    text = await readFileAsync(filePath, 'utf-8');
  }
  // Normalize line endings and show first rows cleanly.
  const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return rows.slice(0, 500).join('\n') + (rows.length > 500 ? '\n\n[CSV truncated to 500 rows]' : '');
}

async function readImage(filePath: string, maxBytes?: number): Promise<{ content: string; mediaType: string }> {
  const stats = await statAsync(filePath);
  const limit = maxBytes ?? 5_000_000; // 5 MB default cap for images
  if (stats.size > limit) {
    throw new Error(`Image is too large (${stats.size} bytes). Max supported: ${limit} bytes.`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = getMediaType(ext);
  const data = await readFileAsync(filePath);
  return {
    content: data.toString('base64'),
    mediaType,
  };
}

export const createFileReaderTool = () =>
  tool({
    description: `**File Reader Tool** — Read and extract text from files on disk.

Use this tool whenever the user refers to an attached file, a document, or asks you to read something from a local path.

Supported formats:
- Plain text: .txt, .md, .json, .js, .ts, .html, .css, .xml, .yaml, .log, code files, etc.
- Documents: .pdf, .docx
- Spreadsheets: .csv
- Images: .png, .jpg, .jpeg, .gif, .webp, .bmp, .svg (returns base64; analyze visually if needed)

Parameters:
- path: absolute path to the file
- maxBytes (optional): maximum bytes to read for text/csv files (default 2MB)

Returns:
- success: true/false
- content: extracted text or base64 image data
- mediaType: MIME type of the file
- error: human-readable error if reading failed`,
    inputSchema: jsonSchema<{
      path: string;
      maxBytes?: number;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        maxBytes: {
          type: 'number',
          description: 'Optional maximum bytes to read (text/csv default 2MB, PDF default 10MB, image default 5MB)',
        },
      },
      required: ['path'],
    }),
    execute: async ({ path: filePath, maxBytes }) => {
      console.log(`🛠️ Tool: readFile — ${filePath}`);

      try {
        if (!filePath || typeof filePath !== 'string') {
          return { success: false, error: 'No file path provided' };
        }

        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) {
          return { success: false, error: `File not found: ${resolved}` };
        }

        const stats = await statAsync(resolved);
        if (stats.isDirectory()) {
          return { success: false, error: `Path is a directory, not a file: ${resolved}` };
        }

        const ext = path.extname(resolved).toLowerCase();
        const mediaType = getMediaType(ext);

        if (IMAGE_EXTENSIONS.has(ext)) {
          const img = await readImage(resolved, maxBytes);
          return {
            success: true,
            content: img.content,
            mediaType: img.mediaType,
            path: resolved,
            kind: 'image',
          };
        }

        if (PDF_EXTENSIONS.has(ext)) {
          const text = await readPdf(resolved, maxBytes);
          return {
            success: true,
            content: text,
            mediaType,
            path: resolved,
            kind: 'pdf',
          };
        }

        if (DOCX_EXTENSIONS.has(ext)) {
          const text = await readDocx(resolved);
          return {
            success: true,
            content: text,
            mediaType,
            path: resolved,
            kind: 'docx',
          };
        }

        if (CSV_EXTENSIONS.has(ext)) {
          const text = await readCsv(resolved, maxBytes);
          return {
            success: true,
            content: text,
            mediaType,
            path: resolved,
            kind: 'csv',
          };
        }

        if (isTextFile(resolved)) {
          const text = await readTextFile(resolved, maxBytes);
          return {
            success: true,
            content: text,
            mediaType,
            path: resolved,
            kind: 'text',
          };
        }

        return {
          success: false,
          error: `Unsupported file type (${ext || 'unknown'}). Supported: text, PDF, DOCX, CSV, images.`,
          path: resolved,
        };
      } catch (error: any) {
        console.error(`[readFileTool] Failed to read ${filePath}:`, error.message);
        return {
          success: false,
          error: `Could not read file: ${error.message || 'Unknown error'}`,
          path: filePath,
        };
      }
    },
  });

export const fileReaderTool = createFileReaderTool();
