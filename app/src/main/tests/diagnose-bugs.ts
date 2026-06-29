/**
 * Bud — Regression harness for reported bugs
 *
 * Locking down fixes for:
 * 1. Spotify "play <song>" resuming instead of changing track
 * 1b. Spotify set_volume ignoring model's volume_percent parameter
 * 2. spawnWorker writing files into the build directory
 * 2b. Worker crashing on empty/malformed tool-call arguments
 * 3. Calendar queries falling back to local/Windows calendar
 * 4. Gmail send_message dropping file attachments
 * 5. File attachments read as text / no readFile tool
 * 6. Slack read_messages failing silently and requiring channel IDs
 *
 * Run with: npm run build && node dist/main/tests/diagnose-bugs.js
 */
import module from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Electron Mocking (must be done before any imports) ---
const mockElectron = {
  screen: {
    getAllDisplays: () => [{ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1 }],
    getPrimaryDisplay: () => ({ scaleFactor: 1 }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1 }),
  },
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: () => tmpUserData,
  },
  ipcMain: {
    handle: () => {},
  },
  shell: {
    openExternal: () => {},
  },
  BrowserWindow: class MockBrowserWindow {
    webContents = { send: () => {} };
  },
};

const originalRequire = module.prototype.require;
module.prototype.require = function (id: string) {
  if (id === 'electron') {
    return mockElectron;
  }
  return originalRequire.apply(this, arguments as any);
};

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

function assertDeepEqual(actual: any, expected: any, message: string) {
  const aStr = JSON.stringify(actual);
  const eStr = JSON.stringify(expected);
  if (aStr !== eStr) {
    console.error(`❌ FAIL: ${message}\n   Expected: ${eStr}\n   Actual: ${aStr}`);
    failed++;
  } else {
    console.log(`✅ PASS: ${message}`);
    passed++;
  }
}

// --- Temp environment ---
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'bud-diag-'));
process.env.BUD_USER_DATA = tmpUserData;

// Write fake tokens so auth providers don't trigger OAuth flows
fs.mkdirSync(tmpUserData, { recursive: true });
fs.writeFileSync(
  path.join(tmpUserData, 'spotify_tokens.json'),
  JSON.stringify({ access_token: 'FAKE_SPOTIFY_TOKEN', refresh_token: 'FAKE_REFRESH', expires_at: Date.now() + 3600000 })
);
fs.writeFileSync(
  path.join(tmpUserData, 'google_tokens.json'),
  JSON.stringify({ access_token: 'FAKE_GOOGLE_TOKEN', refresh_token: 'FAKE_REFRESH', expires_at: Date.now() + 3600000 })
);

process.env.SLACK_BOT_TOKEN = 'xoxb-fake-slack-token';

// --- Imports ---
import { appsTool } from '../tools/appsTool';
import { createFileReaderTool } from '../tools/fileReaderTool';
import { REALTIME_SYSTEM_INSTRUCTIONS } from '../realtime/realtimeTypes';
import { BUD_SYSTEM_PROMPT } from '../agentPrompts';

// ===========================================================
// BUG 1 — Spotify "play <song>" just resumes current track
// ===========================================================

async function testSpotifyPlayParameterHandling() {
  console.log('\n--- Bug 1: Spotify play parameter handling ---');

  const requests: { url: string; method: string; body: any }[] = [];
  const originalFetch = global.fetch;

  global.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    let body: any = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch {
      body = init.body;
    }
    requests.push({ url, method: init.method || 'GET', body });

    // Return plausible Spotify responses
    if (url.includes('/player/play')) {
      return { ok: true, status: 204, text: async () => '' } as any;
    }
    if (url.includes('/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tracks: {
            items: [{ name: 'Mock Track', uri: 'spotify:track:MOCK123', artists: [{ name: 'Mock Artist' }] }],
          },
        }),
      } as any;
    }
    if (url.includes('/devices')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ devices: [{ id: 'device1', name: 'DESKTOP', type: 'Computer', is_active: true }] }),
      } as any;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as any;
  };

  // Simulate the parameter shapes a model might generate after the prompt
  const cases = [
    { label: 'correct uri param', params: { uri: 'spotify:track:MOCK123' }, expectTrackChange: true },
    { label: 'context_uri param', params: { context_uri: 'spotify:album:MOCK456' }, expectTrackChange: true },
    { label: 'track_uri alias', params: { track_uri: 'spotify:track:MOCK123' }, expectTrackChange: true },
    { label: 'track name param (auto-search)', params: { track: 'Blinding Lights' }, expectTrackChange: true },
    { label: 'query param (auto-search)', params: { query: 'Blinding Lights' }, expectTrackChange: true },
    { label: 'no params', params: {}, expectTrackChange: false },
  ];

  for (const c of cases) {
    requests.length = 0;
    const result = await (appsTool as any).execute(
      { service: 'spotify', action: 'play', parameters: c.params, reason: 'test' },
      { toolCallId: 'diag-spotify', messages: [] }
    );
    const playReq = requests.find((r) => r.url.includes('/player/play'));
    const changed = !!(playReq?.body?.uris?.length || playReq?.body?.context_uri);

    assertEqual(changed, c.expectTrackChange, `Spotify play with ${c.label} should ${c.expectTrackChange ? 'change' : 'resume'} track`);
    if (!c.expectTrackChange && !changed) {
      console.log(`   → play body was: ${JSON.stringify(playReq?.body)}`);
    }
  }

  global.fetch = originalFetch;
}

