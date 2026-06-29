import http from 'http';
import { shell } from 'electron';
import fs from 'fs';
import path from 'path';

interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export class GoogleAuthProvider {
  private static readonly PORT = 8889;
  private static readonly REDIRECT_URI = `http://127.0.0.1:${GoogleAuthProvider.PORT}/callback`;

  private static getTokensFilePath(): string {
    const userData = process.env.BUD_USER_DATA || process.cwd();
    return path.join(userData, 'google_tokens.json');
  }

  private static loadTokens(): GoogleTokens | null {
    try {
      const p = this.getTokensFilePath();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch (err) {
      console.error('Error reading Google tokens:', err);
    }
    return null;
  }

  private static saveTokens(data: any): void {
    try {
      const p = this.getTokensFilePath();
      const existing = this.loadTokens();

      const tokens: GoogleTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || existing?.refresh_token || '',
        expires_at: Date.now() + (data.expires_in * 1000) - 60000,
      };

      fs.writeFileSync(p, JSON.stringify(tokens, null, 2));
    } catch (err) {
      console.error('Error saving Google tokens:', err);
    }
  }

  public static async getValidAccessToken(): Promise<string | null> {
    const tokens = this.loadTokens();
    if (!tokens) return null;

    if (Date.now() > tokens.expires_at) {
      console.log('Google token expired, refreshing...');
      return await this.refreshToken(tokens.refresh_token);
    }

    return tokens.access_token;
  }

  private static async refreshToken(refreshToken: string): Promise<string | null> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
      return null;
    }

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });

      const data = await res.json() as any;
      if (!res.ok) {
        console.error('Failed to refresh Google token:', data);
        return null;
      }

      this.saveTokens(data);
      return data.access_token;
    } catch (err) {
      console.error('Error during Google token refresh:', err);
      return null;
    }
  }

  public static async authorize(): Promise<string | null> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Cannot authorize: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in .env');
    }

    return new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || '/', `http://127.0.0.1:${this.PORT}`);

          if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`<h1>Auth Failed</h1><p>${error}</p>`);
              server.close();
              return resolve(null);
            }

            if (code) {
              const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  code,
                  client_id: clientId,
                  client_secret: clientSecret,
                  grant_type: 'authorization_code',
                  redirect_uri: this.REDIRECT_URI,
                }),
              });

              const tokenData = await tokenRes.json() as any;

              if (!tokenRes.ok) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<h1>Token Exchange Failed</h1><p>${JSON.stringify(tokenData)}</p>`);
                server.close();
                return resolve(null);
              }

              this.saveTokens(tokenData);

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<h1>Google Login Successful</h1><p>You can close this tab and return to Bud.</p><script>window.close()</script>');

              server.close();
              resolve(tokenData.access_token);
            }
          }
        } catch (err) {
          res.writeHead(500);
          res.end('Internal Server Error');
          server.close();
          resolve(null);
        }
      });

      server.listen(this.PORT, '127.0.0.1', () => {
        console.log(`Google auth server listening on http://127.0.0.1:${this.PORT}`);

        const scopes = [
          'openid',
          'profile',
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/drive.readonly',
        ].join(' ');

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(this.REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;

        shell.openExternal(authUrl);
      });

      setTimeout(() => {
        if (server.listening) {
          server.close();
          console.log('Google auth server timed out.');
          resolve(null);
        }
      }, 5 * 60 * 1000);
    });
  }
}
