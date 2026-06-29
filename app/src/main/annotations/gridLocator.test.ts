/**
 * Tests for gridLocator pure functions: parseCellNumber + buildGridSVG.
 * The full GridLocator.locate() requires sharp + LLM calls and is tested
 * integration-style (manual run), not in this unit harness.
 */

import { parseCellNumber, buildGridSVG } from './gridLocator';

let failed = 0;
let passed = 0;

function assertEqual(actual: any, expected: any, label: string) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) < 0.001
    : actual === expected;
  if (!ok) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  if (!cond) throw new Error(`${label}: expected true, got false`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function runTests() {
  // ── parseCellNumber ──────────────────────────────────────

  await test('parseCellNumber: JSON {"cell": 42}', () => {
    assertEqual(parseCellNumber('{"cell": 42}', 96), 42, 'cell 42');
  });

  await test('parseCellNumber: JSON with whitespace', () => {
    assertEqual(parseCellNumber('  {"cell": 7}  ', 96), 7, 'cell 7');
  });

  await test('parseCellNumber: cell 0 signals conceptual', () => {
    assertEqual(parseCellNumber('{"cell": 0}', 96), 0, 'cell 0');
  });

  await test('parseCellNumber: fallback key "number"', () => {
    assertEqual(parseCellNumber('{"number": 15}', 96), 15, 'number 15');
  });

  await test('parseCellNumber: fallback key "n"', () => {
    assertEqual(parseCellNumber('{"n": 23}', 96), 23, 'n 23');
  });

  await test('parseCellNumber: bare integer in prose', () => {
    assertEqual(parseCellNumber('I think it is cell 37.', 96), 37, 'bare 37');
  });

  await test('parseCellNumber: first valid integer wins', () => {
    assertEqual(parseCellNumber('cell 5 or maybe 10', 96), 5, 'first valid');
  });

  await test('parseCellNumber: out-of-range returns null', () => {
    assertEqual(parseCellNumber('{"cell": 999}', 96), null, '999 out of range');
  });

  await test('parseCellNumber: no number returns null', () => {
    assertEqual(parseCellNumber('I cannot find it', 96), null, 'no number');
  });

  await test('parseCellNumber: empty string returns null', () => {
    assertEqual(parseCellNumber('', 96), null, 'empty');
  });

  await test('parseCellNumber: JSON with extra text', () => {
    assertEqual(parseCellNumber('Sure! {"cell": 55} There you go.', 96), 55, 'json in prose');
  });

  await test('parseCellNumber: invalid JSON falls back to int scan', () => {
    assertEqual(parseCellNumber('{cell: 12}', 96), 12, 'invalid json -> int scan');
  });

  await test('parseCellNumber: 0 from bare int is valid (conceptual)', () => {
    assertEqual(parseCellNumber('0', 96), 0, 'bare 0');
  });

  // ── buildGridSVG ─────────────────────────────────────────

  await test('buildGridSVG: basic structure', () => {
    const svg = buildGridSVG(1200, 800, 12, 8);
    assertTrue(svg.startsWith('<svg'), 'starts with <svg');
    assertTrue(svg.endsWith('</svg>'), 'ends with </svg>');
    assertTrue(svg.includes('xmlns'), 'has xmlns');
  });

  await test('buildGridSVG: correct number of cell labels', () => {
    const svg = buildGridSVG(1200, 800, 12, 8);
    const labelMatches = svg.match(/<text /g);
    assertEqual(labelMatches?.length, 96, '96 text labels for 12x8');
  });

  await test('buildGridSVG: correct number for 6x6', () => {
    const svg = buildGridSVG(768, 768, 6, 6);
    const labelMatches = svg.match(/<text /g);
    assertEqual(labelMatches?.length, 36, '36 text labels for 6x6');
  });

  await test('buildGridSVG: has grid lines', () => {
    const svg = buildGridSVG(1200, 800, 12, 8);
    const lineMatches = svg.match(/<line /g);
    // 11 vertical + 7 horizontal = 18 lines
    assertEqual(lineMatches?.length, 18, '18 grid lines for 12x8');
  });

  await test('buildGridSVG: labels are numbered 1..N sequentially', () => {
    const svg = buildGridSVG(600, 400, 6, 4);
    for (let i = 1; i <= 24; i++) {
      assertTrue(svg.includes(`>${i}</text>`), `contains label ${i}`);
    }
  });

  await test('buildGridSVG: red color in lines and labels', () => {
    const svg = buildGridSVG(600, 400, 6, 4);
    assertTrue(svg.includes('255,0,0'), 'contains red color');
  });

  await test('buildGridSVG: width/height in svg tag', () => {
    const svg = buildGridSVG(1200, 800, 12, 8);
    assertTrue(svg.includes('width="1200"'), 'width set');
    assertTrue(svg.includes('height="800"'), 'height set');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
