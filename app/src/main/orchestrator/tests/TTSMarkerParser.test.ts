/**
 * Bud — TTS Marker Parser Tests
 *
 * Run with: npx ts-node app/src/main/orchestrator/tests/TTSMarkerParser.test.ts
 */

import { TTSMarkerParser } from '../TTSMarkerParser';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error('❌ FAIL:', message);
    process.exit(1);
  }
  console.log('✅ PASS:', message);
}

function runTests() {
  // Test 1: Simple TTS marker
  {
    const parser = new TTSMarkerParser();
    const chunks = parser.push('<TTS>on it</TTS>');
    assert(chunks.length === 1, 'single TTS marker produces one chunk');
    assert(chunks[0].tts === 'on it', 'TTS text extracted');
    assert(chunks[0].text === '', 'no plain text alongside TTS');
    assert(parser.flush() === '', 'flush returns empty after complete marker');
  }

  // Test 2: Plain text then TTS
  {
    const parser = new TTSMarkerParser();
    const chunks = parser.push('Checking now... <TTS>found it</TTS>');
    assert(chunks.length === 2, 'plain text + TTS produces two chunks');
    assert(chunks[0].text === 'Checking now... ', 'plain text extracted');
    assert(chunks[1].tts === 'found it', 'TTS extracted after plain text');
  }

  // Test 3: Split across chunks
  {
    const parser = new TTSMarkerParser();
    parser.push('<TTS>on');
    const chunks = parser.push(' it</TTS>');
    assert(chunks.length === 1, 'split TTS marker completes in second chunk');
    assert(chunks[0].tts === 'on it', 'split TTS text assembled');
  }

  // Test 4: Multiple TTS markers
  {
    const parser = new TTSMarkerParser();
    const chunks = parser.push('<TTS>one</TTS> two <TTS>three</TTS>');
    assert(chunks.length === 3, 'multiple markers and text produce correct chunks');
    assert(chunks[0].tts === 'one', 'first TTS');
    assert(chunks[1].text === ' two ', 'middle text');
    assert(chunks[2].tts === 'three', 'second TTS');
  }

  // Test 5: No markers
  {
    const parser = new TTSMarkerParser();
    const chunks = parser.push('just plain text');
    assert(chunks.length === 1, 'plain text produces one chunk');
    assert(chunks[0].text === 'just plain text', 'plain text preserved');
    assert(!chunks[0].tts, 'no TTS in plain text');
  }

  // Test 6: Incomplete marker at end flushes as leftover
  {
    const parser = new TTSMarkerParser();
    parser.push('<TTS>incomplete');
    const leftover = parser.flush();
    assert(leftover === '', 'incomplete TTS marker is dropped on flush');
  }

  console.log('\n🎉 All TTSMarkerParser tests passed');
}

runTests();
