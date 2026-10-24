import { BrowserWindow, session } from 'electron';
import http from 'http';
import crypto from 'crypto';
import { AppStore } from './store';
import { NetatmoClient } from './netatmoClient';
import { AccountInfo, StoredCookie } from '../renderer/types';

export const NETATMO_PARTITION = 'persist:netatmo';

export class WebAuthManager {
  private store: AppStore;
  private client: NetatmoClient;
  private currentAuthWindow: BrowserWindow | null = null;

  constructor(store: AppStore, client: NetatmoClient) {
    this.store = store;
    this.client = client;
  }

  /**
   * Opens the official Netatmo Web Login in a native BrowserWindow and captures
   * the session token (`netatmocomaccess_token` cookie or Bearer header) automatically.
   */
  public async startWebLogin(
    parentWindow?: BrowserWindow
  ): Promise<{ success: boolean; account?: AccountInfo; error?: string }> {
    if (this.currentAuthWindow) {
      this.currentAuthWindow.focus();
      return { success: false, error: 'Login window is already open' };
    }

    const loginUrl =
      'https://auth.netatmo.com/checklogin?next_url=' +
      encodeURIComponent('https://home.netatmo.com/');

    return new Promise((resolve) => {
      let resolved = false;
      let interceptedBearerToken: string | null = null;

      const netatmoSession = session.fromPartition(NETATMO_PARTITION);

      const authWin = new BrowserWindow({
        width: 1060,
        height: 800,
        parent: parentWindow || undefined,
        modal: false,
        title: 'Sign in to Netatmo Account',
        backgroundColor: '#0f172a',
        autoHideMenuBar: true,
        webPreferences: {
          partition: NETATMO_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      this.currentAuthWindow = authWin;

      // Listen for Authorization: Bearer <token> headers sent by home.netatmo.com / settings.netatmo.com
      netatmoSession.webRequest.onBeforeSendHeaders(
        {
          urls: [
            'https://*.netatmo.net/*',
            'https://*.netatmo.com/*',
          ],
        },
        (details, callback) => {
          const authHeader =
            details.requestHeaders['Authorization'] ||
            details.requestHeaders['authorization'];
          if (authHeader && authHeader.startsWith('Bearer ')) {
            const candidate = authHeader.slice(7).trim();
            if (candidate && candidate.length > 15 && candidate !== 'undefined' && candidate !== 'null') {
              interceptedBearerToken = candidate;
            }
          }
          callback({ requestHeaders: details.requestHeaders });
        }
      );

      const finishSuccess = async (account: AccountInfo) => {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        try {
          authWin.close();
        } catch {}
        this.currentAuthWindow = null;
        resolve({ success: true, account });
      };

      const checkAuthStatus = async (): Promise<boolean> => {
        if (resolved || !this.currentAuthWindow || authWin.isDestroyed()) {
          return true;
        }

        try {
          const allCookies = await netatmoSession.cookies.get({});
          const netatmoCookies = allCookies.filter(
            (c) =>
              (c.domain ?? '').includes('netatmo.com') ||
              (c.domain ?? '').includes('netatmo.net')
          );

          const tokenCookie = netatmoCookies.find(
            (c) =>
              c.name === 'netatmocomaccess_token' ||
              c.name === 'access_token'
          );
          const refreshCookie = netatmoCookies.find(
            (c) =>
              c.name === 'netatmocomrefresh_token' ||
              c.name === 'refresh_token'
          );

          const rawToken = tokenCookie?.value
            ? decodeURIComponent(tokenCookie.value)
            : interceptedBearerToken;

          if (!rawToken || rawToken.length < 15) {
            return false;
          }

          const storedCookies: StoredCookie[] = netatmoCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '.netatmo.com',
            path: c.path || '/',
            secure: c.secure,
            httpOnly: c.httpOnly,
          }));

          // Verify token with Netatmo API
          const verifyResult = await this.client.verifyAndSaveWebToken(
            rawToken,
            refreshCookie?.value
              ? decodeURIComponent(refreshCookie.value)
              : undefined,
            storedCookies
          );

          if (verifyResult.valid && verifyResult.account) {
            await finishSuccess(verifyResult.account);
            return true;
          }
        } catch {
          // Ignore transient errors while user is still typing credentials
        }
        return false;
      };

      const interval = setInterval(() => {
        checkAuthStatus();
      }, 1500);

      const injectHelperUI = async () => {
        if (authWin.isDestroyed()) return;
        try {
          await authWin.webContents.executeJavaScript(`
            (() => {
              if (document.getElementById('winatmo-auth-helper')) return;
              const banner = document.createElement('div');
              banner.id = 'winatmo-auth-helper';
              banner.innerHTML = \`
                <div style="position:fixed; bottom:16px; right:16px; z-index:2147483647; background:linear-gradient(135deg, #0284c7, #2563eb); color:#ffffff; padding:10px 16px; border-radius:10px; font-family:'Segoe UI', -apple-system, sans-serif; font-size:13px; font-weight:600; box-shadow:0 8px 24px rgba(0,0,0,0.45); display:flex; align-items:center; gap:8px; cursor:pointer; border:1px solid rgba(255,255,255,0.25);">
                  <span>Sign in with your Netatmo account — winAtmo will connect automatically</span>
                </div>
              \`;
              document.body.appendChild(banner);
            })();
          `);
        } catch {}
      };

      authWin.webContents.on('did-finish-load', () => {
        injectHelperUI();
        checkAuthStatus();
      });

      authWin.webContents.on('did-navigate', () => {
        injectHelperUI();
        checkAuthStatus();
      });

      authWin.on('closed', async () => {
        clearInterval(interval);
        this.currentAuthWindow = null;

        if (!resolved) {
          const finalOk = await checkAuthStatus();
          if (!finalOk) {
            resolved = true;
            resolve({
              success: false,
              error: 'Login window was closed before authentication completed.',
            });
          }
        }
      });

      authWin.loadURL(loginUrl);
    });
  }

