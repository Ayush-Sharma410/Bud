import { tool, jsonSchema } from 'ai';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { SpotifyAuthProvider } from '../providers/SpotifyAuthProvider';
import { GoogleAuthProvider } from '../providers/GoogleAuthProvider';

const execAsync = promisify(exec);

/** Run a PowerShell command and return stdout */
async function runPS(command: string): Promise<string> {
  try {
    const escaped = command.replace(/"/g, '\\"');
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "${escaped}"`,
      { maxBuffer: 1024 * 1024, timeout: 30_000 }
    );
    return stdout.trim();
  } catch (err: any) {
    return `[Error] ${err.message}`;
  }
}

// ════════════════════════════════════════════════════════════════
//  Service Handlers — each returns a structured result object.
//  API keys are read from process.env at call time so they can
//  be set after app startup.
// ════════════════════════════════════════════════════════════════

// ── Spotify ──────────────────────────────────────────────────
async function handleSpotify(action: string, params: any): Promise<any> {
  let token = await SpotifyAuthProvider.getValidAccessToken();
  if (!token) {
    console.log('No valid Spotify token found. Initiating OAuth flow...');
    token = await SpotifyAuthProvider.authorize();
  }
  if (!token) return { success: false, error: 'Failed to authenticate with Spotify' };

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://api.spotify.com/v1/me/player';

  switch (action) {
    case 'play': {
      const body: any = {};

      // Accept the canonical `uri` as well as common alternative parameter names
      // the model may emit after a search step.
      const uri = params?.uri || params?.track_uri || params?.song_uri;
      const contextUri = params?.context_uri || params?.album_uri || params?.playlist_uri;

      if (uri) {
        body.uris = [uri];
      } else if (contextUri) {
        body.context_uri = contextUri;
      } else {
        // If the model passed a plain text query instead of a URI, search and play
        // the first matching track automatically. This prevents accidentally
        // resuming the current song with an empty body.
        const textQuery = params?.query || params?.track || params?.song;
        if (textQuery && typeof textQuery === 'string') {
          const searchRes = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(textQuery)}&type=track&limit=1`,
            { headers }
          );
          const searchData = await searchRes.json() as any;
          const trackUri = searchData?.tracks?.items?.[0]?.uri;
          if (trackUri) {
            body.uris = [trackUri];
          } else {
            return { success: false, error: `No Spotify track found for "${textQuery}"` };
          }
        }
      }

      const deviceId = params?.device_id;
      const url = deviceId ? `${base}/play?device_id=${deviceId}` : `${base}/play`;
      const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (res.status === 404) {
        return { success: false, status: 404, error: 'NO_ACTIVE_DEVICE', hint: 'Use action="devices" to list available devices, then use action="transfer_playback" with a device_id to activate one, then retry play.' };
      }
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      return { success: true, status: res.status, body };
    }
    case 'pause': {
      const res = await fetch(`${base}/pause`, { method: 'PUT', headers });
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      return { success: true, status: res.status };
    }
    case 'next': {
      const res = await fetch(`${base}/next`, { method: 'POST', headers });
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      return { success: true, status: res.status };
    }
    case 'previous': {
      const res = await fetch(`${base}/previous`, { method: 'POST', headers });
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      return { success: true, status: res.status };
    }
    case 'current':
    case 'now_playing': {
      const res = await fetch(`${base}/currently-playing`, { headers });
      if (!res.ok) return { success: false, status: res.status };
      const data = await res.json() as any;
      return {
        success: true,
        track: data?.item?.name,
        artist: data?.item?.artists?.map((a: any) => a.name).join(', '),
        album: data?.item?.album?.name,
        isPlaying: data?.is_playing,
      };
    }
    case 'search': {
      const q = params?.query || params?.track || '';
      const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`, { headers });
      const data = await res.json() as any;
      return {
        success: true,
        tracks: data?.tracks?.items?.map((t: any) => ({
          name: t.name, artist: t.artists[0]?.name, uri: t.uri,
        })),
      };
    }
    case 'set_volume': {
      // The Spotify API field is `volume_percent`; accept both that and the shorter aliases.
      const vol = params?.volume_percent ?? params?.volume ?? params?.level ?? 50;
      const deviceId = params?.device_id;
      const url = deviceId ? `${base}/volume?volume_percent=${vol}&device_id=${deviceId}` : `${base}/volume?volume_percent=${vol}`;
      const res = await fetch(url, { method: 'PUT', headers });
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      return { success: true, status: res.status, volume: vol };
    }
    case 'devices': {
      const res = await fetch(`${base}/devices`, { headers });
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      const data = await res.json() as any;
      return {
        success: true,
        devices: data?.devices?.map((d: any) => ({
          id: d.id,
          name: d.name,
          type: d.type,
          is_active: d.is_active,
          is_restricted: d.is_restricted,
          volume_percent: d.volume_percent,
        })),
      };
    }
    case 'transfer_playback': {
      const deviceId = params?.device_id;
      if (!deviceId) return { success: false, error: 'device_id is required for transfer_playback' };
      const res = await fetch(`${base}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ device_ids: [deviceId], play: params?.play ?? false }),
      });
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      return { success: true, status: res.status };
    }
    default:
      return { success: false, error: `Unknown Spotify action: ${action}` };
  }
}