// ===========================================================
// BUG 2 — spawnWorker creates files in unexpected places / fails
// ===========================================================

async function testWorkerFileLocation() {
  console.log('\n--- Bug 2: Worker file write location ---');

  // The worker is forked from dist/main/tools/spawnWorker.js
  // It resolves worker.js as __dirname/../../worker/worker.js
  // When the worker writes a relative path, it lands in dist/worker.
  const spawnWorkerDir = path.join(__dirname, '..', 'tools');
  const workerJsPath = path.join(spawnWorkerDir, '..', '..', 'worker', 'worker.js');
  const workerCwd = path.dirname(workerJsPath);
  const defaultRelativeWrite = path.join(workerCwd, 'game.html');

  console.log(`   spawnWorker __dirname: ${spawnWorkerDir}`);
  console.log(`   Computed worker.js path: ${workerJsPath}`);
  console.log(`   Worker CWD (dirname of worker.js): ${workerCwd}`);
  console.log(`   Relative 'game.html' would land at: ${defaultRelativeWrite}`);

  assert(
    fs.existsSync(workerJsPath),
    'Compiled worker.js exists at the path spawnWorker computes'
  );

  assert(
    defaultRelativeWrite.includes('dist') || defaultRelativeWrite.includes('release'),
    'Relative worker writes land in build dir, not user documents'
  );

  // After the fix, spawnWorker should inject a visible WORKER_OUTPUT_DIR and
  // create the directory before forking.
  const spawnWorkerSource = fs.readFileSync(path.join(spawnWorkerDir, 'spawnWorker.js'), 'utf-8');
  assert(
    spawnWorkerSource.includes('WORKER_OUTPUT_DIR'),
    'spawnWorker injects WORKER_OUTPUT_DIR into worker env'
  );
  assert(
    spawnWorkerSource.includes('mkdirSync(workerOutputDir') && spawnWorkerSource.includes("'worker-output'"),
    'spawnWorker creates the worker output directory before forking'
  );
  assert(
    spawnWorkerSource.includes('cwd: workerOutputDir'),
    'spawnWorker sets worker CWD to the output directory so relative paths land there'
  );
}

// ===========================================================
// BUG 3 — Calendar routing uses local instead of Google Calendar
// ===========================================================

async function testCalendarRoutingInPrompts() {
  console.log('\n--- Bug 3: Calendar routing in prompts ---');

  const chatPrompt = BUD_SYSTEM_PROMPT;
  const realtimePrompt = REALTIME_SYSTEM_INSTRUCTIONS;

  assert(
    chatPrompt.toLowerCase().includes('calendar → appsTool') || chatPrompt.toLowerCase().includes('calendar → appstool'),
    'Chat prompt routes Calendar to appsTool'
  );

  assert(
    realtimePrompt.toLowerCase().includes('calendar'),
    'Realtime prompt mentions calendar'
  );
  assert(
    realtimePrompt.toLowerCase().includes('google calendar'),
    'Realtime prompt explicitly mentions Google Calendar'
  );

  // The exact service enum 'google_calendar' should be in both prompts so the model
  // does not fall back to windowsTool / local calendar.
  assert(
    chatPrompt.toLowerCase().includes('google_calendar'),
    'Chat prompt mentions exact google_calendar service enum'
  );
  assert(
    realtimePrompt.toLowerCase().includes('google_calendar'),
    'Realtime prompt mentions exact google_calendar service enum'
  );
}

// ===========================================================
// BUG 1b — Spotify set_volume ignores volume_percent
// ===========================================================

async function testSpotifyVolumePercentAlias() {
  console.log('\n--- Bug 1b: Spotify set_volume volume_percent alias ---');

  const requests: { url: string }[] = [];
  const originalFetch = global.fetch;

  global.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    requests.push({ url });
    return { ok: true, status: 204, text: async () => '' } as any;
  };

  const result = await (appsTool as any).execute(
    { service: 'spotify', action: 'set_volume', parameters: { volume_percent: 10 }, reason: 'test' },
    { toolCallId: 'diag-spotify-vol', messages: [] }
  );

  global.fetch = originalFetch;

  const volReq = requests.find((r) => r.url.includes('/volume?'));
  assert(
    volReq !== undefined && volReq.url.includes('volume_percent=10'),
    'set_volume should use volume_percent parameter from model'
  );
  assert(
    volReq === undefined || !volReq.url.includes('volume_percent=50'),
    'set_volume should not fall back to default 50 when volume_percent is provided'
  );
  assertEqual(result.volume, 10, 'set_volume result reports the applied volume');
}