  /**
   * Silently refreshes the Netatmo web access token in the background using the persisted
   * Chromium session on `auth.netatmo.com`.
   */
  public async silentWebRefresh(): Promise<string | null> {
    return new Promise((resolve) => {
      let finished = false;
      const netatmoSession = session.fromPartition(NETATMO_PARTITION);

      const hiddenWin = new BrowserWindow({
        width: 400,
        height: 300,
        show: false,
        webPreferences: {
          partition: NETATMO_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      const done = (token: string | null) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        clearTimeout(timeout);
        try {
          hiddenWin.destroy();
        } catch {}
        resolve(token);
      };

      const checkCookie = async () => {
        try {
          const cookies = await netatmoSession.cookies.get({});
          const tokenCookie = cookies.find(
            (c) => c.name === 'netatmocomaccess_token'
          );
          if (tokenCookie?.value) {
            const token = decodeURIComponent(tokenCookie.value);
            const currentToken = this.store.getSession().accessToken;
            if (token && token.length > 15 && token !== currentToken) {
              this.store.updateSession({
                accessToken: token,
                expiresAt: Math.floor(Date.now() / 1000) + 10800,
              });
              done(token);
              return;
            }
          }
        } catch {}
      };

      const timer = setInterval(checkCookie, 1000);
      const timeout = setTimeout(() => done(null), 12000);

      hiddenWin.webContents.on('did-finish-load', checkCookie);
      hiddenWin.loadURL(
        'https://auth.netatmo.com/checklogin?next_url=' +
          encodeURIComponent('https://home.netatmo.com/')
      );
    });
  }

  /**
   * Official Netatmo Connect OAuth 2.0 Authorization Code Grant flow
   * (https://dev.netatmo.com/apidocumentation/oauth)
   */
  public async startOAuthLogin(
    clientId: string,
    clientSecret: string,
    parentWindow?: BrowserWindow
  ): Promise<{ success: boolean; account?: AccountInfo; error?: string }> {
    if (!clientId.trim() || !clientSecret.trim()) {
      return {
        success: false,
        error: 'Client ID and Client Secret are required for OAuth2 login.',
      };
    }

    this.store.updateSettings({
      oauthClientId: clientId.trim(),
      oauthClientSecret: clientSecret.trim(),
    });

    const state = crypto.randomBytes(16).toString('hex');
    const scopes = 'read_station read_homecoach read_thermostat';

    return new Promise((resolve) => {
      let resolved = false;
      let oauthWin: BrowserWindow | null = null;

      const server = http.createServer(async (req, res) => {
        if (!req.url) return;
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        if (urlObj.pathname !== '/oauth/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const returnedState = urlObj.searchParams.get('state');
        const code = urlObj.searchParams.get('code');
        const error = urlObj.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!doctype html>
          <html>
            <body style="background:#0f172a;color:#f8fafc;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
              <div style="text-align:center;padding:32px;background:#1e293b;border-radius:14px;border:1px solid #334155;">
                <h2 style="margin:0 0 8px 0;">${error ? 'Authorization Cancelled' : 'Netatmo Connected!'}</h2>
                <p style="color:#94a3b8;margin:0;">You can close this window and return to winAtmo.</p>
              </div>
            </body>
          </html>
        `);

        const cleanup = () => {
          try {
            oauthWin?.close();
          } catch {}
          try {
            server.close();
          } catch {}
        };

        if (error) {
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve({ success: false, error: `Netatmo OAuth error: ${error}` });
          }
          return;
        }

        if (!code || returnedState !== state) {
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve({
              success: false,
              error: 'Invalid OAuth callback state or missing authorization code.',
            });
          }
          return;
        }

        try {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : 5189;
          const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

          const tokenRes = await fetch('https://api.netatmo.com/oauth2/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: clientId.trim(),
              client_secret: clientSecret.trim(),
              code,
              redirect_uri: redirectUri,
              scope: scopes,
            }).toString(),
          });

          const tokenData = await tokenRes.json();
          if (!tokenRes.ok || !tokenData.access_token) {
            throw new Error(
              tokenData.error_description ||
                tokenData.error ||
                `Token exchange failed (${tokenRes.status})`
            );
          }

          const expiresAt =
            Math.floor(Date.now() / 1000) +
            (Number(tokenData.expires_in) || 10800);

          this.store.updateSession({
            loggedIn: true,
            authMethod: 'oauth',
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt,
            apiBase: 'api.netatmo.com',
          });

          const stations = await this.client.fetchStations();
          this.store.setCachedStations(stations);

          cleanup();
          if (!resolved) {
            resolved = true;
            resolve({
              success: true,
              account: this.store.getAccountInfo(),
            });
          }
        } catch (err: any) {
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve({
              success: false,
              error: err?.message || 'OAuth token exchange failed.',
            });
          }
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 5189;
        const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

        const authUrl =
          `https://api.netatmo.com/oauth2/authorize?` +
          new URLSearchParams({
            client_id: clientId.trim(),
            redirect_uri: redirectUri,
            scope: scopes,
            state,
          }).toString();

        oauthWin = new BrowserWindow({
          width: 980,
          height: 760,
          parent: parentWindow || undefined,
          title: 'Authorize winAtmo on Netatmo Connect',
          backgroundColor: '#0f172a',
          autoHideMenuBar: true,
          webPreferences: {
            partition: NETATMO_PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        oauthWin.on('closed', () => {
          try {
            server.close();
          } catch {}
          if (!resolved) {
            resolved = true;
            resolve({
              success: false,
              error: 'OAuth authorization window was closed.',
            });
          }
        });

        oauthWin.loadURL(authUrl);
      });
    });
  }

  public async clearWebSession(): Promise<void> {
    try {
      const netatmoSession = session.fromPartition(NETATMO_PARTITION);
      await netatmoSession.clearStorageData();
    } catch {}
    this.store.clearSession();
  }
}