// ── GitHub ────────────────────────────────────────────────────
async function handleGitHub(action: string, params: any): Promise<any> {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) return { success: false, error: 'GITHUB_TOKEN not configured' };

  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  const base = 'https://api.github.com';

  switch (action) {
    case 'list_repos': {
      const res = await fetch(`${base}/user/repos?sort=updated&per_page=10`, { headers });
      const data = await res.json() as any[];
      return {
        success: true,
        repos: data.map((r: any) => ({ name: r.full_name, url: r.html_url, stars: r.stargazers_count })),
      };
    }
    case 'create_issue': {
      const { owner, repo, title, body } = params || {};
      if (!owner || !repo || !title) return { success: false, error: 'Need owner, repo, title' };
      const res = await fetch(`${base}/repos/${owner}/${repo}/issues`, {
        method: 'POST', headers,
        body: JSON.stringify({ title, body: body || '' }),
      });
      const data = await res.json() as any;
      return { success: res.ok, issueNumber: data.number, url: data.html_url };
    }
    case 'list_issues': {
      const { owner, repo } = params || {};
      if (!owner || !repo) return { success: false, error: 'Need owner, repo' };
      const res = await fetch(`${base}/repos/${owner}/${repo}/issues?state=open&per_page=10`, { headers });
      const data = await res.json() as any[];
      return {
        success: true,
        issues: data.map((i: any) => ({ number: i.number, title: i.title, state: i.state })),
      };
    }
    case 'search_repo': {
      const q = params?.query || '';
      const res = await fetch(`${base}/search/repositories?q=${encodeURIComponent(q)}&per_page=5`, { headers });
      const data = await res.json() as any;
      return {
        success: true,
        repos: data?.items?.map((r: any) => ({ name: r.full_name, description: r.description, stars: r.stargazers_count })),
      };
    }
    case 'get_notifications': {
      const res = await fetch(`${base}/notifications?per_page=10`, { headers });
      const data = await res.json() as any[];
      return {
        success: true,
        notifications: data.map((n: any) => ({ title: n.subject?.title, type: n.subject?.type, reason: n.reason })),
      };
    }
    default:
      return { success: false, error: `Unknown GitHub action: ${action}` };
  }
}

// ── Gmail (via Google API) ───────────────────────────────────
async function handleGmail(action: string, params: any): Promise<any> {
  let token = await GoogleAuthProvider.getValidAccessToken();
  if (!token) {
    console.log('No valid Google token found. Initiating OAuth flow...');
    token = await GoogleAuthProvider.authorize();
  }
  if (!token) return { success: false, error: 'Failed to authenticate with Google' };

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';

  switch (action) {
    case 'list_messages':
    case 'inbox': {
      const q = params?.query || '';
      const res = await fetch(`${base}/messages?maxResults=10&q=${encodeURIComponent(q)}`, { headers });
      const data = await res.json() as any;
      return { success: res.ok, messageIds: data?.messages?.map((m: any) => m.id) || [] };
    }
    case 'read_message': {
      const { messageId } = params || {};
      if (!messageId) return { success: false, error: 'Need messageId' };
      const res = await fetch(`${base}/messages/${messageId}?format=full`, { headers });
      const data = await res.json() as any;
      const subject = data?.payload?.headers?.find((h: any) => h.name === 'Subject')?.value;
      const from = data?.payload?.headers?.find((h: any) => h.name === 'From')?.value;
      return { success: res.ok, subject, from, snippet: data?.snippet };
    }
    case 'send_message': {
      const { to, subject, body, attachments } = params || {};
      if (!to || !subject) return { success: false, error: 'Need to, subject' };

      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
      let rawText: string;

      if (!hasAttachments) {
        rawText = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body || ''}`;
      } else {
        const boundary = `bud_mixed_${Math.random().toString(36).slice(2)}`;
        const parts: string[] = [
          `To: ${to}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          `Content-Type: text/plain; charset=utf-8`,
          '',
          body || '',
        ];

        for (const att of attachments) {
          const filename = att.filename || path.basename(att.path) || 'attachment';
          const mimeType = att.mimeType || 'application/octet-stream';
          let dataBase64: string;

          if (att.path && fs.existsSync(att.path) && fs.statSync(att.path).isFile()) {
            dataBase64 = fs.readFileSync(att.path).toString('base64');
          } else if (att.data && typeof att.data === 'string') {
            dataBase64 = att.data.replace(/^data:[^;]+;base64,/, '');
          } else {
            return { success: false, error: `Attachment ${filename} has no readable path or base64 data` };
          }

          parts.push(
            `--${boundary}`,
            `Content-Type: ${mimeType}; name="${filename}"`,
            `Content-Disposition: attachment; filename="${filename}"`,
            `Content-Transfer-Encoding: base64`,
            '',
            dataBase64,
            ''
          );
        }

        parts.push(`--${boundary}--`);
        rawText = parts.join('\r\n');
      }

      const raw = Buffer.from(rawText, 'utf8').toString('base64url');
      const res = await fetch(`${base}/messages/send`, {
        method: 'POST', headers,
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) return { success: false, status: res.status, error: await res.text() };
      return { success: true, status: res.status };
    }
    default:
      return { success: false, error: `Unknown Gmail action: ${action}` };
  }
}

// ── Slack ─────────────────────────────────────────────────────
async function handleSlack(action: string, params: any): Promise<any> {
  const token = process.env.SLACK_BOT_TOKEN || '';
  if (!token) return { success: false, error: 'SLACK_BOT_TOKEN not configured' };

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://slack.com/api';

  async function slackGet(endpoint: string, query = ''): Promise<any> {
    const url = `${base}${endpoint}${query ? '?' + query : ''}`;
    const res = await fetch(url, { headers });
    const data = await res.json() as any;
    if (!data.ok) {
      return { success: false, error: data.error || `Slack API error on ${endpoint}`, slackResponse: data };
    }
    return { success: true, ...data };
  }

  async function slackPost(endpoint: string, body: any): Promise<any> {
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST', headers,
      body: JSON.stringify(body),
    });
    const data = await res.json() as any;
    if (!data.ok) {
      return { success: false, error: data.error || `Slack API error on ${endpoint}`, slackResponse: data };
    }
    return { success: true, ...data };
  }

  async function listChannels(): Promise<{ id: string; name: string }[]> {
    const result = await slackGet('/conversations.list', 'types=public_channel,private_channel&limit=50');
    if (!result.success) return [];
    return (result.channels || []).map((c: any) => ({ id: c.id, name: c.name }));
  }

  async function resolveChannel(channel: string): Promise<string | null> {
    if (!channel) return null;
    // Slack channel IDs start with C (public), D (DM), or G (group).
    if (/^[CDG][A-Z0-9]+$/.test(channel)) return channel;
    const channels = await listChannels();
    const match = channels.find((c) => c.name.toLowerCase() === channel.toLowerCase());
    return match ? match.id : null;
  }

  switch (action) {
    case 'send_message': {
      const { channel, text } = params || {};
      if (!channel || !text) return { success: false, error: 'Need channel, text' };
      const channelId = await resolveChannel(channel);
      if (!channelId) return { success: false, error: `Could not find Slack channel: ${channel}` };
      return slackPost('/chat.postMessage', { channel: channelId, text });
    }
    case 'list_channels': {
      const channels = await listChannels();
      return { success: true, channels };
    }
    case 'read_messages': {
      const { channel, limit } = params || {};
      if (!channel) {
        const channels = await listChannels();
        return {
          success: false,
          error: 'Need a channel. Available channels: ' + channels.map((c) => `${c.name} (${c.id})`).join(', '),
          channels,
        };
      }
      const channelId = await resolveChannel(channel);
      if (!channelId) {
        const channels = await listChannels();
        return {
          success: false,
          error: `Could not find Slack channel: ${channel}`,
          channels,
        };
      }
      const result = await slackGet('/conversations.history', `channel=${channelId}&limit=${limit || 10}`);
      if (!result.success) return result;
      return {
        success: true,
        messages: (result.messages || []).map((m: any) => ({ user: m.user, text: m.text, ts: m.ts })),
      };
    }
    default:
      return { success: false, error: `Unknown Slack action: ${action}` };
  }
}

