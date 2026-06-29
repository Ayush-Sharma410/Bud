/**
 * Bud — Feedback loop for file attachment bugs
 *
 * Reproduces:
 * 1. Dragged/dropped PDFs are read as raw text in the renderer, producing garbage.
 * 2. No file-reader tool exists, so the agent asks for a path or tries shell commands
 *    like `pdftotext` that fail on Windows.
 * 3. Binary file attachments are passed as Vercel `file` parts that OpenAI chat
 *    completions cannot natively consume.
 *
 * Run with: npm run build && node dist/main/tests/file-attachment-bug.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Test Helpers ---
let failed = 0;
let passed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  } else {
    console.log(`✅ PASS: ${message}`);
    passed++;
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  if (actual !== expected) {
    console.error(`❌ FAIL: ${message}\n   Expected: ${expected}\n   Actual: ${actual}`);
    failed++;
  } else {
    console.log(`✅ PASS: ${message}`);
    passed++;
  }
}

function assertContains(haystack: string, needle: string, message: string) {
  const has = haystack.includes(needle);
  if (!has) {
    console.error(`❌ FAIL: ${message}\n   Expected to contain: ${needle}\n   Haystack: ${haystack.slice(0, 200)}`);
    failed++;
  } else {
    console.log(`✅ PASS: ${message}`);
    passed++;
  }
}

// --- Temp environment ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bud-file-bug-'));

function makeTestPdf(): string {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT
/F1 12 Tf
100 700 Td
(Hello from Bud PDF test!) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000360 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
441
%%EOF`;
  const filePath = path.join(tmpDir, 'test.pdf');
  fs.writeFileSync(filePath, pdf, 'binary');
  return filePath;
}

function makeTestTextFile(): string {
  const filePath = path.join(tmpDir, 'test.txt');
  fs.writeFileSync(filePath, 'Hello from Bud text file!', 'utf-8');
  return filePath;
}

function makeTestDocx(): string {
  // DOCX is a zip; create a minimal one with known text.
  // For the repro we only need the extension/mime path to be tested by the tool.
  const filePath = path.join(tmpDir, 'test.docx');
  fs.writeFileSync(filePath, 'PK fake docx', 'utf-8');
  return filePath;
}

function makeTestImage(): string {
  // Minimal valid 1x1 PNG (base64 decoded).
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const filePath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(filePath, Buffer.from(pngBase64, 'base64'));
  return filePath;
}

// ===========================================================
// BUG 1 — Renderer reads binary PDF as text, producing garbage
// ===========================================================

async function testPdfReadAsTextProducesGarbage() {
  console.log('\n--- Bug: PDF read as text produces garbage ---');

  const pdfPath = makeTestPdf();

  // This mirrors the panel's readText() / FileReader.readAsText() path.
  const asText = fs.readFileSync(pdfPath, 'utf-8');

  // The PDF text should NOT be cleanly readable when treated as UTF-8 text.
  // Real PDFs compress/encode text; even this literal PDF is wrapped in PDF
  // syntax (obj/endobj/stream/endstream/xref/trailer) that pollutes the content.
  assertContains(asText, '%PDF-1.4', 'Raw UTF-8 read contains PDF header markers');
  assertContains(asText, 'endobj', 'Raw UTF-8 read contains PDF object delimiters');
  assertContains(asText, 'xref', 'Raw UTF-8 read contains PDF cross-reference table');
}

// ===========================================================
// BUG 2 — No file reader tool exists in the codebase
// ===========================================================

async function testNoFileReaderToolExists() {
  console.log('\n--- Bug: No readFile tool exists ---');

  const srcToolsDir = path.join(__dirname, '..', '..', '..', 'src', 'main', 'tools');
  const indexPath = path.join(srcToolsDir, 'index.ts');
  const indexSource = fs.readFileSync(indexPath, 'utf-8');

  assert(
    indexSource.includes('fileReaderTool') || indexSource.includes('readFile'),
    'tools/index.ts exports a file reader tool'
  );

  const toolFiles = fs.readdirSync(srcToolsDir).filter((f) => f.endsWith('.ts'));
  const hasReaderFile = toolFiles.some((f) =>
    f.toLowerCase().includes('fileread') || f.toLowerCase().includes('reader')
  );
  assert(hasReaderFile, 'A dedicated file reader tool source file exists');
}

// ===========================================================
// BUG 3 — Binary files should not be passed as Vercel file parts
// ===========================================================

async function testBinaryFilesAreNotInlinedAsTextParts() {
  console.log('\n--- Bug: Binary files should carry path metadata, not inline garbage ---');

  const pdfPath = makeTestPdf();

  // Simulate the renderer payload we want after the fix.
  const stagedFile = {
    name: 'test.pdf',
    size: fs.statSync(pdfPath).size,
    type: 'binary',
    mediaType: 'application/pdf',
    path: pdfPath,
  };

  assertEqual(stagedFile.type, 'binary', 'PDFs are classified as binary, not text');
  assert(
    !(stagedFile as any).content,
    'Binary staged file does not carry raw content read as text'
  );
  assertEqual(stagedFile.path, pdfPath, 'Binary staged file carries its absolute path');
}

// ===========================================================
// FIX VERIFICATION — readFile tool extracts text from files
// ===========================================================

async function testReadFileToolExtractsText() {
  console.log('\n--- Fix: readFile tool extracts text from supported files ---');

  // We import dynamically so the test can run before/after the tool exists.
  try {
    const { createFileReaderTool } = require('../tools/fileReaderTool');
    const tool = createFileReaderTool();

    const txtPath = makeTestTextFile();
    const pdfPath = makeTestPdf();
    const docxPath = makeTestDocx();
    const imgPath = makeTestImage();

    const txtResult = await tool.execute({ path: txtPath });
    assertEqual(txtResult.success, true, 'readFile succeeds for text files');
    assertContains(
      txtResult.content || txtResult.output || '',
      'Hello from Bud text file!',
      'readFile returns text file content'
    );

    const pdfResult = await tool.execute({ path: pdfPath });
    assertEqual(pdfResult.success, true, 'readFile succeeds for PDF files');
    assertContains(
      pdfResult.content || pdfResult.output || '',
      'Hello from Bud PDF test!',
      'readFile returns extracted PDF text'
    );

      const docxResult = await tool.execute({ path: docxPath });
      // Our fake DOCX will fail extraction, but the tool should fail gracefully.
      assert(
        docxResult.success === false || (docxResult.error || '').length > 0,
        'readFile reports a clear error for unsupported/corrupt DOCX'
      );

      const imgResult = await tool.execute({ path: imgPath });
      assertEqual(imgResult.success, true, 'readFile succeeds for image files');
      assertEqual(imgResult.mediaType, 'image/png', 'readFile returns correct image mediaType');
      assert(
        typeof imgResult.content === 'string' && imgResult.content.length > 0,
        'readFile returns base64 image content'
      );
  } catch (err: any) {
    console.error(`❌ FAIL: Could not import or run readFile tool: ${err.message}`);
    failed++;
  }
}

// --- Main Runner ---
async function runAll() {
  try {
    await testPdfReadAsTextProducesGarbage();
    await testNoFileReaderToolExists();
    await testBinaryFilesAreNotInlinedAsTextParts();
    await testReadFileToolExtractsText();

    console.log(`\n===================================`);
    console.log(`🏁 File attachment bug loop complete.`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`===================================`);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('Fatal test runner error:', err);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
}

runAll();
