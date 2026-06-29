import http from 'http';
import { shell } from 'electron';
import fs from 'fs';
import path from 'path';

interface SpotifyTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in ms
}

export class SpotifyAuthProvider {
  private static readonly PORT = 8888;
  private static readonly REDIRECT_URI = `http://127.0.0.1:${SpotifyAuthProvider.PORT}/callback`;
  
  private static getTokensFilePath(): string {
    const userData = process.env.BUD_USER_DATA || process.cwd();
    return path.join(userData, 'spotify_tokens.json');
  }

  private static loadTokens(): SpotifyTokens | null {
    try {
      const p = this.getTokensFilePath();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch (err) {
      console.error('Error reading Spotify tokens:', err);
    }
    return null;
  }

  private static saveTokens(data: any): void {
    try {
      const p = this.getTokensFilePath();
      // data from spotify includes access_token, refresh_token, expires_in
      const existing = this.loadTokens();
      
      const tokens: SpotifyTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || existing?.refresh_token || '',
        expires_at: Date.now() + (data.expires_in * 1000) - 60000, // 1 minute buffer
      };
      
      fs.writeFileSync(p, JSON.stringify(tokens, null, 2));
    } catch (err) {
      console.error('Error saving Spotify tokens:', err);
    }
  }

  /**
   * Retrieves a valid access token. Automatically refreshes if expired.
   * Returns null if no user is authenticated.
   */
  public static async getValidAccessToken(): Promise<string | null> {
    const tokens = this.loadTokens();
    if (!tokens) return null;

    if (Date.now() > tokens.expires_at) {
      console.log('🔄 Spotify token expired, refreshing...');
      return await this.refreshToken(tokens.refresh_token);
    }

    return tokens.access_token;
  }

  private static async refreshToken(refreshToken: string): Promise<string | null> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET');
      return null;
    }

    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    try {
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        })
      });

      const data = await res.json() as any;
      if (!res.ok) {
        console.error('Failed to refresh Spotify token:', data);
        return null;
      }

      this.saveTokens(data);
      return data.access_token;
    } catch (err) {
      console.error('Error during token refresh:', err);
      return null;
    }
  }

  /**
   * Starts the OAuth flow by spinning up a local server and opening the browser.
   */
  public static async authorize(): Promise<string | null> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Cannot authorize: SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET is missing in .env');
    }

    return new Promise((resolve, reject) => {
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
              // Exchange code for token
              const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
              const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${authHeader}`,
                  'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                  grant_type: 'authorization_code',
                  code,
                  redirect_uri: this.REDIRECT_URI
                })
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
              res.end('<h1>Login Successful</h1><p>You can close this tab and return to Bud.</p><script>window.close()</script>');
              
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
        console.log(`🎧 Spotify auth server listening on http://127.0.0.1:${this.PORT}`);
        
        const scopes = [
          'user-modify-playback-state',
          'user-read-playback-state',
          'user-read-currently-playing'
        ].join(' ');
        
        const authUrl = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(this.REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
        
        // Open the default browser
        shell.openExternal(authUrl);
      });
      
      // Safety timeout after 5 minutes
      setTimeout(() => {
        if (server.listening) {
          server.close();
          console.log('Spotify auth server timed out.');
          resolve(null);
        }
      }, 5 * 60 * 1000);
    });
  }
}