// ── Discord ──────────────────────────────────────────────────
async function handleDiscord(action: string, params: any): Promise<any> {
  const token = process.env.DISCORD_BOT_TOKEN || '';
  if (!token) return { success: false, error: 'DISCORD_BOT_TOKEN not configured' };

  const headers = { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://discord.com/api/v10';

  switch (action) {
    case 'send_message': {
      const { channelId, content } = params || {};
      if (!channelId || !content) return { success: false, error: 'Need channelId, content' };
      const res = await fetch(`${base}/channels/${channelId}/messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ content }),
      });
      return { success: res.ok };
    }
    case 'read_messages': {
      const { channelId, limit } = params || {};
      if (!channelId) return { success: false, error: 'Need channelId' };
      const res = await fetch(`${base}/channels/${channelId}/messages?limit=${limit || 10}`, { headers });
      const data = await res.json() as any[];
      return {
        success: true,
        messages: data.map((m: any) => ({ author: m.author?.username, content: m.content })),
      };
    }
    default:
      return { success: false, error: `Unknown Discord action: ${action}` };
  }
}

// ── Notion ───────────────────────────────────────────────────
async function handleNotion(action: string, params: any): Promise<any> {
  const token = process.env.NOTION_API_KEY || '';
  if (!token) return { success: false, error: 'NOTION_API_KEY not configured' };

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };
  const base = 'https://api.notion.com/v1';

  switch (action) {
    case 'search': {
      const q = params?.query || '';
      const res = await fetch(`${base}/search`, {
        method: 'POST', headers,
        body: JSON.stringify({ query: q, page_size: 10 }),
      });
      const data = await res.json() as any;
      return {
        success: res.ok,
        results: data?.results?.map((r: any) => ({
          id: r.id, type: r.object,
          title: r.properties?.title?.title?.[0]?.text?.content || r.properties?.Name?.title?.[0]?.text?.content || 'Untitled',
        })),
      };
    }
    case 'create_page': {
      const { parentId, title, content } = params || {};
      if (!parentId || !title) return { success: false, error: 'Need parentId, title' };
      const res = await fetch(`${base}/pages`, {
        method: 'POST', headers,
        body: JSON.stringify({
          parent: { database_id: parentId },
          properties: { Name: { title: [{ text: { content: title } }] } },
          children: content ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content } }] } }] : [],
        }),
      });
      const data = await res.json() as any;
      return { success: res.ok, pageId: data.id, url: data.url };
    }
    default:
      return { success: false, error: `Unknown Notion action: ${action}` };
  }
}

// ── Google Calendar ──────────────────────────────────────────
async function handleGoogleCalendar(action: string, params: any): Promise<any> {
  let token = await GoogleAuthProvider.getValidAccessToken();
  if (!token) {
    console.log('No valid Google token found. Initiating OAuth flow...');
    token = await GoogleAuthProvider.authorize();
  }
  if (!token) return { success: false, error: 'Failed to authenticate with Google' };

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://www.googleapis.com/calendar/v3';

  switch (action) {
    case 'list_events':
    case 'today':
    case 'upcoming': {
      const now = new Date().toISOString();
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59);
      const res = await fetch(
        `${base}/calendars/primary/events?timeMin=${now}&timeMax=${endOfDay.toISOString()}&maxResults=10&singleEvents=true&orderBy=startTime`,
        { headers }
      );
      const data = await res.json() as any;
      return {
        success: res.ok,
        events: data?.items?.map((e: any) => ({
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
        })),
      };
    }
    case 'create_event': {
      const { summary, startTime, endTime, description } = params || {};
      if (!summary || !startTime) return { success: false, error: 'Need summary, startTime' };
      const res = await fetch(`${base}/calendars/primary/events`, {
        method: 'POST', headers,
        body: JSON.stringify({
          summary,
          description: description || '',
          start: { dateTime: startTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          end: { dateTime: endTime || startTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        }),
      });
      const data = await res.json() as any;
      return { success: res.ok, eventId: data.id, htmlLink: data.htmlLink };
    }
    default:
      return { success: false, error: `Unknown Calendar action: ${action}` };
  }
}

// ── Supabase ─────────────────────────────────────────────────
async function handleSupabase(action: string, params: any): Promise<any> {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) return { success: false, error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY not configured' };

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  switch (action) {
    case 'query': {
      const { table, select, filter } = params || {};
      if (!table) return { success: false, error: 'Need table' };
      let queryUrl = `${url}/rest/v1/${table}?select=${select || '*'}`;
      if (filter) queryUrl += `&${filter}`;
      const res = await fetch(queryUrl, { headers });
      const data = await res.json();
      return { success: res.ok, data, count: Array.isArray(data) ? data.length : 0 };
    }
    case 'insert': {
      const { table, data } = params || {};
      if (!table || !data) return { success: false, error: 'Need table, data' };
      const res = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      return { success: res.ok, data: result };
    }
    case 'check_logs':
    case 'status': {
      // Simple health check
      const res = await fetch(`${url}/rest/v1/`, { headers });
      return { success: res.ok, status: res.status };
    }
    default:
      return { success: false, error: `Unknown Supabase action: ${action}` };
  }
}

// ── YouTube (via YouTube Data API v3, with no-key browser fallback) ────────────────────────
async function handleYouTube(action: string, params: any): Promise<any> {
  const key = process.env.YOUTUBE_API_KEY || '';
  const hasKey = !!key;
  const base = 'https://www.googleapis.com/youtube/v3';

  /** Open a URL in the user's default browser, falling back to common browsers. */
  async function openUrl(url: string): Promise<{ success: boolean; openedIn?: string; error?: string }> {
    console.log(`[YouTube] opening URL: ${url}`);

    if (!url || !url.startsWith('http')) {
      return { success: false, error: `Invalid URL: ${url}` };
    }

    // Primary: Windows cmd `start` is the most reliable way to open a URL in the default browser.
    try {
      await execAsync(`cmd /c start "" "${url}"`, { maxBuffer: 1024 * 1024, timeout: 10_000 });
      return { success: true, openedIn: 'default browser' };
    } catch (err: any) {
      console.log(`[YouTube] cmd start failed: ${err.message}`);
    }

    // Fallbacks: try common browsers via PowerShell.
    const browsers = [
      { name: 'chrome', exe: 'chrome' },
      { name: 'msedge', exe: 'msedge' },
      { name: 'firefox', exe: 'firefox' },
      { name: 'brave', exe: 'brave' },
    ];

    for (const browser of browsers) {
      const ps = `Start-Process '${browser.exe}' -ArgumentList '${url}'`;
      try {
        await execAsync(
          `powershell -NoProfile -NonInteractive -Command "${ps}"`,
          { maxBuffer: 1024 * 1024, timeout: 10_000 }
        );
        return { success: true, openedIn: browser.name };
      } catch (err: any) {
        console.log(`[YouTube] ${browser.name} open failed: ${err.message}`);
      }
    }

    return { success: false, error: 'Could not open any browser' };
  }

  /** Resolve a channelId, handle, name, or URL into a channelId string (API only). */
  async function resolveChannelId(input: string): Promise<string | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // Already a channel ID.
    if (/^UC[_A-Za-z0-9\-]{22}$/.test(trimmed)) return trimmed;

    // Extract from youtube.com/channel/UC...
    const channelUrlMatch = trimmed.match(/youtube\.com\/channel\/(UC[_A-Za-z0-9\-]{22})/i);
    if (channelUrlMatch) return channelUrlMatch[1];

    // Extract handle from @handle, youtube.com/@handle, or youtube.com/c/handle.
    const handleMatch = trimmed.match(/(?:youtube\.com\/(?:@|c\/)|@)([A-Za-z0-9_\-.]+)/i);
    const handle = handleMatch ? handleMatch[1] : null;

    const searchQuery = handle || trimmed;
    console.log(`[YouTube] resolving channel from: ${searchQuery}`);

    const res = await fetch(
      `${base}/search?part=snippet&type=channel&q=${encodeURIComponent(searchQuery)}&maxResults=1&key=${key}`
    );
    const data = await res.json() as any;
    if (!res.ok) {
      console.log(`[YouTube] channel search error: ${data?.error?.message || res.statusText}`);
      return null;
    }
    const channelId = data?.items?.[0]?.id?.channelId || null;
    if (channelId) console.log(`[YouTube] resolved channelId: ${channelId}`);
    return channelId;
  }

  /** Build a browser URL for a channel/handle/name without using the API. */
  function channelPageUrl(input: string, suffix: string = '/videos'): string {
    const trimmed = input.trim();
    if (!trimmed) return 'https://www.youtube.com';
    if (trimmed.startsWith('@')) return `https://www.youtube.com/${trimmed}${suffix}`;
    if (/^UC[_A-Za-z0-9\-]{22}$/.test(trimmed)) return `https://www.youtube.com/channel/${trimmed}${suffix}`;

    const handleMatch = trimmed.match(/youtube\.com\/@([A-Za-z0-9_\-.]+)/i);
    if (handleMatch) return `https://www.youtube.com/@${handleMatch[1]}${suffix}`;
    const channelUrlMatch = trimmed.match(/youtube\.com\/channel\/(UC[_A-Za-z0-9\-]{22})/i);
    if (channelUrlMatch) return `https://www.youtube.com/channel/${channelUrlMatch[1]}${suffix}`;

    // For single-token names like "MKBHD", guess the handle first.
    const handleGuess = trimmed.replace(/\s+/g, '');
    if (/^[A-Za-z0-9_\-.]+$/.test(handleGuess)) {
      return `https://www.youtube.com/@${handleGuess}${suffix}`;
    }

    return `https://www.youtube.com/results?search_query=${encodeURIComponent(trimmed + ' channel')}`;
  }

  switch (action) {
    case 'play': {
      let videoId = params?.videoId || params?.id || '';
      let title = '';
      let channelId = params?.channelId || params?.channel || '';
      const q = params?.query || params?.q || '';
      console.log(`[YouTube] play called with params:`, { videoId, channelId, query: q });

      if (!hasKey) {
        console.log('[YouTube] no API key — using browser fallback');
        let url: string;
        if (videoId) {
          url = `https://www.youtube.com/watch?v=${videoId}`;
        } else if (channelId) {
          url = channelPageUrl(channelId, '/videos');
        } else if (q && q.toLowerCase() !== 'youtube') {
          url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        } else {
          url = 'https://www.youtube.com';
        }
        const opened = await openUrl(url);
        if (!opened.success) return { success: false, error: opened.error };
        return { success: true, url, openedIn: opened.openedIn, fallback: true, note: 'Set YOUTUBE_API_KEY for autoplay of specific videos' };
      }

      if (!videoId && channelId) {
        const resolved = await resolveChannelId(channelId);
        if (!resolved) return { success: false, error: `Could not resolve channel: ${channelId}` };
        channelId = resolved;

        const channelRes = await fetch(
          `${base}/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${key}`
        );
        const channelData = await channelRes.json() as any;
        if (!channelRes.ok) {
          return { success: false, error: channelData?.error?.message || 'YouTube channel lookup failed' };
        }
        const uploadsPlaylistId = channelData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsPlaylistId) return { success: false, error: 'Could not find uploads playlist for channel' };

        const videosRes = await fetch(
          `${base}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=1&key=${key}`
        );
        const videosData = await videosRes.json() as any;
        if (!videosRes.ok) {
          return { success: false, error: videosData?.error?.message || 'YouTube playlist lookup failed' };
        }
        const latest = videosData?.items?.[0];
        if (!latest) return { success: false, error: 'No videos found on channel' };
        videoId = latest.snippet?.resourceId?.videoId;
        title = latest.snippet?.title;
        console.log(`[YouTube] latest video from channel: ${title} (${videoId})`);
      }

      if (!videoId) {
        if (!q) return { success: false, error: 'Need videoId, query, or channelId' };
        const searchRes = await fetch(
          `${base}/search?part=snippet&type=video&q=${encodeURIComponent(q)}&maxResults=1&key=${key}`
        );
        const searchData = await searchRes.json() as any;
        if (!searchRes.ok) {
          return { success: false, error: searchData?.error?.message || 'YouTube search failed' };
        }
        const item = searchData?.items?.[0];
        if (!item) return { success: false, error: 'No videos found for query' };
        videoId = item.id?.videoId;
        title = item.snippet?.title;
        console.log(`[YouTube] search result: ${title} (${videoId})`);
      }

      if (!videoId || typeof videoId !== 'string') {
        return { success: false, error: 'Could not determine a videoId to play' };
      }

      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const opened = await openUrl(url);
      if (!opened.success) return { success: false, error: opened.error };
      return { success: true, videoId, title, url, openedIn: opened.openedIn };
    }
    case 'search': {
      const q = params?.query || params?.q || '';
      if (!hasKey) {
        const url = q
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
          : 'https://www.youtube.com';
        const opened = await openUrl(url);
        if (!opened.success) return { success: false, error: opened.error };
        return { success: true, url, openedIn: opened.openedIn, fallback: true };
      }
      const maxResults = params?.limit || 5;
      const res = await fetch(
        `${base}/search?part=snippet&type=video&q=${encodeURIComponent(q)}&maxResults=${maxResults}&key=${key}`
      );
      const data = await res.json() as any;
      if (!res.ok) return { success: false, error: data?.error?.message || 'YouTube search failed' };
      return {
        success: true,
        videos: data?.items?.map((item: any) => ({
          title: item.snippet?.title,
          channel: item.snippet?.channelTitle,
          videoId: item.id?.videoId,
          url: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
          description: item.snippet?.description?.slice(0, 150),
        })),
      };
    }
    case 'trending': {
      if (!hasKey) {
        const opened = await openUrl('https://www.youtube.com/feed/trending');
        if (!opened.success) return { success: false, error: opened.error };
        return { success: true, url: 'https://www.youtube.com/feed/trending', openedIn: opened.openedIn, fallback: true };
      }
      const res = await fetch(
        `${base}/videos?part=snippet,statistics&chart=mostPopular&maxResults=10&key=${key}`
      );
      const data = await res.json() as any;
      if (!res.ok) return { success: false, error: data?.error?.message || 'YouTube trending failed' };
      return {
        success: true,
        videos: data?.items?.map((item: any) => ({
          title: item.snippet?.title,
          channel: item.snippet?.channelTitle,
          videoId: item.id,
          views: item.statistics?.viewCount,
          url: `https://www.youtube.com/watch?v=${item.id}`,
        })),
      };
    }
    case 'video_info': {
      const videoId = params?.videoId || params?.id || '';
      if (!videoId) return { success: false, error: 'Need videoId' };
      if (!hasKey) {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const opened = await openUrl(url);
        if (!opened.success) return { success: false, error: opened.error };
        return { success: true, url, openedIn: opened.openedIn, fallback: true };
      }
      const res = await fetch(
        `${base}/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${key}`
      );
      const data = await res.json() as any;
      if (!res.ok) return { success: false, error: data?.error?.message || 'YouTube video info failed' };
      const item = data?.items?.[0];
      if (!item) return { success: false, error: 'Video not found' };
      return {
        success: true,
        title: item.snippet?.title,
        channel: item.snippet?.channelTitle,
        views: item.statistics?.viewCount,
        likes: item.statistics?.likeCount,
        duration: item.contentDetails?.duration,
        description: item.snippet?.description?.slice(0, 300),
      };
    }
    case 'channel_search': {
      const q = params?.query || params?.channel || '';
      if (!hasKey) {
        const url = q
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' channel')}`
          : 'https://www.youtube.com';
        const opened = await openUrl(url);
        if (!opened.success) return { success: false, error: opened.error };
        return { success: true, url, openedIn: opened.openedIn, fallback: true };
      }
      const res = await fetch(
        `${base}/search?part=snippet&type=channel&q=${encodeURIComponent(q)}&maxResults=5&key=${key}`
      );
      const data = await res.json() as any;
      if (!res.ok) return { success: false, error: data?.error?.message || 'YouTube channel search failed' };
      return {
        success: true,
        channels: data?.items?.map((item: any) => ({
          name: item.snippet?.title,
          channelId: item.id?.channelId,
          description: item.snippet?.description?.slice(0, 150),
        })),
      };
    }
    case 'channel_videos': {
      let channelId = params?.channelId || params?.channel || '';
      console.log(`[YouTube] channel_videos called with:`, { channelId, limit: params?.limit || params?.maxResults });
      if (!channelId) return { success: false, error: 'Need channelId or channel name' };

      if (!hasKey) {
        const url = channelPageUrl(channelId, '/videos');
        const opened = await openUrl(url);
        if (!opened.success) return { success: false, error: opened.error };
        return { success: true, url, openedIn: opened.openedIn, fallback: true };
      }

      const resolved = await resolveChannelId(channelId);
      if (!resolved) return { success: false, error: `Could not resolve channel: ${channelId}` };
      channelId = resolved;

      const channelRes = await fetch(
        `${base}/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${key}`
      );
      const channelData = await channelRes.json() as any;
      if (!channelRes.ok) return { success: false, error: channelData?.error?.message || 'YouTube channel lookup failed' };

      const uploadsPlaylistId = channelData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadsPlaylistId) return { success: false, error: 'Could not find uploads playlist for channel' };

      const maxResults = params?.limit || params?.maxResults || 10;
      const videosRes = await fetch(
        `${base}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${key}`
      );
      const videosData = await videosRes.json() as any;
      if (!videosRes.ok) return { success: false, error: videosData?.error?.message || 'YouTube channel videos failed' };

      const videos = videosData?.items?.map((item: any) => ({
        title: item.snippet?.title,
        videoId: item.snippet?.resourceId?.videoId,
        url: `https://www.youtube.com/watch?v=${item.snippet?.resourceId?.videoId}`,
        publishedAt: item.snippet?.publishedAt,
        description: item.snippet?.description?.slice(0, 150),
      })) || [];
      console.log(`[YouTube] channel_videos returned ${videos.length} videos`);

      return { success: true, channelId, videos };
    }
    default:
      return { success: false, error: `Unknown YouTube action: ${action}` };
  }
}