// ===========================================================
// BUG 2b — Worker crashes on empty tool-call arguments
// ===========================================================

async function testWorkerHandlesEmptyToolArguments() {
  console.log('\n--- Bug 2b: Worker handles empty/malformed tool arguments ---');

  const workerSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'worker', 'worker.js'),
    'utf-8'
  );

  assert(
    workerSource.includes('tc.function.arguments ? JSON.parse(tc.function.arguments) : {}'),
    'Worker guards JSON.parse against empty tool arguments'
  );
  assert(
    workerSource.includes('invalid tool arguments'),
    'Worker reports a graceful error for malformed tool arguments instead of crashing'
  );
}

// ===========================================================
// BUG 4 — Gmail send_message ignores attachments
// ===========================================================

async function testGmailAttachmentSupport() {
  console.log('\n--- Bug 4: Gmail attachment support ---');

  const attachmentFile = path.join(tmpUserData, 'test-attachment.txt');
  const fileContent = 'Hello from Bud attachment test!';
  fs.writeFileSync(attachmentFile, fileContent, 'utf-8');

  let capturedRaw: string | undefined;
  const originalFetch = global.fetch;

  global.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/messages/send')) {
      const body = init.body ? JSON.parse(init.body) : {};
      capturedRaw = body.raw;
      return { ok: true, status: 200, json: async () => ({ id: 'mock-message-id' }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as any;
  };

  // Simulate what the model is likely to do: pass an attachment path
  const result = await (appsTool as any).execute(
    {
      service: 'gmail',
      action: 'send_message',
      parameters: {
        to: 'test@example.com',
        subject: 'Test attachment',
        body: 'See attached file.',
        attachments: [{ path: attachmentFile, filename: 'test-attachment.txt' }],
      },
      reason: 'test',
    },
    { toolCallId: 'diag-gmail', messages: [] }
  );

  global.fetch = originalFetch;

  assert(result.success !== false, 'Gmail send_message should not report failure');
  assert(
    capturedRaw !== undefined,
    'Gmail send_message should POST a raw MIME message'
  );

  if (capturedRaw) {
    const decoded = Buffer.from(capturedRaw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const fileContentBase64 = Buffer.from(fileContent, 'utf-8').toString('base64');
    const hasAttachmentContent = decoded.includes(fileContentBase64);
    const hasContentDisposition = decoded.toLowerCase().includes('content-disposition: attachment');
    const hasMultipartMixed = decoded.toLowerCase().includes('content-type: multipart/mixed');

    assert(hasMultipartMixed, 'Raw message should be multipart/mixed to carry attachments');
    assert(hasContentDisposition, 'Raw message should mark the part as an attachment');
    assert(hasAttachmentContent, 'Raw message should contain the base64 attachment payload');
  }
}

// ===========================================================
// BUG 5 — File attachments: PDFs read as text, no readFile tool
// ===========================================================

async function testFileAttachmentHandling() {
  console.log('\n--- Bug 5: File attachment handling ---');

  const tool = createFileReaderTool();
  const fileTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bud-diag-file-'));

  try {
    // Text file
    const txtPath = path.join(fileTmpDir, 'test.txt');
    fs.writeFileSync(txtPath, 'Hello from Bud text file!', 'utf-8');

    // Minimal valid PDF with literal text
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
    const pdfPath = path.join(fileTmpDir, 'test.pdf');
    fs.writeFileSync(pdfPath, pdf, 'binary');

    // Image: 1x1 PNG
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const imgPath = path.join(fileTmpDir, 'test.png');
    fs.writeFileSync(imgPath, Buffer.from(pngBase64, 'base64'));

    // Source files include the new tool
    const toolsIndex = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main', 'tools', 'index.ts'), 'utf-8');
    assert(
      toolsIndex.includes('fileReaderTool') || toolsIndex.includes('readFile'),
      'tools/index.ts exports the readFile tool'
    );

    // Text file reads cleanly
    const txtResult = await (tool as any).execute({ path: txtPath });
    assertEqual(txtResult.success, true, 'readFile succeeds for text files');
    assert(
      (txtResult.content || '').includes('Hello from Bud text file!'),
      'readFile returns text file content'
    );

    // PDF extracts text
    const pdfResult = await (tool as any).execute({ path: pdfPath });
    assertEqual(pdfResult.success, true, 'readFile succeeds for PDF files');
    assert(
      (pdfResult.content || '').includes('Hello from Bud PDF test!'),
      'readFile extracts readable text from PDF'
    );

    // Image returns base64
    const imgResult = await (tool as any).execute({ path: imgPath });
    assertEqual(imgResult.success, true, 'readFile succeeds for image files');
    assertEqual(imgResult.mediaType, 'image/png', 'readFile returns correct image mediaType');
    assert(
      typeof imgResult.content === 'string' && imgResult.content.length > 0,
      'readFile returns base64 image content'
    );

    // Prompts mention the readFile tool so the model knows to use it
    assert(
      BUD_SYSTEM_PROMPT.includes('readFile'),
      'Chat system prompt mentions readFile tool'
    );
    assert(
      REALTIME_SYSTEM_INSTRUCTIONS.includes('readFile'),
      'Realtime system prompt mentions readFile tool'
    );
  } finally {
    fs.rmSync(fileTmpDir, { recursive: true, force: true });
  }
}

// ===========================================================
// BUG 6 — Slack read_messages fails silently / needs channel ID
// ===========================================================

async function testSlackReadMessagesResolvesChannelAndSurfacesErrors() {
  console.log('\n--- Bug 6: Slack read_messages channel handling ---');

  const originalFetch = global.fetch;
  const calls: { url: string; method?: string; body?: any }[] = [];

  global.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method || 'GET';
    let body: any = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch {
      body = init.body;
    }
    calls.push({ url, method, body });

    // conversations.list
    if (url.includes('/conversations.list')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          channels: [
            { id: 'C123', name: 'general' },
            { id: 'C456', name: 'random' },
          ],
        }),
      } as any;
    }

    // conversations.history
    if (url.includes('/conversations.history')) {
      const channelId = new URL(url, 'https://slack.com').searchParams.get('channel');
      if (channelId === 'C123') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            messages: [
              { user: 'U1', text: 'Hello Slack', ts: '1234567890.000001' },
            ],
          }),
        } as any;
      }
      // Slack error for invalid channel ID/name
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: 'channel_not_found', needed: 'more_actions' }),
      } as any;
    }

    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' } as any;
  };

  // Case 1: Slack error should be surfaced
  const badResult = await (appsTool as any).execute(
    { service: 'slack', action: 'read_messages', parameters: { channel: 'C999' }, reason: 'test' },
    { toolCallId: 'diag-slack-1', messages: [] }
  );
  assertEqual(badResult.success, false, 'read_messages reports failure when Slack returns ok:false');
  assert(
    (badResult.error || '').includes('channel_not_found'),
    'read_messages surfaces the Slack error reason'
  );

  // Case 2: Channel name should be resolved to channel ID
  calls.length = 0;
  const nameResult = await (appsTool as any).execute(
    { service: 'slack', action: 'read_messages', parameters: { channel: 'general' }, reason: 'test' },
    { toolCallId: 'diag-slack-2', messages: [] }
  );
  assertEqual(nameResult.success, true, 'read_messages succeeds when given a valid channel name');
  assert(
    (nameResult.messages || []).some((m: any) => m.text === 'Hello Slack'),
    'read_messages returns messages after resolving channel name'
  );
  const historyCall = calls.find((c) => c.url.includes('/conversations.history'));
  assert(
    !!(historyCall && historyCall.url.includes('channel=C123')),
    'read_messages calls Slack with the resolved channel ID'
  );

  // Case 3: Missing channel should list available channels
  calls.length = 0;
  const noChannelResult = await (appsTool as any).execute(
    { service: 'slack', action: 'read_messages', parameters: {}, reason: 'test' },
    { toolCallId: 'diag-slack-3', messages: [] }
  );
  assertEqual(noChannelResult.success, false, 'read_messages reports failure when channel is missing');
  assert(
    Array.isArray(noChannelResult.channels) && noChannelResult.channels.length > 0,
    'read_messages returns channel list when no channel is provided'
  );

  global.fetch = originalFetch;
}

// --- Main Runner ---
async function runAll() {
  try {
    await testSpotifyPlayParameterHandling();
    await testSpotifyVolumePercentAlias();
    await testWorkerFileLocation();
    await testWorkerHandlesEmptyToolArguments();
    await testCalendarRoutingInPrompts();
    await testGmailAttachmentSupport();
    await testFileAttachmentHandling();
    await testSlackReadMessagesResolvesChannelAndSurfacesErrors();

    console.log(`\n===================================`);
    console.log(`🏁 Diagnostic run complete.`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`===================================`);

    // Cleanup temp dir
    fs.rmSync(tmpUserData, { recursive: true, force: true });

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('Fatal diagnostic runner error:', err);
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    process.exit(1);
  }
}

runAll();
