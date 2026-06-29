import http from 'http';
import { RealtimeConfig, REALTIME_DEFAULTS } from './realtimeTypes';

export class RealtimeSDPServer {
  private server: http.Server | null = null;
  private port = 0;
  private config: RealtimeConfig;

  constructor(config: Partial<RealtimeConfig> = {}) {
    this.config = { ...REALTIME_DEFAULTS, ...config };
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/sdp') {
          await this.handleSDPExchange(req, res);
        } else if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200);
          res.end('ok');
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== 'string') {
          this.port = addr.port;
          console.log(`🔌 SDP relay server listening on 127.0.0.1:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to get SDP server address'));
        }
      });

      this.server.on('error', reject);
    });
  }

  getPort(): number {
    return this.port;
  }

  getEndpoint(): string {
    return `http://127.0.0.1:${this.port}/sdp`;
  }

  private async handleSDPExchange(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const offerSDP = body;

        const sessionConfig = JSON.stringify({
          type: 'realtime',
          model: this.config.model,
          reasoning: { effort: 'low' },
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: { type: 'semantic_vad' },
              transcription: { model: 'gpt-4o-transcribe' },
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: this.config.voice || 'cedar',
            },
          },
          instructions: this.config.instructions || '',
          output_modalities: ['audio'],
        });

        const fd = new FormData();
        fd.set('sdp', offerSDP);
        fd.set('session', sessionConfig);

        const apiResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: fd,
        });

        if (!apiResponse.ok) {
          const errorText = await apiResponse.text();
          console.error('⚠️ SDP exchange failed:', apiResponse.status, errorText);
          res.writeHead(apiResponse.status, { 'Content-Type': 'text/plain' });
          res.end(errorText);
          return;
        }

        const answerSDP = await apiResponse.text();
        res.writeHead(200, { 'Content-Type': 'application/sdp' });
        res.end(answerSDP);
      } catch (err: any) {
        console.error('⚠️ SDP exchange error:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log('🔌 SDP relay server stopped');
    }
  }
}