// ── Todoist (via REST API v2) ────────────────────────────────
async function handleTodoist(action: string, params: any): Promise<any> {
  const token = process.env.TODOIST_API_TOKEN || '';
  if (!token) return { success: false, error: 'TODOIST_API_TOKEN not configured' };

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://api.todoist.com/rest/v2';

  switch (action) {
    case 'list_tasks':
    case 'tasks': {
      const filter = params?.filter || '';
      const url = filter ? `${base}/tasks?filter=${encodeURIComponent(filter)}` : `${base}/tasks`;
      const res = await fetch(url, { headers });
      const data = await res.json() as any[];
      return {
        success: res.ok,
        tasks: data.map((t: any) => ({
          id: t.id, content: t.content, priority: t.priority,
          project: t.project_id, due: t.due?.string,
        })),
      };
    }
    case 'create_task': {
      const { content, project_id, due_string, priority, description } = params || {};
      if (!content) return { success: false, error: 'Need content' };
      const body: any = { content };
      if (project_id) body.project_id = project_id;
      if (due_string) body.due_string = due_string;
      if (priority) body.priority = priority;
      if (description) body.description = description;
      const res = await fetch(`${base}/tasks`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const data = await res.json() as any;
      return { success: res.ok, taskId: data.id, content: data.content, url: data.url };
    }
    case 'complete_task': {
      const { taskId } = params || {};
      if (!taskId) return { success: false, error: 'Need taskId' };
      const res = await fetch(`${base}/tasks/${taskId}/close`, { method: 'POST', headers });
      return { success: res.ok };
    }
    case 'list_projects':
    case 'projects': {
      const res = await fetch(`${base}/projects`, { headers });
      const data = await res.json() as any[];
      return {
        success: res.ok,
        projects: data.map((p: any) => ({ id: p.id, name: p.name, color: p.color })),
      };
    }
    case 'delete_task': {
      const { taskId } = params || {};
      if (!taskId) return { success: false, error: 'Need taskId' };
      const res = await fetch(`${base}/tasks/${taskId}`, { method: 'DELETE', headers });
      return { success: res.ok };
    }
    default:
      return { success: false, error: `Unknown Todoist action: ${action}` };
  }
}

// ── Linear (via GraphQL API) ─────────────────────────────────
async function handleLinear(action: string, params: any): Promise<any> {
  const token = process.env.LINEAR_API_KEY || '';
  if (!token) return { success: false, error: 'LINEAR_API_KEY not configured' };

  const headers = {
    'Authorization': token,
    'Content-Type': 'application/json',
  };
  const endpoint = 'https://api.linear.app/graphql';

  async function gql(query: string, variables?: any) {
    const res = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ query, variables }),
    });
    return res.json() as any;
  }

  switch (action) {
    case 'list_issues':
    case 'issues': {
      const teamId = params?.teamId;
      const filter = teamId ? `filter: { team: { id: { eq: "${teamId}" } } }` : '';
      const data = await gql(`query { issues(first: 15 ${filter}) { nodes { id title state { name } priority assignee { name } url } } }`);
      return {
        success: true,
        issues: data?.data?.issues?.nodes?.map((i: any) => ({
          id: i.id, title: i.title, state: i.state?.name,
          priority: i.priority, assignee: i.assignee?.name, url: i.url,
        })),
      };
    }
    case 'create_issue': {
      const { teamId, title, description, priority } = params || {};
      if (!teamId || !title) return { success: false, error: 'Need teamId, title' };
      const data = await gql(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id title url } } }`,
        { input: { teamId, title, description: description || '', priority: priority || 0 } }
      );
      const issue = data?.data?.issueCreate?.issue;
      return { success: data?.data?.issueCreate?.success, issueId: issue?.id, title: issue?.title, url: issue?.url };
    }
    case 'list_teams':
    case 'teams': {
      const data = await gql(`query { teams { nodes { id name key } } }`);
      return {
        success: true,
        teams: data?.data?.teams?.nodes?.map((t: any) => ({ id: t.id, name: t.name, key: t.key })),
      };
    }
    case 'my_issues': {
      const data = await gql(`query { viewer { assignedIssues(first: 15) { nodes { id title state { name } url } } } }`);
      return {
        success: true,
        issues: data?.data?.viewer?.assignedIssues?.nodes?.map((i: any) => ({
          id: i.id, title: i.title, state: i.state?.name, url: i.url,
        })),
      };
    }
    default:
      return { success: false, error: `Unknown Linear action: ${action}` };
  }
}


// ── Google Drive (via Google API) ────────────────────────────
async function handleGoogleDrive(action: string, params: any): Promise<any> {
  let token = await GoogleAuthProvider.getValidAccessToken();
  if (!token) {
    console.log('No valid Google token found. Initiating OAuth flow...');
    token = await GoogleAuthProvider.authorize();
  }
  if (!token) return { success: false, error: 'Failed to authenticate with Google' };

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://www.googleapis.com/drive/v3';

  switch (action) {
    case 'search': {
      const q = params?.query || params?.q || '';
      const driveQuery = q ? `name contains '${q.replace(/'/g, "\\'")}'` : '';
      const url = `${base}/files?q=${encodeURIComponent(driveQuery)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&pageSize=10&orderBy=modifiedTime desc`;
      const res = await fetch(url, { headers });
      const data = await res.json() as any;
      return {
        success: res.ok,
        files: data?.files?.map((f: any) => ({
          id: f.id, name: f.name, type: f.mimeType,
          modified: f.modifiedTime, url: f.webViewLink,
        })),
      };
    }
    case 'list_recent':
    case 'recent': {
      const res = await fetch(
        `${base}/files?fields=files(id,name,mimeType,modifiedTime,webViewLink)&pageSize=10&orderBy=modifiedTime desc`,
        { headers }
      );
      const data = await res.json() as any;
      return {
        success: res.ok,
        files: data?.files?.map((f: any) => ({
          id: f.id, name: f.name, type: f.mimeType,
          modified: f.modifiedTime, url: f.webViewLink,
        })),
      };
    }
    case 'get_file': {
      const fileId = params?.fileId || params?.id || '';
      if (!fileId) return { success: false, error: 'Need fileId' };
      const res = await fetch(`${base}/files/${fileId}?fields=id,name,mimeType,size,webViewLink,webContentLink`, { headers });
      const data = await res.json() as any;
      return {
        success: res.ok,
        id: data.id, name: data.name, type: data.mimeType,
        size: data.size, viewUrl: data.webViewLink, downloadUrl: data.webContentLink,
      };
    }
    default:
      return { success: false, error: `Unknown Google Drive action: ${action}` };
  }
}

// ── Philips Hue (local bridge API) ───────────────────────────
async function handleHue(action: string, params: any): Promise<any> {
  const bridgeIp = process.env.HUE_BRIDGE_IP || '';
  const username = process.env.HUE_USERNAME || '';
  if (!bridgeIp || !username) return { success: false, error: 'HUE_BRIDGE_IP and HUE_USERNAME not configured' };

  const base = `http://${bridgeIp}/api/${username}`;

  switch (action) {
    case 'list_lights':
    case 'lights': {
      const res = await fetch(`${base}/lights`);
      const data = await res.json() as any;
      const lights = Object.entries(data).map(([id, light]: [string, any]) => ({
        id, name: light.name, on: light.state?.on,
        brightness: light.state?.bri, color: light.state?.xy,
      }));
      return { success: true, lights };
    }
    case 'set_light': {
      const { lightId, on, brightness, color_temp } = params || {};
      if (!lightId) return { success: false, error: 'Need lightId' };
      const state: any = {};
      if (on !== undefined) state.on = on;
      if (brightness !== undefined) state.bri = Math.min(254, Math.max(1, brightness));
      if (color_temp !== undefined) state.ct = color_temp;
      const res = await fetch(`${base}/lights/${lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      return { success: res.ok, result: await res.json() };
    }
    case 'list_groups':
    case 'rooms': {
      const res = await fetch(`${base}/groups`);
      const data = await res.json() as any;
      const groups = Object.entries(data).map(([id, group]: [string, any]) => ({
        id, name: group.name, type: group.type, on: group.state?.all_on,
      }));
      return { success: true, groups };
    }
    case 'set_group': {
      const { groupId, on, brightness } = params || {};
      if (!groupId) return { success: false, error: 'Need groupId' };
      const state: any = {};
      if (on !== undefined) state.on = on;
      if (brightness !== undefined) state.bri = Math.min(254, Math.max(1, brightness));
      const res = await fetch(`${base}/groups/${groupId}/action`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      return { success: res.ok, result: await res.json() };
    }
    default:
      return { success: false, error: `Unknown Hue action: ${action}` };
  }
}

// ── VS Code / Cursor (via shell) ────────────────────────────
async function handleEditor(service: string, action: string, params: any): Promise<any> {
  const cmd = service === 'cursor' ? 'cursor' : 'code';

  switch (action) {
    case 'open': {
      const target = params?.path || params?.file || '.';
      const output = await runPS(`Start-Process '${cmd}' -ArgumentList '${target}'`);
      return { success: true, output };
    }
    case 'open_file': {
      const file = params?.file || params?.path || '';
      const output = await runPS(`& ${cmd} '${file}'`);
      return { success: true, output };
    }
    case 'install_extension': {
      const ext = params?.extension || params?.id || '';
      const output = await runPS(`& ${cmd} --install-extension '${ext}'`);
      return { success: true, output };
    }
    default:
      return { success: false, error: `Unknown ${service} action: ${action}` };
  }
}

// ── Docker (via shell) ───────────────────────────────────────
async function handleDocker(action: string, params: any): Promise<any> {
  switch (action) {
    case 'ps':
    case 'list': {
      const output = await runPS('docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"');
      return { success: true, output };
    }
    case 'start': {
      const name = params?.container || params?.name || '';
      const output = await runPS(`docker start '${name}'`);
      return { success: true, output };
    }
    case 'stop': {
      const name = params?.container || params?.name || '';
      const output = await runPS(`docker stop '${name}'`);
      return { success: true, output };
    }
    case 'logs': {
      const name = params?.container || params?.name || '';
      const tail = params?.tail || 50;
      const output = await runPS(`docker logs --tail ${tail} '${name}'`);
      return { success: true, output };
    }
    case 'compose_up': {
      const file = params?.file ? `-f '${params.file}'` : '';
      const output = await runPS(`docker compose ${file} up -d`);
      return { success: true, output };
    }
    case 'compose_down': {
      const file = params?.file ? `-f '${params.file}'` : '';
      const output = await runPS(`docker compose ${file} down`);
      return { success: true, output };
    }
    default:
      return { success: false, error: `Unknown Docker action: ${action}` };
  }
}

// ── Vercel (via CLI) ─────────────────────────────────────────
async function handleVercel(action: string, params: any): Promise<any> {
  const token = process.env.VERCEL_TOKEN || '';

  switch (action) {
    case 'list_deployments':
    case 'deployments': {
      if (!token) return { success: false, error: 'VERCEL_TOKEN not configured' };
      const res = await fetch('https://api.vercel.com/v6/deployments?limit=5', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json() as any;
      return {
        success: res.ok,
        deployments: data?.deployments?.map((d: any) => ({
          name: d.name, url: d.url, state: d.state, created: d.created,
        })),
      };
    }
    case 'deploy': {
      const output = await runPS(`vercel --yes --token '${token}' 2>&1`);
      return { success: true, output };
    }
    default:
      return { success: false, error: `Unknown Vercel action: ${action}` };
  }
}

// ════════════════════════════════════════════════════════════════
//  Main Tool Export
// ════════════════════════════════════════════════════════════════

export const appsTool = tool({
  description: `**Apps & Services Tool** — Primary tool for controlling specific applications and cloud/SaaS services.

This is ONE OF THE TWO MOST IMPORTANT TOOLS (together with Windows Tool).

Supported services:
- **Music**: spotify (play, pause, next, previous, current, search, set_volume, devices, transfer_playback). For \`play\`, pass either a Spotify \`uri\` (e.g. \`spotify:track:xxx\`), a \`context_uri\` (album/playlist), or a plain text \`query\`/\`track\`/\`song\` and the tool will search and play the first match. For \`set_volume\`, pass \`volume_percent\` (0-100).
- **Communication**: gmail (inbox, read_message, send_message with optional \`attachments: [{ path, filename, mimeType }]\`), slack (send_message, list_channels, read_messages). For Slack \`send_message\` and \`read_messages\`, pass a channel NAME (e.g. \`general\`) or channel ID; the tool resolves names automatically. If no channel is given, it lists available channels.
- **Developer**: github (list_repos, create_issue, list_issues, search_repo, get_notifications), supabase (query, insert, status), vercel (deployments, deploy), docker (ps, start, stop, logs, compose_up, compose_down), linear (list_issues, create_issue, list_teams, my_issues)
- **Productivity**: notion (search, create_page), google_calendar (upcoming, create_event), todoist (list_tasks, create_task, complete_task, list_projects, delete_task), google_drive (search, list_recent, get_file)
- **Media**: youtube (play with videoId/query/channelId, search, trending, video_info, channel_search, channel_videos). For channel-specific requests, use play with { channelId: "..." }.
- **Smart Home**: philips_hue (list_lights, set_light, list_groups, set_group)
- **Editors**: vscode / cursor (open, open_file, install_extension)

**GOLDEN RULE**: Strongly prefer API calls → MCP servers → Native integrations. Use browser automation only as fallback.

Never fall back to Computer Use if this tool can handle the request.`,
  inputSchema: jsonSchema<{
    service: string;
    action: string;
    parameters?: any;
    reason?: string;
  }>({
    type: 'object',
    properties: {
      service: {
        description: 'The target app or service (spotify, github, supabase, gmail, slack, discord, notion, google_calendar, vscode, cursor, docker, vercel, youtube, todoist, linear, google_drive, philips_hue)',
        type: 'string',
      },
      action: {
        description: 'Specific action to perform on the service',
        type: 'string',
      },
      parameters: {
        description: 'Parameters needed for the action',
        type: 'object',
      },
      reason: {
        description: 'One sentence explanation why this tool is being used.',
        type: 'string'
      },
    },
    required: ['service', 'action'],
  }),
  execute: async ({ service, action, parameters, reason }) => {
    console.log(`🛠️ Tool: apps.${service}.${action} — ${reason || 'no reason'}`);

    try {
      const svc = service.toLowerCase().replace(/\s+/g, '_');

      switch (svc) {
        case 'spotify':
          return await handleSpotify(action, parameters);
        case 'github':
          return await handleGitHub(action, parameters);
        case 'gmail':
          return await handleGmail(action, parameters);
        case 'slack':
          return await handleSlack(action, parameters);
        case 'discord':
          return await handleDiscord(action, parameters);
        case 'notion':
          return await handleNotion(action, parameters);
        case 'google_calendar':
        case 'calendar':
          return await handleGoogleCalendar(action, parameters);
        case 'supabase':
          return await handleSupabase(action, parameters);
        case 'vscode':
        case 'vs_code':
        case 'cursor':
          return await handleEditor(svc === 'cursor' ? 'cursor' : 'vscode', action, parameters);
        case 'docker':
          return await handleDocker(action, parameters);
        case 'vercel':
          return await handleVercel(action, parameters);
        case 'youtube':
          return await handleYouTube(action, parameters);
        case 'todoist':
          return await handleTodoist(action, parameters);
        case 'linear':
          return await handleLinear(action, parameters);
        case 'google_drive':
        case 'gdrive':
          return await handleGoogleDrive(action, parameters);
        case 'philips_hue':
        case 'hue':
          return await handleHue(action, parameters);
        default:
          return {
            success: false,
            service: svc,
            action,
            error: `Service "${svc}" is not yet integrated. Available: spotify, github, gmail, slack, discord, notion, google_calendar, supabase, vscode, cursor, docker, vercel, youtube, todoist, linear, google_drive, philips_hue`,
          };
      }
    } catch (error: any) {
      console.error(`[Apps Tool] ${service}.${action} failed:`, error.message);
      return {
        success: false,
        service,
        action,
        error: error.message,
      };
    }
  },
});
