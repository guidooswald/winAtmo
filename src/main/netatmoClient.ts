/**
 * @module main/netatmoClient
 * Core Netatmo API client for weather stations, historical backfill/querying,
 * demo simulation, security cameras/events, floodlight control, and HLS downloads.
 */
import crypto from 'crypto';
import { session, net } from 'electron';
import { AppStore } from './store';
import { TimeSeriesDatabase, BatchMeasurementRow } from './database';
import { debugLogger } from './debugLogger';
import { securityMediaProxy } from './securityMediaProxy';
import {
  AccountInfo,
  DashboardReadings,
  MeasureQueryRequest,
  MeasureQueryStatus,
  MeasureSeries,
  MetricType,
  ModuleType,
  NetatmoScale,
  SecurityCamera,
  SecurityDataPayload,
  SecurityDownloadResult,
  SecurityEvent,
  SecurityEventImageRefreshResult,
  SecurityEventVideoResult,
  SecurityFloodlightMode,
  SecurityHome,
  SecurityMediaFetchResult,
  SecurityPerson,
  SecuritySubEvent,
  SecurityVideoDownloadProgress,
  SetCameraFloodlightResult,
  SetPersonsAwayResult,
  StationModule,
  StoredCookie,
  SyncProgress,
  WeatherStation,
} from '../renderer/types';

/**
 * Manages authenticated REST requests, caching, historical SQLite synchronization,
 * and Netatmo Security camera operations across Web Login, OAuth 2.0, and Demo Mode.
 */
export class NetatmoClient {
  private store: AppStore;
  private db: TimeSeriesDatabase;
  private silentRefreshCallback?: () => Promise<string | null>;
  private onProgressCallback?: (progress: SyncProgress) => void;
  private onQueryStatusCallback?: (status: MeasureQueryStatus) => void;
  private onAccountUpdatedCallback?: (account: AccountInfo) => void;
  private isSyncing = false;
  private activeRefreshPromise: Promise<string> | null = null;
  private inFlightStationsPromise: Promise<WeatherStation[]> | null = null;
  private lastStationsFetchAt = 0;
  private hasHomeCoachCache: { hasDevices: boolean; checkedAt: number } | null = null;
  private homesDataCache: { data: any; fetchedAt: number } | null = null;
  private hasSecurityCamerasCache: { hasCameras: boolean; checkedAt: number } | null = null;
  private inFlightSecurityPromise: Promise<SecurityDataPayload> | null = null;
  private lastSecurityFetchAt = 0;
  private lastSecurityPayload: SecurityDataPayload | null = null;
  private cameraUrlCache = new Map<
    string,
    { vpnUrl: string; localUrl?: string; isLocal: boolean; updatedAt: number }
  >();
  private readonly allowedMediaOrigins = new Set<string>();
  private currentProgress: SyncProgress = {
    active: false,
    phase: 'idle',
    message: 'Idle',
    completedModules: 0,
    totalModules: 0,
    pointsStored: 0,
  };

  constructor(store: AppStore, db: TimeSeriesDatabase) {
    this.store = store;
    this.db = db;
  }

  /**
   * Clears in-memory API caches (e.g. on logout, account switch, or manual data clear).
   */
  public resetApiCaches(): void {
    this.lastStationsFetchAt = 0;
    this.hasHomeCoachCache = null;
    this.homesDataCache = null;
    this.hasSecurityCamerasCache = null;
    this.lastSecurityFetchAt = 0;
    this.lastSecurityPayload = null;
    this.cameraUrlCache.clear();
    this.allowedMediaOrigins.clear();
  }

  /** Checks whether a hostname resolves to a private, loopback, or link-local IP address. */
  private isDisallowedLoopbackOrLinkLocal(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
    if (h.startsWith('127.') || h.startsWith('169.254.')) return true;
    if (h.startsWith('fe80:') || h.startsWith('::ffff:127.')) return true;
    return false;
  }

  /** Registers a camera snapshot/stream URL origin so media proxying can safely allowlist it. */
  private registerAllowedMediaUrl(rawUrl?: string): void {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    try {
      const u = new URL(rawUrl);
      if (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        !this.isDisallowedLoopbackOrLinkLocal(u.hostname)
      ) {
        this.allowedMediaOrigins.add(u.origin);
      }
    } catch {}
  }

  /** Validates that a remote security media URL uses HTTPS and targets a public allowed host. */
  private isAllowedSecurityMediaUrl(rawUrl: string): boolean {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      if (this.isDisallowedLoopbackOrLinkLocal(host)) return false;
      if (this.allowedMediaOrigins.has(u.origin)) return true;
      return (
        host === 'netatmo.com' ||
        host.endsWith('.netatmo.com') ||
        host === 'netatmo.net' ||
        host.endsWith('.netatmo.net') ||
        host === 'netatmocameraimage.blob.core.windows.net' ||
        host.endsWith('.blob.core.windows.net')
      );
    } catch {
      return false;
    }
  }

  /** Registers a callback invoked whenever account metadata changes. */
  public setAccountUpdatedHandler(cb: (account: AccountInfo) => void): void {
    this.onAccountUpdatedCallback = cb;
  }

  /** Registers an external silent token-refresh handler (e.g. hidden web auth refresh). */
  public setSilentRefreshHandler(fn: () => Promise<string | null>): void {
    this.silentRefreshCallback = fn;
  }

  /** Registers a callback that receives incremental sync progress updates. */
  public setProgressHandler(fn: (progress: SyncProgress) => void): void {
    this.onProgressCallback = fn;
  }

  /** Registers a callback that receives historical measurement query status updates. */
  public setQueryStatusHandler(fn: (status: MeasureQueryStatus) => void): void {
    this.onQueryStatusCallback = fn;
  }

  /** Returns a shallow copy of the current sync progress snapshot. */
  public getSyncProgress(): SyncProgress {
    return { ...this.currentProgress };
  }

  /** Merges partial progress fields into current sync state and notifies listeners. */
  private emitProgress(partial: Partial<SyncProgress>): void {
    this.currentProgress = {
      ...this.currentProgress,
      ...partial,
    };
    this.onProgressCallback?.(this.getSyncProgress());
  }

  /**
   * Verifies a web access token or personal access token against Netatmo APIs
   * and saves the session.
   */
  public async verifyAndSaveWebToken(
    accessToken: string,
    refreshToken?: string,
    cookies: StoredCookie[] = [],
    authMethod: 'web' | 'token' = 'web',
    clientId?: string,
    clientSecret?: string,
    storeLocally?: boolean
  ): Promise<{ valid: boolean; account?: AccountInfo; error?: string }> {
    const cleanToken = accessToken.trim();
    if (!cleanToken) {
      return { valid: false, error: 'Empty access token' };
    }

    // Try both Netatmo API domains (app.netatmo.net is used by home.netatmo.com web tokens; api.netatmo.com by OAuth tokens)
    const bases: Array<'app.netatmo.net' | 'api.netatmo.com'> = [
      'app.netatmo.net',
      'api.netatmo.com',
    ];

    for (const apiBase of bases) {
      try {
        const res = await fetch(
          `https://${apiBase}/api/getstationsdata?get_favorites=true`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${cleanToken}`,
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
            },
          }
        );

        if (res.ok) {
          const data = await res.json();
          if (data && data.body) {
            const user = data.body.user || {};
            const admin = user.administrative || {};
            const userId = cleanToken.includes('|')
              ? cleanToken.split('|')[0]
              : user._id || undefined;
            const expiresAt = Math.floor(Date.now() / 1000) + 10800;

            this.store.updateSession({
              loggedIn: true,
              authMethod,
              accessToken: cleanToken,
              refreshToken: refreshToken || undefined,
              expiresAt,
              email: user.mail || undefined,
              userId,
              country: admin.country || undefined,
              locale: admin.reg_locale || admin.lang || undefined,
              cookies,
              apiBase,
            });

            const effectiveSecret =
              clientSecret?.trim() || this.store.getSettings().oauthClientSecret;
            if (clientId && effectiveSecret) {
              await this.store.saveApiKeys({
                clientId,
                clientSecret: effectiveSecret,
                accessToken: cleanToken,
                refreshToken: refreshToken || undefined,
                autoUpdate: true,
              });
            } else if (storeLocally) {
              await this.store.updateStoredApiKeysTokens(
                cleanToken,
                refreshToken || undefined,
                expiresAt
              );
            }

            const stations = this.parseStationsPayload(data);
            this.store.setCachedStations(stations);

            // Also ingest current dashboard readings into SQLite
            this.ingestDashboardSnapshot(stations);

            return {
              valid: true,
              account: this.store.getAccountInfo(),
            };
          }
        }
      } catch (err) {
        // Try next base
      }
    }

    return {
      valid: false,
      error: 'Token could not be verified with Netatmo API.',
    };
  }

  /**
   * Checks token validity and proactively auto-updates it if nearing expiration (or forced).
   */
  public async autoRefreshToken(
    force = false
  ): Promise<{ refreshed: boolean; expiresAt?: number; error?: string }> {
    const session = this.store.getSession();
    if (!session.loggedIn || session.authMethod === 'demo') {
      return { refreshed: false };
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = session.expiresAt || 0;
    // Netatmo tokens expire after 10800 seconds (3h). Proactively refresh when within 20m of expiry
    const needsRefresh = force || !expiresAt || now >= expiresAt - 1200;

    if (!needsRefresh) {
      return { refreshed: false, expiresAt };
    }

    try {
      await this.ensureAccessToken(true);
      const updated = this.store.getSession();
      return {
        refreshed: true,
        expiresAt: updated.expiresAt,
      };
    } catch (err: any) {
      return {
        refreshed: false,
        error: err?.message || 'Token auto-refresh failed',
      };
    }
  }

  /**
   * Ensures we have a valid access token, refreshing via OAuth2 refresh_token
   * or silent web session refresh if needed.
   */
  private async ensureAccessToken(forceRefresh = false): Promise<string> {
    const session = this.store.getSession();
    if (!session.loggedIn) {
      throw new Error('Not logged in to Netatmo.');
    }

    if (session.authMethod === 'demo') {
      return 'demo-token';
    }

    const now = Math.floor(Date.now() / 1000);
    // Netatmo access tokens last 10800s. Proactively refresh if within 15 minutes of expiry
    const isExpired =
      forceRefresh ||
      (session.expiresAt ? now >= session.expiresAt - 900 : false);

    if (!isExpired && session.accessToken) {
      return session.accessToken;
    }

    if (this.activeRefreshPromise) {
      return this.activeRefreshPromise;
    }

    this.activeRefreshPromise = (async (): Promise<string> => {
      try {
        // Attempt OAuth2 refresh_token flow if credentials exist
        const settings = this.store.getSettings();
        const clientId = settings.oauthClientId;
        const clientSecret = settings.oauthClientSecret;

        if (session.refreshToken && clientId && clientSecret) {
          const tokenStart = performance.now();
          try {
            const res = await fetch('https://api.netatmo.com/oauth2/token', {
              method: 'POST',
              signal: AbortSignal.timeout(15000),
              headers: {
                'Content-Type':
                  'application/x-www-form-urlencoded;charset=UTF-8',
              },
              body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: session.refreshToken,
                client_id: clientId,
                client_secret: clientSecret,
              }).toString(),
            });

            const rawText = await res.text();
            const tokenDuration = Math.max(
              1,
              Math.round(performance.now() - tokenStart)
            );
            const tokenBytes = Buffer.byteLength(rawText, 'utf8');
            let data: any = null;
            try {
              data = JSON.parse(rawText);
            } catch {}

            debugLogger.recordApiRequest({
              method: 'POST',
              endpoint: 'oauth2/token',
              baseHost: 'api.netatmo.com',
              url: 'https://api.netatmo.com/oauth2/token',
              status: res.status,
              ok: res.ok && !!data?.access_token,
              durationMs: tokenDuration,
              bytesReceived: tokenBytes,
              rawBody: res.ok
                ? '{"status":"ok","tokens":"[REDACTED]"}'
                : JSON.stringify({ error: data?.error || `HTTP ${res.status}` }),
              error: res.ok ? undefined : data?.error || `HTTP ${res.status}`,
              note: 'OAuth2 refresh_token',
            });

            if (res.ok && data?.access_token) {
              const newExpiresAt = now + (Number(data.expires_in) || 10800);
              const newRefreshToken =
                data.refresh_token || session.refreshToken;

              this.store.updateSession({
                accessToken: data.access_token,
                refreshToken: newRefreshToken,
                expiresAt: newExpiresAt,
              });

              await this.store.updateStoredApiKeysTokens(
                data.access_token,
                newRefreshToken,
                newExpiresAt
              );

              if (this.onAccountUpdatedCallback) {
                this.onAccountUpdatedCallback(this.store.getAccountInfo());
              }

              console.log(
                `[NetatmoClient] Token auto-updated successfully. Valid until ${new Date(
                  newExpiresAt * 1000
                ).toLocaleTimeString()}`
              );

              return data.access_token;
            } else {
              console.warn(
                '[NetatmoClient] OAuth token refresh response error:',
                res.status,
                data
              );
            }
          } catch (err: any) {
            const tokenDuration = Math.max(
              1,
              Math.round(performance.now() - tokenStart)
            );
            debugLogger.recordApiRequest({
              method: 'POST',
              endpoint: 'oauth2/token',
              baseHost: 'api.netatmo.com',
              url: 'https://api.netatmo.com/oauth2/token',
              status: null,
              ok: false,
              durationMs: tokenDuration,
              bytesReceived: 0,
              error: err?.message || 'Network error',
              note: 'OAuth2 refresh_token',
            });
            console.warn(
              '[NetatmoClient] OAuth token refresh network error:',
              err
            );
          }
        }

        // Attempt silent web refresh if logged in via web
        if (session.authMethod === 'web' && this.silentRefreshCallback) {
          const newWebToken = await this.silentRefreshCallback();
          if (newWebToken) {
            const updatedSession = this.store.getSession();
            await this.store.updateStoredApiKeysTokens(
              newWebToken,
              updatedSession.refreshToken,
              updatedSession.expiresAt
            );
            if (this.onAccountUpdatedCallback) {
              this.onAccountUpdatedCallback(this.store.getAccountInfo());
            }
            return newWebToken;
          }
        }

        if (!forceRefresh && session.accessToken) {
          return session.accessToken;
        }

        throw new Error('Netatmo session expired. Please sign in again.');
      } finally {
        this.activeRefreshPromise = null;
      }
    })();

    return this.activeRefreshPromise;
  }

  /**
   * Executes an authenticated GET or POST request against Netatmo API with automatic
   * fallback between `app.netatmo.net` and `api.netatmo.com` and token refresh on 401/403.
   */
  private async apiRequest(
    method: 'GET' | 'POST',
    endpoint: string,
    params: Record<string, string | number | boolean | undefined> = {},
    retried = false,
    requestNote?: string,
    jsonBody?: unknown
  ): Promise<any> {
    const token = await this.ensureAccessToken(false);
    const session = this.store.getSession();

    const preferredBase = session.apiBase || 'api.netatmo.com';
    const fallbackBase =
      preferredBase === 'api.netatmo.com'
        ? 'app.netatmo.net'
        : 'api.netatmo.com';

    const cleanParams: Record<string, string> = {};
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        cleanParams[k] = String(v);
        searchParams.set(k, String(v));
      }
    }
    const qs = searchParams.toString();

    let lastNetworkErr: any = null;
    let lastHttpStatus: number | null = null;
    let lastHttpErrMsg: string = '';

    for (const base of [preferredBase, fallbackBase]) {
      const url = `https://${base}/api/${endpoint}${qs ? '?' + qs : ''}`;
      const reqStart = performance.now();
      let res: Response;
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        };
        const fetchInit: RequestInit = {
          method,
          signal: AbortSignal.timeout(20000),
          headers,
        };
        if (method === 'POST') {
          if (jsonBody !== undefined) {
            headers['Content-Type'] = 'application/json';
            fetchInit.body = JSON.stringify(jsonBody);
          } else if (Object.keys(cleanParams).length > 0) {
            headers['Content-Type'] = 'application/json';
            fetchInit.body = JSON.stringify(cleanParams);
          }
        }
        res = await fetch(url, fetchInit);
      } catch (netErr: any) {
        lastNetworkErr = netErr;
        const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
        debugLogger.recordApiRequest({
          method,
          endpoint,
          baseHost: base,
          url,
          status: null,
          ok: false,
          durationMs,
          bytesReceived: 0,
          error: netErr?.message || netErr?.code || 'Network error / timeout',
          note: requestNote,
        });
        debugLogger.log(
          'warn',
          'API',
          `${method} /${endpoint} failed on ${base} (${netErr?.code || netErr?.message}), trying fallback...`
        );
        // Network or DNS error on this domain (e.g. ENOTFOUND or timeout); try fallback domain
        continue;
      }

      lastHttpStatus = res.status;
      let rawText = '';
      try {
        rawText = await res.text();
      } catch (readErr: any) {
        rawText = '';
      }
      const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
      const bytesReceived = Buffer.byteLength(rawText, 'utf8');

      let parsedJson: any = null;
      try {
        parsedJson = rawText ? JSON.parse(rawText) : null;
      } catch {}

      if (res.status === 401 || res.status === 403) {
        const errCode = parsedJson?.error?.code || 0;
        const errMsg = parsedJson?.error?.message || '';
        lastHttpErrMsg =
          errMsg ||
          (res.status === 401
            ? 'Access token expired or invalid'
            : 'Forbidden');

        debugLogger.recordApiRequest({
          method,
          endpoint,
          baseHost: base,
          url,
          status: res.status,
          ok: false,
          durationMs,
          bytesReceived,
          rawBody: rawText,
          error: lastHttpErrMsg,
          note: requestNote,
        });

        // Error codes 2 (Invalid access token) or 3 (Access token expired)
        if (!retried && (errCode === 2 || errCode === 3 || res.status === 401)) {
          debugLogger.log(
            'warn',
            'Auth',
            `Received HTTP ${res.status} on /${endpoint}, refreshing access token and retrying...`
          );
          try {
            await this.ensureAccessToken(true);
            return this.apiRequest(method, endpoint, params, true, requestNote, jsonBody);
          } catch (refreshErr: any) {
            throw new Error(
              `Netatmo session expired: ${
                refreshErr instanceof Error ? refreshErr.message : 'Please sign in again.'
              }`
            );
          }
        }
        // If already retried or refresh failed, do not retry other base domain with known invalid token
        throw new Error(
          `Netatmo authentication failed (${res.status}: ${lastHttpErrMsg}). Please sign in again.`
        );
      }

      if (res.status === 429) {
        debugLogger.recordApiRequest({
          method,
          endpoint,
          baseHost: base,
          url,
          status: 429,
          ok: false,
          durationMs,
          bytesReceived,
          rawBody: rawText,
          error: 'Rate limit exceeded (HTTP 429)',
          note: requestNote,
        });
        debugLogger.log(
          'warn',
          'API',
          `Rate limit HTTP 429 on /${endpoint} (${base}) — waiting 2500ms before retry...`
        );
        // Rate limit hit - wait 2.5 seconds and retry once
        await new Promise((r) => setTimeout(r, 2500));
        if (!retried) {
          return this.apiRequest(method, endpoint, params, true, requestNote, jsonBody);
        }
        throw new Error(
          'Netatmo API rate limit reached. Please wait a moment before syncing again.'
        );
      }

      if (res.ok && parsedJson) {
        debugLogger.recordApiRequest({
          method,
          endpoint,
          baseHost: base,
          url,
          status: res.status,
          ok: true,
          durationMs,
          bytesReceived,
          rawBody: rawText,
          note: requestNote,
        });
        if (base !== session.apiBase && (base === 'app.netatmo.net' || base === 'api.netatmo.com')) {
          this.store.updateSession({ apiBase: base });
        }
        return parsedJson;
      }

      // Other non-ok response
      lastHttpErrMsg = parsedJson?.error?.message || `HTTP ${res.status}`;
      debugLogger.recordApiRequest({
        method,
        endpoint,
        baseHost: base,
        url,
        status: res.status,
        ok: false,
        durationMs,
        bytesReceived,
        rawBody: rawText,
        error: lastHttpErrMsg,
        note: requestNote,
      });
      debugLogger.log(
        'error',
        'API',
        `HTTP ${res.status} on /${endpoint} (${base}): ${lastHttpErrMsg}`
      );
    }

    if (lastHttpStatus) {
      throw new Error(
        `Netatmo API request to /${endpoint} failed (${lastHttpStatus}: ${lastHttpErrMsg || 'Error'}).`
      );
    }

    if (lastNetworkErr) {
      const isDnsOrOffline =
        lastNetworkErr.code === 'ENOTFOUND' ||
        lastNetworkErr.code === 'ECONNREFUSED' ||
        lastNetworkErr.code === 'EAI_AGAIN' ||
        lastNetworkErr.message?.includes('fetch failed');
      if (isDnsOrOffline) {
        throw new Error(
          `Netatmo server unreachable (${lastNetworkErr.code || 'offline'}). Check internet connection.`
        );
      }
      throw lastNetworkErr;
    }

    throw new Error(`Netatmo API request to /${endpoint} failed.`);
  }

  /** Performs an authenticated GET request against a Netatmo API endpoint. */
  private async apiGet(
    endpoint: string,
    params: Record<string, string | number | boolean | undefined> = {},
    retried = false,
    requestNote?: string
  ): Promise<any> {
    return this.apiRequest('GET', endpoint, params, retried, requestNote);
  }

  /** Performs an authenticated form-encoded POST request against a Netatmo API endpoint. */
  private async apiPost(
    endpoint: string,
    params: Record<string, string | number | boolean | undefined> = {},
    retried = false,
    requestNote?: string
  ): Promise<any> {
    return this.apiRequest('POST', endpoint, params, retried, requestNote);
  }

  /** Performs an authenticated JSON POST request against a Netatmo API endpoint. */
  private async apiPostJson(
    endpoint: string,
    body: unknown,
    retried = false,
    requestNote?: string
  ): Promise<any> {
    return this.apiRequest('POST', endpoint, {}, retried, requestNote, body);
  }

  /**
   * Fetches all Weather Stations and Healthy Home Coach devices from the user's Netatmo account.
   * Deduplicates concurrent calls, reuses very recent results (<15s) unless forced, and skips
   * `gethomecoachsdata` once confirmed the account has no Home Coach devices (re-checked every 24h).
   */
  public async fetchStations(options?: {
    force?: boolean;
  }): Promise<WeatherStation[]> {
    const session = this.store.getSession();
    if (session.authMethod === 'demo') {
      return this.store.getCachedStations();
    }

    const nowMs = Date.now();
    if (
      !options?.force &&
      this.lastStationsFetchAt > 0 &&
      nowMs - this.lastStationsFetchAt < 15_000
    ) {
      const cached = this.store.getCachedStations();
      if (cached.length > 0) {
        return cached;
      }
    }

    if (this.inFlightStationsPromise) {
      return this.inFlightStationsPromise;
    }

    this.inFlightStationsPromise = (async (): Promise<WeatherStation[]> => {
      try {
        const stationsData = await this.apiGet('getstationsdata', {
          get_favorites: true,
        });

        const stations = this.parseStationsPayload(stationsData);

        const homeCoachRecheckMs = 24 * 60 * 60 * 1000;
        const hasKnownNhc = stations.some((s) =>
          s.modules.some((m) => m.type === 'NHC')
        );
        const shouldCheckHomeCoach =
          Boolean(options?.force) ||
          hasKnownNhc ||
          !this.hasHomeCoachCache ||
          this.hasHomeCoachCache.hasDevices ||
          Date.now() - this.hasHomeCoachCache.checkedAt > homeCoachRecheckMs;

        if (shouldCheckHomeCoach) {
          try {
            const coachData = await this.apiGet('gethomecoachsdata');
            const devices: any[] = Array.isArray(coachData?.body?.devices)
              ? coachData.body.devices
              : [];
            this.mergeHomeCoachPayload(stations, coachData);
            this.hasHomeCoachCache = {
              hasDevices: devices.length > 0,
              checkedAt: Date.now(),
            };
          } catch {
            // Optional scope/device type; remember absence to avoid polling every 10 minutes
            this.hasHomeCoachCache = {
              hasDevices: false,
              checkedAt: Date.now(),
            };
          }
        }

        // Update user email/locale if present in payload
        const user = stationsData?.body?.user;
        if (user?.mail) {
          this.store.updateSession({
            email: user.mail,
            country: user.administrative?.country,
            locale:
              user.administrative?.reg_locale || user.administrative?.lang,
          });
        }

        this.store.setCachedStations(stations);
        this.ingestDashboardSnapshot(stations);
        this.lastStationsFetchAt = Date.now();
        return stations;
      } finally {
        this.inFlightStationsPromise = null;
      }
    })();

    return this.inFlightStationsPromise;
  }

  /**
   * Parses `/api/getstationsdata` response into normalized `WeatherStation[]`
   */
  private parseStationsPayload(payload: any): WeatherStation[] {
    const devices = payload?.body?.devices;
    if (!Array.isArray(devices)) return [];

    const result: WeatherStation[] = [];

    for (const dev of devices) {
      const stationId: string = dev._id;
      const homeName: string =
        dev.home_name || dev.station_name || 'Weather Station';
      const stationName: string = dev.station_name || homeName;
      const mainModuleName: string = dev.module_name || 'Indoor Main';

      const mainMetrics = this.resolveAvailableMetrics(
        dev.data_type || [],
        dev.type || 'NAMain',
        dev.dashboard_data
      );

      const mainModule: StationModule = {
        id: stationId,
        stationId,
        stationName,
        homeName,
        moduleName: mainModuleName,
        type: (dev.type as ModuleType) || 'NAMain',
        dataTypes: Array.isArray(dev.data_type) ? dev.data_type : [],
        availableMetrics: mainMetrics,
        reachable: dev.reachable !== false,
        dashboard: this.normalizeDashboardData(dev.dashboard_data),
        firmware: dev.firmware,
        wifiStatus: dev.wifi_status,
        lastSeen: dev.last_status_store,
        lastSetup: dev.last_setup,
        dateSetup: dev.date_setup,
        co2Calibrating: dev.co2_calibrating,
        readOnly: dev.read_only,
      };

      const modules: StationModule[] = [mainModule];

      if (Array.isArray(dev.modules)) {
        for (const mod of dev.modules) {
          const modType = (mod.type as ModuleType) || 'NAModule1';
          const modMetrics = this.resolveAvailableMetrics(
            mod.data_type || [],
            modType,
            mod.dashboard_data
          );

          modules.push({
            id: mod._id,
            stationId,
            stationName,
            homeName,
            moduleName:
              mod.module_name || this.getDefaultModuleName(modType),
            type: modType,
            dataTypes: Array.isArray(mod.data_type) ? mod.data_type : [],
            availableMetrics: modMetrics,
            reachable: mod.reachable !== false,
            dashboard: this.normalizeDashboardData(mod.dashboard_data),
            firmware: mod.firmware,
            rfStatus: mod.rf_status,
            batteryPercent: mod.battery_percent,
            batteryVp: mod.battery_vp,
            batteryState: this.computeBatteryState(modType, mod.battery_vp, mod.battery_percent),
            lastSeen: mod.last_seen || mod.last_message,
            lastSetup: mod.last_setup,
          });
        }
      }

      result.push({
        id: stationId,
        stationName,
        homeId: dev.home_id,
        homeName,
        type: (dev.type as ModuleType) || 'NAMain',
        dateSetup: dev.date_setup || Math.floor(Date.now() / 1000) - 86400 * 365,
        lastStatusStore: dev.last_status_store || Math.floor(Date.now() / 1000),
        reachable: dev.reachable !== false,
        readOnly: Boolean(dev.read_only),
        isFavorite: Boolean(dev.favorite),
        place: dev.place
          ? {
              timezone: dev.place.timezone || 'UTC',
              country: dev.place.country,
              city: dev.place.city,
              altitude: dev.place.altitude,
              location: Array.isArray(dev.place.location)
                ? [Number(dev.place.location[0]), Number(dev.place.location[1])]
                : undefined,
            }
          : undefined,
        modules,
      });
    }

    return result;
  }

  /**
   * Parses `/api/gethomecoachsdata` (NHC Air Quality sensors) and groups them into the
   * existing Home from the Weather Station, using the room name (`station_name` / `name`)
   * as the device/module name instead of "Indoor".
   */
  private mergeHomeCoachPayload(stations: WeatherStation[], payload: any): void {
    const devices = payload?.body?.devices;
    if (!Array.isArray(devices) || devices.length === 0) return;

    // Group into the existing primary Weather Station Home if one exists
    let targetHome = stations.find((s) => s.type !== 'NHC') || stations[0];

    for (const dev of devices) {
      const deviceId: string = dev._id;
      const rawRoomName =
        dev.station_name ||
        dev.name ||
        (dev.module_name &&
        String(dev.module_name).trim().toLowerCase() !== 'indoor'
          ? dev.module_name
          : '') ||
        'Air Quality';
      const roomName: string = String(rawRoomName).trim();

      const metrics = this.resolveAvailableMetrics(
        dev.data_type || ['Temperature', 'Humidity', 'CO2', 'Noise', 'Pressure'],
        'NHC',
        dev.dashboard_data
      );

      if (!targetHome) {
        // Fallback only if the account has no Weather Station at all
        const homeName = dev.home_name ? String(dev.home_name).trim() : roomName;
        targetHome = {
          id: deviceId,
          stationName: homeName,
          homeId: dev.home_id,
          homeName,
          type: 'NHC',
          dateSetup: dev.date_setup || Math.floor(Date.now() / 1000) - 86400 * 365,
          lastStatusStore: dev.last_status_store || Math.floor(Date.now() / 1000),
          reachable: dev.reachable !== false,
          readOnly: Boolean(dev.read_only),
          modules: [],
        };
        stations.push(targetHome);
      }

      const nhcModule: StationModule = {
        id: deviceId,
        stationId: targetHome.id,
        stationName: targetHome.stationName,
        homeName: targetHome.homeName,
        moduleName: roomName,
        type: 'NHC',
        dataTypes: dev.data_type || [
          'Temperature',
          'Humidity',
          'CO2',
          'Noise',
          'Pressure',
        ],
        availableMetrics: metrics,
        reachable: dev.reachable !== false,
        dashboard: this.normalizeDashboardData(dev.dashboard_data),
        firmware: dev.firmware,
        wifiStatus: dev.wifi_status,
        lastSeen: dev.last_status_store,
        lastSetup: dev.last_setup,
        dateSetup: dev.date_setup,
      };

      const existingIdx = targetHome.modules.findIndex((m) => m.id === deviceId);
      if (existingIdx >= 0) {
        targetHome.modules[existingIdx] = nhcModule;
      } else {
        targetHome.modules.push(nhcModule);
      }
    }
  }

  /** Coerces numeric and trend fields of a raw Netatmo `dashboard_data` object into `DashboardReadings`. */
  private normalizeDashboardData(
    raw: any
  ): DashboardReadings | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    return {
      time_utc: Number(raw.time_utc || Math.floor(Date.now() / 1000)),
      Temperature:
        raw.Temperature !== undefined ? Number(raw.Temperature) : undefined,
      Humidity: raw.Humidity !== undefined ? Number(raw.Humidity) : undefined,
      CO2: raw.CO2 !== undefined ? Number(raw.CO2) : undefined,
      Noise: raw.Noise !== undefined ? Number(raw.Noise) : undefined,
      Pressure: raw.Pressure !== undefined ? Number(raw.Pressure) : undefined,
      AbsolutePressure:
        raw.AbsolutePressure !== undefined
          ? Number(raw.AbsolutePressure)
          : undefined,
      min_temp: raw.min_temp !== undefined ? Number(raw.min_temp) : undefined,
      max_temp: raw.max_temp !== undefined ? Number(raw.max_temp) : undefined,
      date_min_temp:
        raw.date_min_temp !== undefined ? Number(raw.date_min_temp) : undefined,
      date_max_temp:
        raw.date_max_temp !== undefined ? Number(raw.date_max_temp) : undefined,
      temp_trend: raw.temp_trend,
      pressure_trend: raw.pressure_trend,
      Rain: raw.Rain !== undefined ? Number(raw.Rain) : undefined,
      sum_rain_1:
        raw.sum_rain_1 !== undefined ? Number(raw.sum_rain_1) : undefined,
      sum_rain_24:
        raw.sum_rain_24 !== undefined ? Number(raw.sum_rain_24) : undefined,
      WindStrength:
        raw.WindStrength !== undefined ? Number(raw.WindStrength) : undefined,
      WindAngle:
        raw.WindAngle !== undefined ? Number(raw.WindAngle) : undefined,
      GustStrength:
        raw.GustStrength !== undefined ? Number(raw.GustStrength) : undefined,
      GustAngle:
        raw.GustAngle !== undefined ? Number(raw.GustAngle) : undefined,
      max_wind_str:
        raw.max_wind_str !== undefined ? Number(raw.max_wind_str) : undefined,
      max_wind_angle:
        raw.max_wind_angle !== undefined
          ? Number(raw.max_wind_angle)
          : undefined,
      date_max_wind_str:
        raw.date_max_wind_str !== undefined
          ? Number(raw.date_max_wind_str)
          : undefined,
      health_idx:
        raw.health_idx !== undefined ? Number(raw.health_idx) : undefined,
    };
  }

  /** Determines the supported sensor metric keys from advertised data types, module type, and payload fields. */
  private resolveAvailableMetrics(
    dataTypes: string[],
    moduleType: ModuleType,
    dashboard?: any
  ): MetricType[] {
    const set = new Set<MetricType>();
    const lowerTypes = dataTypes.map((d) => d.toLowerCase());

    if (
      lowerTypes.includes('temperature') ||
      dashboard?.Temperature !== undefined
    ) {
      set.add('temperature');
    }
    if (lowerTypes.includes('humidity') || dashboard?.Humidity !== undefined) {
      set.add('humidity');
    }
    if (lowerTypes.includes('co2') || dashboard?.CO2 !== undefined) {
      set.add('co2');
    }
    if (lowerTypes.includes('pressure') || dashboard?.Pressure !== undefined) {
      set.add('pressure');
    }
    if (lowerTypes.includes('noise') || dashboard?.Noise !== undefined) {
      set.add('noise');
    }
    if (
      lowerTypes.includes('rain') ||
      moduleType === 'NAModule3' ||
      dashboard?.Rain !== undefined
    ) {
      set.add('rain');
    }
    if (
      lowerTypes.includes('wind') ||
      moduleType === 'NAModule2' ||
      dashboard?.WindStrength !== undefined
    ) {
      set.add('windstrength');
      set.add('guststrength');
      set.add('windangle');
    }

    // Default fallback by module type if data_type array was empty
    if (set.size === 0) {
      if (moduleType === 'NAMain' || moduleType === 'NHC') {
        set.add('temperature');
        set.add('humidity');
        set.add('co2');
        set.add('pressure');
        set.add('noise');
      } else if (moduleType === 'NAModule1') {
        set.add('temperature');
        set.add('humidity');
      } else if (moduleType === 'NAModule4') {
        set.add('temperature');
        set.add('humidity');
        set.add('co2');
      }
    }

    return Array.from(set);
  }

  /** Returns the localized fallback display label for a Netatmo module hardware type. */
  private getDefaultModuleName(type: ModuleType): string {
    switch (type) {
      case 'NAMain':
        return 'Indoor Station';
      case 'NAModule1':
        return 'Outdoor Module';
      case 'NAModule2':
        return 'Wind Gauge';
      case 'NAModule3':
        return 'Rain Gauge';
      case 'NAModule4':
        return 'Indoor Module';
      case 'NHC':
        return 'Home Coach';
    }
  }

  /**
   * Computes battery health state using Netatmo's official lookup tables
   * from https://dev.netatmo.com/apidocumentation/weather
   */
  private computeBatteryState(
    type: ModuleType,
    batteryVp?: number,
    batteryPercent?: number
  ): 'full' | 'high' | 'medium' | 'low' | 'very_low' | undefined {
    if (batteryVp !== undefined) {
      if (type === 'NAModule2') {
        // Smart Anemometer thresholds: 5590 full, 5180 high, 4770 medium, 4360 low
        if (batteryVp >= 5590) return 'full';
        if (batteryVp >= 5180) return 'high';
        if (batteryVp >= 4770) return 'medium';
        if (batteryVp >= 4360) return 'low';
        return 'very_low';
      } else {
        // Outdoor / Rain / Indoor Module thresholds: 5500 full, 5000 high, 4500 medium, 4000 low
        if (batteryVp >= 5500) return 'full';
        if (batteryVp >= 5000) return 'high';
        if (batteryVp >= 4500) return 'medium';
        if (batteryVp >= 4000) return 'low';
        return 'very_low';
      }
    }
    if (batteryPercent !== undefined) {
      if (batteryPercent >= 80) return 'full';
      if (batteryPercent >= 60) return 'high';
      if (batteryPercent >= 35) return 'medium';
      if (batteryPercent >= 15) return 'low';
      return 'very_low';
    }
    return undefined;
  }

  /**
   * Stores the current live dashboard readings into the SQLite database so the latest point is
   * immediately available in charts.
   */
  private ingestDashboardSnapshot(stations: WeatherStation[]): void {
    const rows: BatchMeasurementRow[] = [];
    const defaultScale = this.store.getSettings().defaultScale || '30min';

    for (const st of stations) {
      for (const mod of st.modules) {
        const d = mod.dashboard;
        if (!d || !d.time_utc) continue;
        const ts = d.time_utc;

        const addPoint = (metric: MetricType, val?: number) => {
          if (val !== undefined && val !== null && !Number.isNaN(val)) {
            rows.push({
              stationId: st.id,
              moduleId: mod.id,
              metric,
              scale: defaultScale,
              ts,
              value: val,
            });
          }
        };

        addPoint('temperature', d.Temperature);
        addPoint('humidity', d.Humidity);
        addPoint('co2', d.CO2);
        addPoint('pressure', d.Pressure);
        addPoint('noise', d.Noise);
        addPoint('rain', d.Rain);
        addPoint('windstrength', d.WindStrength);
        addPoint('guststrength', d.GustStrength);
        addPoint('windangle', d.WindAngle);
      }
    }

    if (rows.length > 0) {
      this.db.insertBatch(rows);
    }
  }

  /**
   * Synchronizes historical sensor data for all modules according to the user's configured
   * history range (default: 14 days, or up to Netatmo's maximum since station setup).
   */
  public async syncHistoricalData(options?: {
    forceFull?: boolean;
    customDays?: number;
    scale?: NetatmoScale;
  }): Promise<SyncProgress> {
    if (this.isSyncing) {
      return this.getSyncProgress();
    }

    const session = this.store.getSession();
    if (!session.loggedIn) {
      return this.getSyncProgress();
    }

    this.isSyncing = true;
    const syncStartedAt = performance.now();
    const settings = this.store.getSettings();
    const scale: NetatmoScale = options?.scale || settings.defaultScale || '30min';
    const now = Math.floor(Date.now() / 1000);

    debugLogger.log(
      'info',
      'Sync',
      `Starting historical sync (scale=${scale}, mode=${
        settings.historyMaxMode ? 'MaxHistory' : `${options?.customDays || settings.historyDays}d`
      }, forceFull=${Boolean(options?.forceFull)})`
    );

    try {
      this.emitProgress({
        active: true,
        phase: 'stations',
        message: 'Refreshing live station & module readings...',
        completedModules: 0,
        totalModules: 0,
        pointsStored: 0,
        error: undefined,
      });

      const stations = await this.fetchStations({
        force: Boolean(options?.forceFull),
      });

      if (session.authMethod === 'demo') {
        this.emitProgress({
          active: false,
          phase: 'done',
          message: 'Demo station data active',
          completedModules: stations.reduce((acc, s) => acc + s.modules.length, 0),
          totalModules: stations.reduce((acc, s) => acc + s.modules.length, 0),
          lastSyncAt: now,
        });
        this.isSyncing = false;
        return this.getSyncProgress();
      }

      const allModules: Array<{ station: WeatherStation; module: StationModule }> = [];
      for (const st of stations) {
        for (const mod of st.modules) {
          if (mod.availableMetrics.length > 0) {
            allModules.push({ station: st, module: mod });
          }
        }
      }

      let totalPointsStored = 0;
      this.emitProgress({
        active: true,
        phase: 'history',
        message: `Syncing historical data (${
          settings.historyMaxMode
            ? 'Max history since station setup'
            : `${options?.customDays || settings.historyDays} days`
        })...`,
        completedModules: 0,
        totalModules: allModules.length,
        pointsStored: 0,
      });

      for (let i = 0; i < allModules.length; i++) {
        const { station, module } = allModules[i];

        // Compute target begin timestamp for this station/module:
        // If historyMaxMode is enabled, go back to module.dateSetup / station.dateSetup,
        // which is the maximum history Netatmo stores for the device!
        const days = options?.customDays ?? settings.historyDays ?? 14;
        const setupTs =
          module.dateSetup && module.dateSetup > 1262304000
            ? module.dateSetup
            : module.lastSetup && module.lastSetup > 1262304000
              ? module.lastSetup
              : station.dateSetup;
        const earliestAllowed =
          setupTs && setupTs > 1262304000
            ? setupTs
            : now - 86400 * 365 * 5; // 5 years fallback

        const requestedBegin = settings.historyMaxMode
          ? earliestAllowed
          : Math.max(earliestAllowed, now - Math.round(days * 86400));

        // If user requested a very long history (> 180 days) with 'max' (5-min) scale,
        // use '30min' or '1hour' if appropriate or chunk carefully.
        const stepSeconds = this.db.getScaleSeconds(scale);
        const coverage = options?.forceFull
          ? null
          : this.db.getSyncCoverage(module.id, scale);

        const windowsToFetch: Array<{ begin: number; end: number }> = [];

        if (!coverage) {
          windowsToFetch.push({ begin: requestedBegin, end: now });
        } else {
          // 1. Check if user expanded history window further into the past
          if (requestedBegin < coverage.minTs - stepSeconds * 2) {
            windowsToFetch.push({
              begin: requestedBegin,
              end: coverage.minTs,
            });
          }
          // 2. Fetch forward delta only when Netatmo has newer telemetry than SQLite coverage
          const latestModTs = module.dashboard?.time_utc || 0;
          const hasNewerModReading =
            latestModTs > 0
              ? latestModTs > coverage.maxTs
              : now > coverage.maxTs + Math.max(stepSeconds, 600);
          if (hasNewerModReading) {
            const forwardBegin = Math.max(
              requestedBegin,
              coverage.maxTs - stepSeconds
            );
            const forwardEnd =
              latestModTs > 0
                ? Math.min(now, Math.max(latestModTs + stepSeconds, coverage.maxTs + stepSeconds))
                : now;
            if (forwardBegin < forwardEnd) {
              windowsToFetch.push({
                begin: forwardBegin,
                end: forwardEnd,
              });
            }
          }
        }

        if (windowsToFetch.length === 0) {
          debugLogger.log(
            'debug',
            'Sync',
            `[${i + 1}/${allModules.length}] ${module.moduleName}: already cached cleanly in SQLite`
          );
        } else {
          const desc = windowsToFetch
            .map(
              (w) =>
                `${new Date(w.begin * 1000).toISOString().slice(0, 16)}..${new Date(
                  w.end * 1000
                )
                  .toISOString()
                  .slice(0, 16)}`
            )
            .join(', ');
          debugLogger.log(
            'info',
            'Sync',
            `[${i + 1}/${allModules.length}] ${module.moduleName}: fetching ${windowsToFetch.length} window(s) [${desc}]`
          );
        }

        this.emitProgress({
          message: `Loading ${module.moduleName} (${station.homeName})...`,
          completedModules: i,
        });

        for (const win of windowsToFetch) {
          const stored = await this.fetchAndStoreModuleWindow(
            station.id,
            module,
            scale,
            win.begin,
            win.end,
            (page, storedSoFar) => {
              const rateBps = debugLogger.getStats().lastTransferRateBps;
              const rateText =
                rateBps >= 1024
                  ? `${(rateBps / 1024).toFixed(1)} KB/s`
                  : rateBps > 0
                    ? `${rateBps} B/s`
                    : '';
              this.emitProgress({
                message: `Loading ${module.moduleName} (${station.homeName}) • page ${page}${
                  rateText ? ` • ${rateText}` : ''
                }`,
                pointsStored: totalPointsStored + storedSoFar,
              });
            }
          );
          totalPointsStored += stored;
          this.emitProgress({
            pointsStored: totalPointsStored,
          });
        }

        this.emitProgress({
          completedModules: i + 1,
        });
      }

      const elapsedSec = ((performance.now() - syncStartedAt) / 1000).toFixed(2);
      debugLogger.log(
        'info',
        'Sync',
        `Sync completed in ${elapsedSec}s: ${allModules.length} modules, ${totalPointsStored.toLocaleString()} new data points`
      );

      this.emitProgress({
        active: false,
        phase: 'done',
        message: `Synced ${allModules.length} sensors in ${elapsedSec}s (${totalPointsStored.toLocaleString()} new points)`,
        completedModules: allModules.length,
        totalModules: allModules.length,
        pointsStored: totalPointsStored,
        lastSyncAt: Math.floor(Date.now() / 1000),
      });
    } catch (err: any) {
      const elapsedSec = ((performance.now() - syncStartedAt) / 1000).toFixed(2);
      console.error('[NetatmoClient] Historical sync error:', err);
      debugLogger.log(
        'error',
        'Sync',
        `Sync failed after ${elapsedSec}s: ${err?.message || 'Unknown error'}`
      );
      this.emitProgress({
        active: false,
        phase: 'error',
        message: err?.message || 'Historical data sync failed',
        error: err?.message || 'Historical data sync failed',
      });
    } finally {
      this.isSyncing = false;
    }

    return this.getSyncProgress();
  }

  /**
   * Fetches `/api/getmeasure` in paginated chunks of up to 1024 points and stores them in SQLite.
   */
  public async fetchAndStoreModuleWindow(
    stationId: string,
    module: StationModule,
    scale: NetatmoScale,
    dateBegin: number,
    dateEnd: number,
    onChunkProgress?: (pageCount: number, storedInWindow: number) => void
  ): Promise<number> {
    if (module.availableMetrics.length === 0 || dateBegin >= dateEnd) {
      return 0;
    }

    const session = this.store.getSession();
    if (session.authMethod === 'demo') {
      return 0;
    }

    const metrics = module.availableMetrics.filter((m) => m !== 'sum_rain');
    if (metrics.length === 0) return 0;

    const typeParam = metrics.join(',');
    const stepSeconds = this.db.getScaleSeconds(scale);
    // Netatmo caps each /getmeasure response at 1024 data points
    const maxWindowSeconds = stepSeconds * 1000;

    let cursor = Math.floor(dateBegin);
    const targetEnd = Math.floor(dateEnd);
    let totalStored = 0;
    let lowestFetchedTs = Infinity;
    let highestFetchedTs = -Infinity;
    let pageCount = 0;
    const maxPagesPerSync = 60; // Safeguard against runaway loops

    while (cursor < targetEnd && pageCount < maxPagesPerSync) {
      pageCount++;
      const chunkEnd = Math.min(targetEnd, cursor + maxWindowSeconds);

      // Standalone devices (NAMain base station or NHC Healthy Home Coach grouped under the Home)
      // use their own MAC as device_id and omit module_id in /api/getmeasure.
      const isStandaloneDevice =
        module.type === 'NHC' || module.id === stationId;
      const params: Record<string, string | number | boolean | undefined> = {
        device_id: module.type === 'NHC' ? module.id : stationId,
        module_id: isStandaloneDevice ? undefined : module.id,
        scale,
        type: typeParam,
        date_begin: cursor,
        date_end: chunkEnd,
        limit: 1024,
        optimize: true,
        real_time: true,
      };

      const chunkNote = `${module.moduleName} (${scale}) • Chunk #${pageCount} (${new Date(
        cursor * 1000
      )
        .toISOString()
        .slice(0, 10)} → ${new Date(chunkEnd * 1000).toISOString().slice(0, 10)})`;

      const response = await this.apiGet('getmeasure', params, false, chunkNote);
      const body = response?.body;

      const batchRows: BatchMeasurementRow[] = [];
      let maxTsInBatch = -1;

      if (Array.isArray(body)) {
        // optimize: true format -> [{ beg_time, step_time, value: [[v1, v2], ...] }]
        for (const segment of body) {
          const begTime = Number(segment.beg_time);
          const stepTime = Number(segment.step_time || stepSeconds);
          const values: any[][] = Array.isArray(segment.value)
            ? segment.value
            : [];
          for (let idx = 0; idx < values.length; idx++) {
            const ts = begTime + idx * stepTime;
            const tuple = values[idx];
            if (Array.isArray(tuple)) {
              for (let mIdx = 0; mIdx < metrics.length; mIdx++) {
                const val = tuple[mIdx];
                if (val !== null && val !== undefined && !Number.isNaN(Number(val))) {
                  batchRows.push({
                    stationId,
                    moduleId: module.id,
                    metric: metrics[mIdx],
                    scale,
                    ts,
                    value: Number(val),
                  });
                }
              }
            }
            if (ts > maxTsInBatch) maxTsInBatch = ts;
            if (ts < lowestFetchedTs) lowestFetchedTs = ts;
            if (ts > highestFetchedTs) highestFetchedTs = ts;
          }
        }
      } else if (body && typeof body === 'object') {
        // optimize: false format -> { "1555677739": [21.4, 45, ...] }
        const timestamps = Object.keys(body)
          .map((k) => Number(k))
          .filter((n) => !Number.isNaN(n))
          .sort((a, b) => a - b);

        for (const ts of timestamps) {
          const tuple = body[String(ts)];
          if (Array.isArray(tuple)) {
            for (let mIdx = 0; mIdx < metrics.length; mIdx++) {
              const val = tuple[mIdx];
              if (val !== null && val !== undefined && !Number.isNaN(Number(val))) {
                batchRows.push({
                  stationId,
                  moduleId: module.id,
                  metric: metrics[mIdx],
                  scale,
                  ts,
                  value: Number(val),
                });
              }
            }
          }
          if (ts > maxTsInBatch) maxTsInBatch = ts;
          if (ts < lowestFetchedTs) lowestFetchedTs = ts;
          if (ts > highestFetchedTs) highestFetchedTs = ts;
        }
      }

      if (batchRows.length > 0) {
        totalStored += this.db.insertBatch(batchRows);
      }

      onChunkProgress?.(pageCount, totalStored);

      // If we reached targetEnd, we are done
      if (maxTsInBatch >= targetEnd - stepSeconds) {
        break;
      }

      // Advance cursor:
      // If points were returned, continue from the next point after the latest timestamp returned.
      // If zero points were returned in [cursor, chunkEnd], advance past chunkEnd.
      let nextCursor: number;
      if (maxTsInBatch > 0) {
        nextCursor = Math.max(cursor + stepSeconds, maxTsInBatch + stepSeconds);
      } else {
        nextCursor = chunkEnd + stepSeconds;
      }

      if (nextCursor <= cursor) {
        break;
      }
      cursor = nextCursor;

      // Gentle pacing (200ms between paginated calls) to stay well within Netatmo's 50 req / 10s limit
      if (cursor < targetEnd) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (pageCount >= maxPagesPerSync && cursor < targetEnd) {
      debugLogger.log(
        'warn',
        'Sync',
        `${module.moduleName} reached maxPagesPerSync (${maxPagesPerSync}); remaining window will continue on next sync`
      );
    }

    // Record coverage so subsequent queries know this time window was synced
    if (lowestFetchedTs < Infinity && highestFetchedTs > 0) {
      const reachedEnd = cursor >= targetEnd || highestFetchedTs >= targetEnd - stepSeconds * 2;
      const covMin = Math.min(dateBegin, lowestFetchedTs);
      const covMax = reachedEnd ? Math.max(dateEnd, highestFetchedTs) : highestFetchedTs;
      this.db.updateSyncCoverage(module.id, scale, covMin, covMax);
    } else if (pageCount > 0 && cursor > dateBegin) {
      this.db.updateSyncCoverage(
        module.id,
        scale,
        dateBegin,
        Math.min(dateEnd, cursor)
      );
    }

    return totalStored;
  }

  /**
   * Queries historical series from the local SQLite database, automatically fetching
   * from Netatmo if the requested range/scale isn't cached yet or `forceRemoteFetch` is set.
   */
  public async queryMeasureSeries(
    req: MeasureQueryRequest
  ): Promise<MeasureSeries[]> {
    const stations = this.store.getCachedStations();
    const session = this.store.getSession();
    const results: MeasureSeries[] = [];

    // Ensure we only query and return data for the currently authenticated account's stations.
    // If logged out or no stations exist for this account, never query or leak old data.
    if (!session.loggedIn || stations.length === 0) {
      return [];
    }

    const currentModuleIds = new Set(
      stations.flatMap((s) => s.modules.map((m) => m.id))
    );

    // Group requested items by module so we only make 1 API call per module if remote fetch is needed
    const byModule = new Map<
      string,
      Array<{
        stationId: string;
        moduleId: string;
        moduleName: string;
        stationName: string;
        metric: MetricType;
      }>
    >();

    for (const item of req.items) {
      // Strictly prevent mixing data across different accounts
      if (!currentModuleIds.has(item.moduleId)) {
        continue;
      }
      const key = `${item.stationId}::${item.moduleId}`;
      const list = byModule.get(key) || [];
      list.push(item);
      byModule.set(key, list);
    }

    // Helper computing only the un-cached sub-windows for a module at the queried scale
    const computeUncoveredWindows = (
      st: WeatherStation | undefined,
      mod: StationModule
    ): Array<{ begin: number; end: number }> => {
      if (req.forceRemoteFetch) {
        return [{ begin: req.dateBegin, end: req.dateEnd }];
      }
      const coverage = this.db.getSyncCoverage(mod.id, req.scale);
      const stepSec = this.db.getScaleSeconds(req.scale);
      const effectiveBegin = Math.max(
        req.dateBegin,
        st?.dateSetup || mod.dateSetup || 0
      );
      const modLatestTs = mod.dashboard?.time_utc || 0;
      const effectiveTargetEnd =
        modLatestTs > 0 ? Math.min(req.dateEnd, modLatestTs) : req.dateEnd;

      if (!coverage) {
        return [{ begin: effectiveBegin, end: req.dateEnd }];
      }

      const windows: Array<{ begin: number; end: number }> = [];
      if (effectiveBegin < coverage.minTs - stepSec * 4) {
        windows.push({
          begin: effectiveBegin,
          end: Math.min(req.dateEnd, coverage.minTs + stepSec),
        });
      }
      if (effectiveTargetEnd > coverage.maxTs + stepSec * 2) {
        const fwdBegin = Math.max(effectiveBegin, coverage.maxTs - stepSec);
        if (fwdBegin < req.dateEnd) {
          windows.push({ begin: fwdBegin, end: req.dateEnd });
        }
      }
      return windows;
    };

    // Determine upfront whether this query requires remote Netatmo Cloud API requests or is served 100% from local SQLite
    let willHitApi = false;
    if (session.loggedIn && session.authMethod !== 'demo') {
      for (const [, group] of byModule.entries()) {
        const sample = group[0];
        const st = stations.find((s) => s.id === sample.stationId);
        const mod = st?.modules.find((m) => m.id === sample.moduleId);
        if (mod && computeUncoveredWindows(st, mod).length > 0) {
          willHitApi = true;
          break;
        }
      }
    }

    if (this.onQueryStatusCallback) {
      this.onQueryStatusCallback({
        source: willHitApi ? 'netatmo_api' : 'local_database',
        scale: req.scale,
      });
    }

    let authFailed = false;
    for (const [, group] of byModule.entries()) {
      const sample = group[0];
      const st = stations.find((s) => s.id === sample.stationId);
      const mod = st?.modules.find((m) => m.id === sample.moduleId);
      let didFetchForModule = false;

      if (
        mod &&
        session.loggedIn &&
        session.authMethod !== 'demo' &&
        !authFailed
      ) {
        const missingWindows = computeUncoveredWindows(st, mod);
        if (missingWindows.length > 0) {
          try {
            for (const win of missingWindows) {
              await this.fetchAndStoreModuleWindow(
                sample.stationId,
                mod,
                req.scale,
                win.begin,
                win.end
              );
            }
            didFetchForModule = true;
          } catch (err: any) {
            console.warn(
              `[NetatmoClient] Remote backfill for ${mod.moduleName} failed, serving cached SQLite data:`,
              err?.message || err
            );
            if (
              err?.message?.includes('session expired') ||
              err?.message?.includes('authentication failed')
            ) {
              authFailed = true;
            }
          }
        }
      }

      for (const item of group) {
        const points = this.db.queryPoints(
          item.moduleId,
          item.metric,
          req.scale,
          req.dateBegin,
          req.dateEnd
        );

        results.push({
          seriesKey: `${item.moduleId}::${item.metric}`,
          stationId: item.stationId,
          moduleId: item.moduleId,
          moduleName: item.moduleName,
          stationName: item.stationName,
          metric: item.metric,
          scale: req.scale,
          points,
          stats: this.db.computeStats(points),
          source: willHitApi || didFetchForModule ? 'netatmo_api' : 'local_database',
        });
      }
    }

    return results;
  }

  /**
   * Populates a realistic Demo Station with 30 days of historical sensor data in SQLite
   * so the user can explore all charting, multi-curve comparison, and taskbar widget features offline.
   */
  public async enableDemoMode(): Promise<{
    account: AccountInfo;
    stations: WeatherStation[];
  }> {
    this.db.clearDemoHistory();

    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;
    const stationId = '70:ee:50:de:m0:01';
    const outdoorId = '02:00:00:de:m0:02';
    const bedroomId = '03:00:00:de:m0:03';
    const rainId = '05:00:00:de:m0:04';
    const windId = '06:00:00:de:m0:05';

    const demoStation: WeatherStation = {
      id: stationId,
      stationName: 'Zürich Home Weather Station (Demo)',
      homeId: 'demo-home-zurich',
      homeName: 'Zürich Home',
      type: 'NAMain',
      dateSetup: now - 365 * 86400,
      lastStatusStore: now - 120,
      reachable: true,
      readOnly: true,
      place: {
        timezone: 'Europe/Zurich',
        country: 'CH',
        city: 'Zürich',
        altitude: 408,
        location: [8.5417, 47.3769],
      },
      modules: [
        {
          id: stationId,
          stationId,
          stationName: 'Zürich Home Weather Station (Demo)',
          homeName: 'Zürich Home',
          moduleName: 'Living Room',
          type: 'NAMain',
          dataTypes: ['Temperature', 'Humidity', 'CO2', 'Noise', 'Pressure'],
          availableMetrics: [
            'temperature',
            'humidity',
            'co2',
            'pressure',
            'noise',
          ],
          reachable: true,
          firmware: 204,
          wifiStatus: 52,
          lastSeen: now - 120,
          dateSetup: now - 365 * 86400,
          dashboard: {
            time_utc: now - 120,
            Temperature: 22.1,
            Humidity: 46,
            CO2: 615,
            Noise: 37,
            Pressure: 1018.4,
            AbsolutePressure: 970.2,
            min_temp: 20.4,
            max_temp: 23.2,
            date_min_temp: now - 19000,
            date_max_temp: now - 5400,
            temp_trend: 'stable',
            pressure_trend: 'up',
          },
        },
        {
          id: outdoorId,
          stationId,
          stationName: 'Zürich Home Weather Station (Demo)',
          homeName: 'Zürich Home',
          moduleName: 'Garden Terrace (Outdoor)',
          type: 'NAModule1',
          dataTypes: ['Temperature', 'Humidity'],
          availableMetrics: ['temperature', 'humidity'],
          reachable: true,
          firmware: 53,
          rfStatus: 58,
          batteryPercent: 88,
          batteryVp: 5620,
          batteryState: 'full',
          lastSeen: now - 125,
          dashboard: {
            time_utc: now - 125,
            Temperature: 13.4,
            Humidity: 68,
            min_temp: 7.2,
            max_temp: 16.8,
            date_min_temp: now - 22000,
            date_max_temp: now - 7200,
            temp_trend: 'up',
          },
        },
        {
          id: bedroomId,
          stationId,
          stationName: 'Zürich Home Weather Station (Demo)',
          homeName: 'Zürich Home',
          moduleName: 'Master Bedroom',
          type: 'NAModule4',
          dataTypes: ['Temperature', 'Humidity', 'CO2'],
          availableMetrics: ['temperature', 'humidity', 'co2'],
          reachable: true,
          firmware: 51,
          rfStatus: 64,
          batteryPercent: 74,
          batteryVp: 5240,
          batteryState: 'high',
          lastSeen: now - 130,
          dashboard: {
            time_utc: now - 130,
            Temperature: 19.6,
            Humidity: 51,
            CO2: 780,
            min_temp: 18.5,
            max_temp: 20.8,
            date_min_temp: now - 21000,
            date_max_temp: now - 6000,
            temp_trend: 'down',
          },
        },
        {
          id: rainId,
          stationId,
          stationName: 'Zürich Home Weather Station (Demo)',
          homeName: 'Zürich Home',
          moduleName: 'Garden Rain Gauge',
          type: 'NAModule3',
          dataTypes: ['Rain'],
          availableMetrics: ['rain'],
          reachable: true,
          firmware: 14,
          rfStatus: 69,
          batteryPercent: 81,
          batteryVp: 5490,
          batteryState: 'high',
          lastSeen: now - 120,
          dashboard: {
            time_utc: now - 120,
            Rain: 0.0,
            sum_rain_1: 0.2,
            sum_rain_24: 3.4,
          },
        },
        {
          id: windId,
          stationId,
          stationName: 'Zürich Home Weather Station (Demo)',
          homeName: 'Zürich Home',
          moduleName: 'Roof Anemometer',
          type: 'NAModule2',
          dataTypes: ['Wind'],
          availableMetrics: ['windstrength', 'guststrength', 'windangle'],
          reachable: true,
          firmware: 27,
          rfStatus: 62,
          batteryPercent: 92,
          batteryVp: 5710,
          batteryState: 'full',
          lastSeen: now - 115,
          dashboard: {
            time_utc: now - 115,
            WindStrength: 11,
            WindAngle: 245,
            GustStrength: 22,
            GustAngle: 255,
            max_wind_str: 34,
            max_wind_angle: 260,
            date_max_wind_str: now - 14400,
          },
        },
      ],
    };

    // Generate 30 days of 30-min measurements (~1,440 time steps * 13 series = ~18,720 points)
    const step = 1800;
    const rows: BatchMeasurementRow[] = [];
    const startTs = Math.floor(thirtyDaysAgo / step) * step;

    for (let ts = startTs; ts <= now; ts += step) {
      const hourOfDay = ((ts % 86400) / 3600 + 2) % 24;
      const dayCycle = Math.sin(((hourOfDay - 9) / 24) * Math.PI * 2);
      const weatherWave = Math.sin(ts / (86400 * 4.5)) * 3.5;
      const microNoise = Math.sin(ts * 0.0017) * 0.35;

      // Living room
      const lrTemp = Number((21.6 + dayCycle * 1.1 + weatherWave * 0.18 + microNoise).toFixed(1));
      const lrHum = Math.round(45 - dayCycle * 4 + Math.cos(ts / (86400 * 3)) * 5);
      const lrCo2 = Math.round(
        560 +
          (hourOfDay >= 18 && hourOfDay <= 23 ? 340 : 80) +
          Math.sin(ts / 7200) * 95
      );
      const lrPress = Number(
        (1015.5 + Math.sin(ts / (86400 * 3.2)) * 9.5 + Math.cos(ts / 21600) * 0.8).toFixed(1)
      );
      const lrNoise = Math.round(
        35 + (hourOfDay >= 8 && hourOfDay <= 21 ? 8 : 0) + Math.abs(Math.sin(ts / 3600)) * 6
      );

      rows.push(
        { stationId, moduleId: stationId, metric: 'temperature', scale: '30min', ts, value: lrTemp },
        { stationId, moduleId: stationId, metric: 'humidity', scale: '30min', ts, value: lrHum },
        { stationId, moduleId: stationId, metric: 'co2', scale: '30min', ts, value: lrCo2 },
        { stationId, moduleId: stationId, metric: 'pressure', scale: '30min', ts, value: lrPress },
        { stationId, moduleId: stationId, metric: 'noise', scale: '30min', ts, value: lrNoise }
      );

      // Outdoor
      const outTemp = Number((11.5 + dayCycle * 4.8 + weatherWave + microNoise).toFixed(1));
      const outHum = Math.min(
        98,
        Math.max(32, Math.round(72 - dayCycle * 16 - weatherWave * 2.5))
      );
      rows.push(
        { stationId, moduleId: outdoorId, metric: 'temperature', scale: '30min', ts, value: outTemp },
        { stationId, moduleId: outdoorId, metric: 'humidity', scale: '30min', ts, value: outHum }
      );

      // Bedroom
      const bedTemp = Number((19.4 + dayCycle * 0.8 + weatherWave * 0.15 + microNoise * 0.6).toFixed(1));
      const bedHum = Math.round(50 - dayCycle * 3 + Math.sin(ts / (86400 * 2.5)) * 4);
      const bedCo2 = Math.round(
        480 +
          (hourOfDay >= 22 || hourOfDay <= 7 ? 520 : 40) +
          Math.cos(ts / 5400) * 75
      );
      rows.push(
        { stationId, moduleId: bedroomId, metric: 'temperature', scale: '30min', ts, value: bedTemp },
        { stationId, moduleId: bedroomId, metric: 'humidity', scale: '30min', ts, value: bedHum },
        { stationId, moduleId: bedroomId, metric: 'co2', scale: '30min', ts, value: bedCo2 }
      );

      // Rain (occasional rain fronts when pressure is low)
      const isRainFront = lrPress < 1010 && Math.sin(ts / 14400) > 0.35;
      const rainMm = isRainFront
        ? Number((Math.abs(Math.sin(ts / 3600)) * 1.8).toFixed(1))
        : 0;
      rows.push({
        stationId,
        moduleId: rainId,
        metric: 'rain',
        scale: '30min',
        ts,
        value: rainMm,
      });

      // Wind
      const windStr = Math.max(
        2,
        Math.round(9 + dayCycle * 5 + (isRainFront ? 14 : 0) + Math.sin(ts / 5400) * 4)
      );
      const gustStr = Math.round(windStr * 1.65 + Math.abs(Math.cos(ts / 3600)) * 6);
      const windAng = Math.round((240 + Math.sin(ts / 43200) * 45 + 360) % 360);
      rows.push(
        { stationId, moduleId: windId, metric: 'windstrength', scale: '30min', ts, value: windStr },
        { stationId, moduleId: windId, metric: 'guststrength', scale: '30min', ts, value: gustStr },
        { stationId, moduleId: windId, metric: 'windangle', scale: '30min', ts, value: windAng }
      );
    }

    this.db.insertBatch(rows);
    for (const mod of demoStation.modules) {
      this.db.updateSyncCoverage(mod.id, '30min', startTs, now);
    }

    this.store.updateSession({
      loggedIn: true,
      authMethod: 'demo',
      email: 'demo@netatmo.local',
      country: 'CH',
      locale: 'de-CH',
    });

    this.store.setCachedStations([demoStation]);

    return {
      account: this.store.getAccountInfo(),
      stations: [demoStation],
    };
  }

  /**
   * Strips lightweight HTML formatting tags (such as <b>Name</b>) returned in Netatmo event messages.
   */
  private cleanEventMessage(raw: any): string {
    if (!raw || typeof raw !== 'string') return '';
    return raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Returns true if a Netatmo hardware type string identifies a security camera or doorbell. */
  private isCameraModuleType(type?: string): boolean {
    if (!type) return false;
    return (
      type === 'NACamera' ||
      type === 'NOC' ||
      type === 'NOC2' ||
      type === 'NDB' ||
      type === 'NPC'
    );
  }

  /**
   * Resolves a Netatmo picture object (snapshot or vignette), supporting direct
   * signed `.url` links as well as `{ id, key }` pairs via `/api/getcamerapicture`.
   */
  private resolvePictureUrl(pic: any): string | undefined {
    if (!pic || typeof pic !== 'object') return undefined;
    if (typeof pic.url === 'string' && pic.url.trim()) {
      const url = pic.url.trim();
      this.registerAllowedMediaUrl(url);
      return url;
    }
    if (pic.id && pic.key) {
      return `https://api.netatmo.com/api/getcamerapicture?image_id=${encodeURIComponent(
        String(pic.id)
      )}&key=${encodeURIComponent(String(pic.key))}`;
    }
    return undefined;
  }

  /** Converts a raw Netatmo security event object into the normalized `SecurityEvent` structure. */
  private normalizeSecurityEvent(
    raw: any,
    homeId: string,
    homeName: string,
    cameraNamesById: Map<string, string>,
    personsById: Map<string, string>
  ): SecurityEvent {
    const rawSubEvents: any[] = Array.isArray(raw.subevents) ? raw.subevents : [];
    const subEvents: SecuritySubEvent[] = rawSubEvents.map((se) => ({
      id: se.id ? String(se.id) : undefined,
      type: String(se.type || raw.type || 'event'),
      time: Number(se.time || raw.time || 0),
      offset: se.offset !== undefined ? Number(se.offset) : undefined,
      message: this.cleanEventMessage(se.message),
      snapshotUrl: this.resolvePictureUrl(se.snapshot),
      snapshotExpiresAt: se.snapshot?.expires_at || se.snapshot?.expire_at,
      vignetteUrl: this.resolvePictureUrl(se.vignette),
      personId: se.person_id ? String(se.person_id) : undefined,
    }));

    const firstSubWithSnapshot = subEvents.find((se) => se.snapshotUrl);
    const firstSubWithVignette = subEvents.find((se) => se.vignetteUrl);
    const snapshotUrl =
      this.resolvePictureUrl(raw.snapshot) || firstSubWithSnapshot?.snapshotUrl;
    const vignetteUrl =
      this.resolvePictureUrl(raw.vignette) || firstSubWithVignette?.vignetteUrl;
    const snapshotExpiresAt =
      raw.snapshot?.expires_at ||
      raw.snapshot?.expire_at ||
      firstSubWithSnapshot?.snapshotExpiresAt;

    const cameraId = raw.camera_id || raw.module_id || raw.device_id;
    const personId =
      raw.person_id || subEvents.find((se) => se.personId)?.personId;

    let msg = this.cleanEventMessage(raw.message);
    if (!msg && subEvents.length > 0) {
      msg = subEvents
        .map((se) => se.message)
        .filter(Boolean)
        .join(' • ');
    }
    if (!msg) {
      msg = String(raw.type || 'Security event');
    }

    return {
      id: String(raw.id || `${homeId}-${raw.time}-${Math.random()}`),
      homeId,
      homeName,
      cameraId: cameraId ? String(cameraId) : undefined,
      cameraName: cameraId
        ? cameraNamesById.get(String(cameraId)) || String(cameraId)
        : undefined,
      type: String(raw.type || 'unknown'),
      subType: raw.sub_type !== undefined ? Number(raw.sub_type) : undefined,
      time: Number(raw.time || 0),
      category: raw.category ? String(raw.category) : undefined,
      message: msg,
      personId: personId ? String(personId) : undefined,
      personName: personId ? personsById.get(String(personId)) : undefined,
      snapshotUrl,
      snapshotExpiresAt: snapshotExpiresAt ? Number(snapshotExpiresAt) : undefined,
      vignetteUrl,
      videoId: raw.video_id ? String(raw.video_id) : undefined,
      videoStatus: raw.video_status ? String(raw.video_status) : undefined,
      subEvents: subEvents.length > 0 ? subEvents : undefined,
    };
  }

  /**
   * Returns locally cached Netatmo Security data from SQLite (if security storage is enabled).
   */
  public getCachedSecurityData(homeId?: string): SecurityDataPayload {
    const session = this.store.getSession();
    if (!session.loggedIn || session.authMethod === 'demo') {
      return { homes: [], events: [], fetchedAt: 0 };
    }
    if (this.store.getSettings().storeSecurityData === false) {
      return { homes: [], events: [], fetchedAt: 0 };
    }
    return this.db.getSecurityData(homeId);
  }

  /**
   * Returns cached `/api/homesdata` static home/camera/person topology (6h TTL) unless forced.
   */
  private async getHomesDataCached(force = false): Promise<any> {
    const ttlMs = 6 * 60 * 60 * 1000;
    if (
      !force &&
      this.homesDataCache &&
      Date.now() - this.homesDataCache.fetchedAt < ttlMs
    ) {
      return this.homesDataCache.data;
    }

    const homesResp = await this.apiGet(
      'homesdata',
      {},
      false,
      'Security: discover homes & cameras'
    );
    this.homesDataCache = { data: homesResp, fetchedAt: Date.now() };
    return homesResp;
  }

  /**
   * Fetches Netatmo Security homes, live camera hardware status, and event timeline.
   * Consolidates/reuses cached static `/homesdata` topology, skips polling accounts confirmed
   * to have zero cameras (6h TTL), deduplicates concurrent refreshes, and serves recent data
   * unless `force` or pagination (`offsetEventId`) is requested.
   */
  public async fetchSecurityData(options?: {
    homeId?: string;
    size?: number;
    offsetEventId?: string;
    force?: boolean;
  }): Promise<SecurityDataPayload> {
    const session = this.store.getSession();
    if (!session.loggedIn) {
      return { homes: [], events: [], fetchedAt: Date.now() };
    }

    if (session.authMethod === 'demo') {
      return this.getDemoSecurityData();
    }

    const isDefaultRefresh = !options?.homeId && !options?.offsetEventId;
    const refreshMs = Math.max(
      90_000,
      (this.store.getSettings().refreshIntervalMinutes || 10) * 60 * 1000
    );

    if (!options?.force && isDefaultRefresh) {
      if (
        this.hasSecurityCamerasCache &&
        !this.hasSecurityCamerasCache.hasCameras &&
        Date.now() - this.hasSecurityCamerasCache.checkedAt < 6 * 60 * 60 * 1000
      ) {
        return {
          homes: [],
          events: [],
          fetchedAt: this.hasSecurityCamerasCache.checkedAt,
        };
      }

      if (
        this.lastSecurityFetchAt > 0 &&
        Date.now() - this.lastSecurityFetchAt < refreshMs
      ) {
        if (this.store.getSettings().storeSecurityData !== false) {
          const cached = this.db.getSecurityData();
          if (cached.homes.length > 0 || cached.events.length > 0) {
            return cached;
          }
        }
        if (this.lastSecurityPayload) {
          return this.lastSecurityPayload;
        }
      }
    }

    if (isDefaultRefresh && this.inFlightSecurityPromise) {
      return this.inFlightSecurityPromise;
    }

    const executeFetch = async (): Promise<SecurityDataPayload> => {
      const shouldStore = this.store.getSettings().storeSecurityData !== false;
      const size = options?.size ?? 40;
      const homes: SecurityHome[] = [];
      const allEvents: SecurityEvent[] = [];
      const cameraNamesById = new Map<string, string>();
      const personsById = new Map<string, string>();

      try {
        const homesResp = await this.getHomesDataCached(Boolean(options?.force));
        const rawHomes: any[] = Array.isArray(homesResp?.body?.homes)
          ? homesResp.body.homes
          : [];

        for (const h of rawHomes) {
          const homeId = String(h.id);
          const homeName = String(h.name || 'Home');
          if (options?.homeId && options.homeId !== homeId) {
            continue;
          }

          const roomNamesById = new Map<string, string>();
          for (const r of Array.isArray(h.rooms) ? h.rooms : []) {
            roomNamesById.set(String(r.id), String(r.name || ''));
          }

          const rawHomePersons: any[] = Array.isArray(h.persons) ? h.persons : [];
          let statusPersons: any[] = [];

          const cameras: SecurityCamera[] = [];
          for (const m of Array.isArray(h.modules) ? h.modules : []) {
            if (!this.isCameraModuleType(m.type)) continue;
            const cid = String(m.id);
            const cname = String(m.name || m.type || cid);
            cameraNamesById.set(cid, cname);
            cameras.push({
              id: cid,
              homeId,
              homeName,
              name: cname,
              type: String(m.type),
              roomName: m.room_id
                ? roomNamesById.get(String(m.room_id))
                : undefined,
              lastSetup: m.setup_date,
            });
          }

          if (cameras.length > 0) {
            // Fetch live camera & person presence status via /api/homestatus
            try {
              const statusResp = await this.apiGet(
                'homestatus',
                { home_id: homeId },
                false,
                `Security status: ${homeName}`
              );
              const statusHome = statusResp?.body?.home;
              statusPersons = Array.isArray(statusHome?.persons)
                ? statusHome.persons
                : [];
              const statusModules: any[] = Array.isArray(statusHome?.modules)
                ? statusHome.modules
                : [];
              const statusById = new Map<string, any>();
              for (const sm of statusModules) {
                statusById.set(String(sm.id), sm);
              }
              for (const cam of cameras) {
                const sm = statusById.get(cam.id);
                if (sm) {
                  cam.monitoring = sm.monitoring;
                  cam.status = sm.status || sm.monitoring;
                  cam.sdStatus = sm.sd_status;
                  cam.alimStatus = sm.alim_status;
                  cam.wifiStrength = sm.wifi_strength;
                  cam.wifiState = sm.wifi_state;
                  cam.firmwareRevision = sm.firmware_revision;
                  cam.isLocal = sm.is_local;
                  cam.floodlight = sm.floodlight;
                  cam.sirenStatus = sm.siren_status;
                  if (sm.vpn_url) {
                    cam.vpnUrl = String(sm.vpn_url).replace(/\/+$/, '');
                    this.registerAllowedMediaUrl(cam.vpnUrl);
                    const prevUrlCache = this.cameraUrlCache.get(cam.id);
                    this.cameraUrlCache.set(cam.id, {
                      vpnUrl: cam.vpnUrl,
                      localUrl:
                        prevUrlCache?.vpnUrl === cam.vpnUrl
                          ? prevUrlCache.localUrl
                          : undefined,
                      isLocal: Boolean(sm.is_local),
                      updatedAt: Date.now(),
                    });
                  }
                }
              }
            } catch (statusErr: any) {
              debugLogger.log(
                'warn',
                'Security',
                `Could not fetch /homestatus for ${homeName}: ${statusErr?.message || statusErr}`
              );
            }
          }

          const persons = this.mergeAndFilterPersons(
            rawHomePersons,
            statusPersons,
            homeId,
            personsById
          );

          if (cameras.length > 0) {
            // Fetch event list via /api/getevents (incremental unseen-only when SQLite storage is enabled)
            try {
              const knownIds = shouldStore
                ? this.db.getKnownSecurityEventIds(homeId)
                : new Set<string>();
              let cursorEventId: string | undefined = options?.offsetEventId;
              const maxPages =
                shouldStore && !options?.offsetEventId && knownIds.size > 0
                  ? 5
                  : 1;
              let newForHome = 0;

              for (let page = 0; page < maxPages; page++) {
                const eventsResp = await this.apiGet(
                  'getevents',
                  {
                    home_id: homeId,
                    size,
                    event_id: cursorEventId,
                  },
                  false,
                  `Security events: ${homeName} (size=${size}${cursorEventId ? `, until=${cursorEventId}` : ''})`
                );
                const rawEvents: any[] =
                  eventsResp?.body?.home?.events ||
                  eventsResp?.body?.events ||
                  [];

                let hitKnownEvent = false;
                let addedInPage = 0;

                for (const ev of rawEvents) {
                  const evId = ev.id ? String(ev.id) : '';
                  if (shouldStore && evId && knownIds.has(evId)) {
                    hitKnownEvent = true;
                    continue;
                  }
                  if (evId) knownIds.add(evId);
                  allEvents.push(
                    this.normalizeSecurityEvent(
                      ev,
                      homeId,
                      homeName,
                      cameraNamesById,
                      personsById
                    )
                  );
                  addedInPage++;
                  newForHome++;
                }

                if (
                  rawEvents.length === 0 ||
                  rawEvents.length < size ||
                  hitKnownEvent ||
                  addedInPage === 0
                ) {
                  break;
                }

                const lastRaw = rawEvents[rawEvents.length - 1];
                if (!lastRaw?.id) break;
                cursorEventId = String(lastRaw.id);
              }

              if (shouldStore && !options?.offsetEventId) {
                debugLogger.log(
                  'info',
                  'Security',
                  `Security sync (${homeName}): ${newForHome} new unseen event(s)`
                );
              }
            } catch (evErr: any) {
              const msg = evErr?.message || String(evErr);
              debugLogger.log(
                'warn',
                'Security',
                `Could not fetch /getevents for ${homeName}: ${msg}`
              );
              if (
                msg.includes('403') ||
                msg.toLowerCase().includes('scope') ||
                msg.toLowerCase().includes('forbidden')
              ) {
                return {
                  homes,
                  events: allEvents,
                  fetchedAt: Date.now(),
                  scopeError: msg,
                };
              }
            }
          }

          if (cameras.length > 0 || persons.length > 0) {
            homes.push({
              id: homeId,
              name: homeName,
              timezone: h.timezone,
              cameras,
              persons,
            });
          }
        }

        // Fallback to classic /api/gethomedata if homesdata yielded no cameras
        if (homes.every((h) => h.cameras.length === 0)) {
          try {
            const legacyResp = await this.apiGet(
              'gethomedata',
              options?.homeId ? { home_id: options.homeId } : {},
              false,
              'Security fallback: /gethomedata'
            );
            const legacyHomes: any[] = Array.isArray(legacyResp?.body?.homes)
              ? legacyResp.body.homes
              : [];
            for (const lh of legacyHomes) {
              const homeId = String(lh.id);
              const homeName = String(lh.name || 'Home');
              const persons = this.mergeAndFilterPersons(
                Array.isArray(lh.persons) ? lh.persons : [],
                undefined,
                homeId,
                personsById
              );
              const cameras: SecurityCamera[] = (
                Array.isArray(lh.cameras) ? lh.cameras : []
              ).map((c: any) => {
                const cid = String(c.id);
                const cname = String(c.name || c.type || cid);
                cameraNamesById.set(cid, cname);
                const vpnUrl = c.vpn_url
                  ? String(c.vpn_url).replace(/\/+$/, '')
                  : undefined;
                if (vpnUrl) {
                  this.registerAllowedMediaUrl(vpnUrl);
                  this.cameraUrlCache.set(cid, {
                    vpnUrl,
                    isLocal: Boolean(c.is_local),
                    updatedAt: Date.now(),
                  });
                }
                return {
                  id: cid,
                  homeId,
                  homeName,
                  name: cname,
                  type: String(c.type || 'NACamera'),
                  status: c.status,
                  monitoring: c.status,
                  sdStatus: c.sd_status,
                  alimStatus: c.alim_status,
                  isLocal: c.is_local,
                  vpnUrl,
                };
              });
              for (const ev of Array.isArray(lh.events) ? lh.events : []) {
                allEvents.push(
                  this.normalizeSecurityEvent(
                    ev,
                    homeId,
                    homeName,
                    cameraNamesById,
                    personsById
                  )
                );
              }
              if (cameras.length > 0) {
                homes.push({
                  id: homeId,
                  name: homeName,
                  timezone: lh.place?.timezone,
                  cameras,
                  persons,
                });
              }
            }
          } catch (legacyErr: any) {
            debugLogger.log(
              'debug',
              'Security',
              `Fallback /gethomedata note: ${legacyErr?.message || legacyErr}`
            );
          }
        }

        const totalCams = homes.reduce((acc, h) => acc + h.cameras.length, 0);
        const totalPersons = homes.reduce((acc, h) => acc + h.persons.length, 0);
        if (isDefaultRefresh) {
          this.hasSecurityCamerasCache = {
            hasCameras: totalCams > 0,
            checkedAt: Date.now(),
          };
        }
        debugLogger.log(
          'info',
          'Security',
          `Loaded ${homes.length} home(s), ${totalCams} camera(s), ${totalPersons} person(s), ${allEvents.length} fetched event(s)`,
          allEvents.length > 0
            ? allEvents
                .slice(0, 10)
                .map(
                  (e) =>
                    `[${new Date(e.time * 1000).toISOString()}] ${e.cameraName || 'Camera'}: ${e.message}`
                )
                .join(' | ')
            : undefined,
          'security'
        );

        let payload: SecurityDataPayload;
        if (shouldStore) {
          this.db.upsertSecurityData({ homes, events: allEvents });
          payload = this.db.getSecurityData(options?.homeId);
        } else {
          allEvents.sort((a, b) => b.time - a.time);
          payload = {
            homes,
            events: allEvents,
            fetchedAt: Date.now(),
          };
        }

        if (isDefaultRefresh) {
          this.lastSecurityFetchAt = Date.now();
          this.lastSecurityPayload = payload;
        }
        return payload;
      } catch (err: any) {
        const msg = err?.message || String(err);
        debugLogger.log('error', 'Security', `Security fetch failed: ${msg}`);
        if (
          msg.includes('403') ||
          msg.toLowerCase().includes('scope') ||
          msg.toLowerCase().includes('forbidden') ||
          msg.includes('401')
        ) {
          return {
            homes: [],
            events: [],
            fetchedAt: Date.now(),
            scopeError: msg,
          };
        }
        throw err;
      }
    };

    if (isDefaultRefresh) {
      this.inFlightSecurityPromise = executeFetch().finally(() => {
        this.inFlightSecurityPromise = null;
      });
      return this.inFlightSecurityPromise;
    }

    return executeFetch();
  }

  /**
   * Fetches binary or text media (images, HLS playlists, TS segments) through Node so
   * Netatmo CDN URLs and local camera LAN URLs work without renderer CORS or mixed-content blocks.
   */
  private async fetchSecurityMedia(req: {
    url: string;
    responseType?: 'text' | 'arraybuffer';
    headers?: Record<string, string>;
    rangeStart?: number;
    rangeEnd?: number;
    timeoutMs?: number;
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
  }): Promise<SecurityMediaFetchResult> {
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      return {
        ok: false,
        status: 400,
        statusText: 'Invalid URL',
        finalUrl: req.url,
        error: 'Invalid media URL.',
      };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return {
        ok: false,
        status: 400,
        statusText: 'Unsupported protocol',
        finalUrl: req.url,
        error: 'Only http/https media URLs are supported.',
      };
    }

    if (!this.isAllowedSecurityMediaUrl(parsed.toString())) {
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden media target',
        finalUrl: parsed.toString(),
        error: 'Disallowed media host.',
      };
    }

    const headers: Record<string, string> = { ...(req.headers || {}) };
    if (req.rangeStart !== undefined) {
      headers['Range'] = `bytes=${req.rangeStart}-${
        req.rangeEnd !== undefined ? Math.max(0, req.rangeEnd - 1) : ''
      }`;
    }

    if (
      parsed.hostname === 'api.netatmo.com' ||
      parsed.hostname === 'api.netatmo.net'
    ) {
      try {
        const token = await this.ensureAccessToken();
        if (token && token !== 'demo-token') {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } catch {}
    }

    const isTimelapse = parsed.pathname.includes('/dl/timelapse');
    const maxBytes = isTimelapse ? 250 * 1024 * 1024 : 32 * 1024 * 1024;
    const endpointLabel =
      parsed.pathname.replace(/^\/api\//, '').replace(/^\/+/, '').slice(0, 64) ||
      'media';
    const mediaNote = isTimelapse
      ? 'Security 24h timelapse'
      : parsed.pathname.includes('/vod/')
        ? 'Security VOD probe'
        : parsed.pathname.includes('getcamerapicture')
          ? 'Security camera snapshot'
          : 'Security media fetch';
    const reqStart = performance.now();

    try {
      const netatmoSes = session.fromPartition('persist:netatmo');
      const fetcher =
        netatmoSes && typeof netatmoSes.fetch === 'function'
          ? (input: string, init: any) => netatmoSes.fetch(input, init)
          : (input: string, init: any) => net.fetch(input, init);

      const timeoutMs =
        typeof req.timeoutMs === 'number' && req.timeoutMs > 0
          ? req.timeoutMs
          : 30000;
      let currentUrl = parsed.toString();
      let currentHeaders: Record<string, string> = { ...headers };
      let res: any = null;
      for (let hop = 0; hop <= 3; hop++) {
        if (!this.isAllowedSecurityMediaUrl(currentUrl)) {
          return {
            ok: false,
            status: 403,
            statusText: 'Forbidden redirect target',
            finalUrl: currentUrl,
            error: 'Disallowed redirect target.',
          };
        }
        const candidateRes = await fetcher(currentUrl, {
          method: 'GET',
          headers: currentHeaders,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (candidateRes.status >= 300 && candidateRes.status < 400 && hop < 3) {
          const loc = candidateRes.headers.get('location');
          if (!loc) {
            res = candidateRes;
            break;
          }
          const nextUrlObj = new URL(loc, currentUrl);
          if (nextUrlObj.origin !== new URL(currentUrl).origin) {
            delete currentHeaders['Authorization'];
            delete currentHeaders['authorization'];
          }
          currentUrl = nextUrlObj.toString();
          continue;
        }
        res = candidateRes;
        break;
      }

      if (!res) {
        throw new Error('Too many redirects');
      }

      const finalUrl = currentUrl;
      const contentType = res.headers.get('content-type') || undefined;

      if (!res.ok) {
        let errSnippet = '';
        try {
          errSnippet = (await res.text()).slice(0, 1000);
        } catch {}
        const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
        debugLogger.recordApiRequest({
          method: 'GET',
          endpoint: endpointLabel,
          baseHost: parsed.host,
          url: parsed.toString(),
          source: 'security',
          status: res.status,
          ok: false,
          durationMs,
          bytesReceived: Buffer.byteLength(errSnippet, 'utf8'),
          rawBody: errSnippet || undefined,
          error: `HTTP ${res.status} ${res.statusText || ''}`.trim(),
          note: mediaNote,
        });
        return {
          ok: false,
          status: res.status,
          statusText: res.statusText || `HTTP ${res.status}`,
          finalUrl,
          contentType,
          error: `HTTP ${res.status} ${res.statusText || ''}`.trim(),
        };
      }

      if (req.responseType === 'text') {
        const dataText = await res.text();
        const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
        const bytesReceived = Buffer.byteLength(dataText, 'utf8');
        debugLogger.recordApiRequest({
          method: 'GET',
          endpoint: endpointLabel,
          baseHost: parsed.host,
          url: parsed.toString(),
          source: 'security',
          status: res.status,
          ok: true,
          durationMs,
          bytesReceived,
          rawBody: dataText,
          note: mediaNote,
        });
        return {
          ok: true,
          status: res.status,
          statusText: res.statusText || 'OK',
          finalUrl,
          contentType,
          dataText,
        };
      }

      let u8: Uint8Array;
      const contentLenRaw = res.headers.get('content-length');
      const totalBytes = contentLenRaw ? Number(contentLenRaw) || 0 : 0;
      if (totalBytes > maxBytes) {
        throw new Error(`Media payload exceeds ${maxBytes} byte limit`);
      }

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let lastEmit = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              receivedBytes += value.byteLength;
              if (receivedBytes > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new Error(`Media payload exceeds ${maxBytes} byte limit`);
              }
              chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
              if (req.onProgress) {
                const now = Date.now();
                if (now - lastEmit >= 120) {
                  lastEmit = now;
                  req.onProgress(receivedBytes, totalBytes);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        req.onProgress?.(receivedBytes, totalBytes);
        u8 = Buffer.concat(chunks);
      } else {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > maxBytes) {
          throw new Error(`Media payload exceeds ${maxBytes} byte limit`);
        }
        u8 = new Uint8Array(buf);
      }
      const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
      debugLogger.recordApiRequest({
        method: 'GET',
        endpoint: endpointLabel,
        baseHost: parsed.host,
        url: parsed.toString(),
        source: 'security',
        status: res.status,
        ok: true,
        durationMs,
        bytesReceived: u8.byteLength,
        rawBody: JSON.stringify(
          {
            contentType: contentType || 'application/octet-stream',
            bytes: u8.byteLength,
            finalUrl,
          },
          null,
          2
        ),
        note: mediaNote,
      });
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText || 'OK',
        finalUrl,
        contentType,
        dataBuffer: u8,
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
      debugLogger.recordApiRequest({
        method: 'GET',
        endpoint: endpointLabel,
        baseHost: parsed.host,
        url: parsed.toString(),
        source: 'security',
        status: null,
        ok: false,
        durationMs,
        bytesReceived: 0,
        error: msg,
        note: mediaNote,
      });
      debugLogger.log(
        'warn',
        'Security',
        `Media fetch failed (${parsed.host}): ${msg}`,
        undefined,
        'security'
      );
      return {
        ok: false,
        status: 0,
        statusText: 'Network Error',
        finalUrl: parsed.toString(),
        error: msg,
      };
    }
  }

  /**
   * Resolves the cloud `vpn_url` (and optional LAN `local_url`) for a camera,
   * reusing cached entries from `/homestatus` & `/command/ping` for 30 minutes unless `forceRefresh` is set.
   */
  private async resolveCameraUrls(
    homeId: string,
    cameraId: string,
    forceRefresh = false
  ): Promise<{
    vpnUrl?: string;
    localUrl?: string;
    isLocal?: boolean;
    fromCache?: boolean;
  }> {
    const cacheTtlMs = 30 * 60 * 1000;
    const cached = !forceRefresh ? this.cameraUrlCache.get(cameraId) : undefined;
    if (cached && Date.now() - cached.updatedAt < cacheTtlMs) {
      if (!cached.isLocal || cached.localUrl) {
        return {
          vpnUrl: cached.vpnUrl,
          localUrl: cached.localUrl,
          isLocal: cached.isLocal,
          fromCache: true,
        };
      }
    }

    let vpnUrl: string | undefined = cached?.vpnUrl;
    let isLocal = cached?.isLocal ?? false;

    if (!vpnUrl || forceRefresh) {
      vpnUrl = undefined;
      isLocal = false;
      try {
        const statusResp = await this.apiGet(
          'homestatus',
          { home_id: homeId },
          false,
          `Security camera stream lookup: ${cameraId}`
        );
        const modules: any[] = Array.isArray(statusResp?.body?.home?.modules)
          ? statusResp.body.home.modules
          : [];
        const cam = modules.find((m) => String(m.id) === cameraId);
        if (cam?.vpn_url) vpnUrl = String(cam.vpn_url).replace(/\/+$/, '');
        if (cam?.is_local !== undefined) isLocal = Boolean(cam.is_local);
      } catch (err: any) {
        debugLogger.log(
          'warn',
          'Security',
          `homestatus camera lookup failed: ${err?.message || err}`
        );
      }

      if (!vpnUrl) {
        try {
          const legacyResp = await this.apiGet(
            'gethomedata',
            { home_id: homeId },
            false,
            `Security camera legacy lookup: ${cameraId}`
          );
          const homesList: any[] = Array.isArray(legacyResp?.body?.homes)
            ? legacyResp.body.homes
            : [];
          for (const h of homesList) {
            const cams: any[] = Array.isArray(h.cameras) ? h.cameras : [];
            const match = cams.find((c) => String(c.id) === cameraId);
            if (match?.vpn_url) {
              vpnUrl = String(match.vpn_url).replace(/\/+$/, '');
              isLocal = Boolean(match.is_local);
              break;
            }
          }
        } catch {}
      }
    }

    let localUrl: string | undefined;
    if (vpnUrl && isLocal) {
      const pingUrl = `${vpnUrl}/command/ping`;
      const pingHost = (() => {
        try {
          return new URL(pingUrl).host;
        } catch {
          return 'netatmo.net';
        }
      })();
      const pingStart = performance.now();
      try {
        const pingRes = await fetch(pingUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(2200),
        });
        const pingText = await pingRes.text();
        const durationMs = Math.max(1, Math.round(performance.now() - pingStart));
        debugLogger.recordApiRequest({
          method: 'GET',
          endpoint: 'command/ping',
          baseHost: pingHost,
          url: pingUrl,
          source: 'security',
          status: pingRes.status,
          ok: pingRes.ok,
          durationMs,
          bytesReceived: Buffer.byteLength(pingText, 'utf8'),
          rawBody: pingText,
          error: pingRes.ok ? undefined : `HTTP ${pingRes.status}`,
          note: `Security camera local LAN ping (${cameraId})`,
        });
        if (pingRes.ok) {
          const pingJson: any = JSON.parse(pingText);
          if (
            typeof pingJson?.local_url === 'string' &&
            pingJson.local_url.startsWith('http')
          ) {
            localUrl = pingJson.local_url.replace(/\/+$/, '');
            this.registerAllowedMediaUrl(localUrl);
          }
        }
      } catch (pingErr: any) {
        const durationMs = Math.max(1, Math.round(performance.now() - pingStart));
        debugLogger.recordApiRequest({
          method: 'GET',
          endpoint: 'command/ping',
          baseHost: pingHost,
          url: pingUrl,
          source: 'security',
          status: null,
          ok: false,
          durationMs,
          bytesReceived: 0,
          error: pingErr?.message || String(pingErr),
          note: `Security camera local LAN ping (${cameraId})`,
        });
      }
    }

    if (vpnUrl) {
      this.registerAllowedMediaUrl(vpnUrl);
      this.cameraUrlCache.set(cameraId, {
        vpnUrl,
        localUrl,
        isLocal,
        updatedAt: Date.now(),
      });
    }

    return { vpnUrl, localUrl, isLocal, fromCache: false };
  }

  /**
   * Attempts to reload or discover an event image by re-querying Netatmo `/getevents`
   * (refreshing expired URLs) and fetching candidate images through the main process.
   */
  public async refreshSecurityEventImage(options: {
    homeId: string;
    eventId: string;
    cameraId?: string;
    videoId?: string;
    candidateUrls?: string[];
  }): Promise<SecurityEventImageRefreshResult> {
    const session = this.store.getSession();
    if (!session.loggedIn) {
      return { ok: false, error: 'Not signed in to Netatmo.' };
    }

    if (session.authMethod === 'demo') {
      const safeEventId = String(options.eventId || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="320" cy="155" r="44" fill="#38bdf8" fill-opacity="0.18" stroke="#38bdf8" stroke-width="2"/><path d="M304 147h22l10-6v28l-10-6h-22z" fill="#38bdf8"/><text x="320" y="232" text-anchor="middle" fill="#f8fafc" font-family="Segoe UI,sans-serif" font-size="18" font-weight="600">Demo Camera Snapshot</text><text x="320" y="258" text-anchor="middle" fill="#94a3b8" font-family="Segoe UI,sans-serif" font-size="13">Event ${safeEventId} • Refreshed preview</text></svg>`;
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
      return { ok: true, imageUrl: dataUrl, vignetteUrl: dataUrl };
    }

    const tryFetchCandidateUrls = async (
      urls: string[],
      eventMeta?: SecurityEvent
    ): Promise<SecurityEventImageRefreshResult | null> => {
      for (const url of urls) {
        const fetched = await this.fetchSecurityMedia({
          url,
          responseType: 'arraybuffer',
        });
        if (
          fetched.ok &&
          fetched.dataBuffer &&
          fetched.dataBuffer.byteLength > 0 &&
          (!fetched.contentType ||
            fetched.contentType.toLowerCase().startsWith('image/'))
        ) {
          const mime =
            fetched.contentType?.split(';')[0]?.trim() || 'image/jpeg';
          const dataUrl = `data:${mime};base64,${Buffer.from(
            fetched.dataBuffer
          ).toString('base64')}`;
          if (this.store.getSettings().storeSecurityData !== false) {
            try {
              this.db.updateSecurityEventImage(
                options.eventId,
                dataUrl,
                dataUrl,
                eventMeta?.snapshotExpiresAt,
                eventMeta
              );
            } catch {}
          }
          return {
            ok: true,
            imageUrl: dataUrl,
            vignetteUrl: dataUrl,
            snapshotExpiresAt: eventMeta?.snapshotExpiresAt,
            event: eventMeta
              ? {
                  ...eventMeta,
                  snapshotUrl: dataUrl,
                }
              : undefined,
          };
        }
      }
      return null;
    };

    const initialHttpCandidates: string[] = [];
    for (const u of options.candidateUrls || []) {
      const trimmed = u?.trim();
      if (
        trimmed &&
        (trimmed.startsWith('https://') || trimmed.startsWith('http://')) &&
        this.isAllowedSecurityMediaUrl(trimmed) &&
        !initialHttpCandidates.includes(trimmed)
      ) {
        initialHttpCandidates.push(trimmed);
      }
    }

    // Try already-known HTTP candidate URLs before hitting /homesdata or /getevents
    if (initialHttpCandidates.length > 0) {
      const directResult = await tryFetchCandidateUrls(initialHttpCandidates);
      if (directResult) {
        return directResult;
      }
    }

    let refreshedEvent: SecurityEvent | undefined;
    try {
      const homeData = await this.getHomesDataCached(false);
      const rawHomes: any[] = Array.isArray(homeData?.body?.homes)
        ? homeData.body.homes
        : [];
      const h = rawHomes.find((hm) => String(hm.id) === options.homeId);
      const homeName = String(h?.name || 'Home');
      const cameraNamesById = new Map<string, string>();
      const personsById = new Map<string, string>();
      for (const m of Array.isArray(h?.modules) ? h.modules : []) {
        cameraNamesById.set(String(m.id), String(m.name || m.type || m.id));
      }
      for (const p of Array.isArray(h?.persons) ? h.persons : []) {
        if (p.pseudo) personsById.set(String(p.id), String(p.pseudo));
      }

      const eventsResp = await this.apiGet(
        'getevents',
        { home_id: options.homeId, size: 100 },
        false,
        `Security refresh image: ${options.eventId}`
      );
      let rawEvents: any[] =
        eventsResp?.body?.home?.events || eventsResp?.body?.events || [];
      let found = rawEvents.find((ev) => String(ev.id) === options.eventId);

      if (!found) {
        try {
          const untilResp = await this.apiGet(
            'geteventsuntil',
            { home_id: options.homeId, event_id: options.eventId },
            false,
            `Security refresh older image: ${options.eventId}`
          );
          rawEvents =
            untilResp?.body?.home?.events || untilResp?.body?.events || [];
          found = rawEvents.find((ev) => String(ev.id) === options.eventId);
        } catch {}
      }

      if (found) {
        refreshedEvent = this.normalizeSecurityEvent(
          found,
          options.homeId,
          homeName,
          cameraNamesById,
          personsById
        );
      }
    } catch (err: any) {
      debugLogger.log(
        'warn',
        'Security',
        `Could not refresh event metadata for ${options.eventId}: ${err?.message || err}`
      );
    }

    const candidates: string[] = [];
    const seen = new Set<string>(initialHttpCandidates);
    const pushUrl = (u?: string) => {
      const trimmed = u?.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        candidates.push(trimmed);
      }
    };

    if (refreshedEvent) {
      pushUrl(refreshedEvent.snapshotUrl);
      pushUrl(refreshedEvent.vignetteUrl);
      for (const se of refreshedEvent.subEvents || []) {
        pushUrl(se.snapshotUrl);
        pushUrl(se.vignetteUrl);
      }
    }

    // If still no cloud image URL and event has a videoId, try camera VOD thumbnail endpoints
    const effectiveVideoId = refreshedEvent?.videoId || options.videoId;
    const effectiveCameraId = refreshedEvent?.cameraId || options.cameraId;
    if (candidates.length === 0 && effectiveVideoId && effectiveCameraId) {
      const { vpnUrl, localUrl } = await this.resolveCameraUrls(
        options.homeId,
        effectiveCameraId
      );
      for (const base of [localUrl, vpnUrl].filter(Boolean) as string[]) {
        pushUrl(`${base}/vod/${effectiveVideoId}/vignette.jpg`);
        pushUrl(`${base}/vod/${effectiveVideoId}/snapshot.jpg`);
      }
    }

    const discoveredResult = await tryFetchCandidateUrls(
      candidates,
      refreshedEvent
    );
    if (discoveredResult) {
      return discoveredResult;
    }

    return {
      ok: false,
      event: refreshedEvent,
      error:
        candidates.length === 0
          ? 'Netatmo did not return a snapshot or vignette URL for this event.'
          : 'Snapshot could not be loaded (link expired or unavailable on Netatmo).',
    };
  }

  /**
   * Merges static person profiles from `/homesdata` with live presence (`out_of_sight`, `last_seen`)
   * from `/homestatus`, filters out stale/unnamed historic face blobs, and sorts At Home / recently seen first.
   */
  private mergeAndFilterPersons(
    rawPersons: any[],
    statusPersons: any[] | undefined,
    homeId: string,
    personsById: Map<string, string>
  ): SecurityPerson[] {
    const mergedById = new Map<
      string,
      SecurityPerson & { inStatus: boolean }
    >();

    for (const p of rawPersons) {
      if (!p?.id) continue;
      const pid = String(p.id);
      const pname =
        typeof p.pseudo === 'string' && p.pseudo.trim()
          ? p.pseudo.trim()
          : undefined;
      if (pname) personsById.set(pid, pname);
      mergedById.set(pid, {
        id: pid,
        homeId,
        pseudo: pname,
        outOfSight:
          p.out_of_sight !== undefined ? Boolean(p.out_of_sight) : true,
        lastSeen: p.last_seen !== undefined ? Number(p.last_seen) : undefined,
        faceUrl: p.face?.url,
        inStatus: false,
      });
    }

    for (const sp of statusPersons || []) {
      if (!sp?.id) continue;
      const pid = String(sp.id);
      const existing = mergedById.get(pid);
      const pname =
        (typeof sp.pseudo === 'string' && sp.pseudo.trim()
          ? sp.pseudo.trim()
          : undefined) || existing?.pseudo;
      if (pname) personsById.set(pid, pname);

      mergedById.set(pid, {
        id: pid,
        homeId,
        pseudo: pname,
        outOfSight:
          sp.out_of_sight !== undefined
            ? Boolean(sp.out_of_sight)
            : existing?.outOfSight ?? true,
        lastSeen:
          sp.last_seen !== undefined
            ? Number(sp.last_seen)
            : existing?.lastSeen,
        faceUrl: sp.face?.url || existing?.faceUrl,
        inStatus: true,
      });
    }

    const recentCutoffSec = Math.floor(Date.now() / 1000) - 30 * 86400;
    const relevant: SecurityPerson[] = [];

    for (const entry of mergedById.values()) {
      const { inStatus, ...person } = entry;
      const isAtHome = person.outOfSight === false;
      const seenRecently = Boolean(
        person.lastSeen && person.lastSeen >= recentCutoffSec
      );
      const hasName = Boolean(person.pseudo);

      // Show only people currently at home OR recently seen (never 700+ unnamed/historic ghosts)
      if (isAtHome || (seenRecently && (hasName || inStatus))) {
        relevant.push(person);
      }
    }

    relevant.sort((a, b) => {
      const aHome = a.outOfSight === false ? 0 : 1;
      const bHome = b.outOfSight === false ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
      const lsDiff = (b.lastSeen || 0) - (a.lastSeen || 0);
      if (lsDiff !== 0) return lsDiff;
      return (a.pseudo || '').localeCompare(b.pseudo || '');
    });

    return relevant;
  }

  /**
   * Notifies Netatmo (`POST /api/setpersonsaway` without `person_id`) that the home(s)
   * are empty and everybody has left.
   */
  public async setHomeEmpty(options: {
    homeIds: string[];
  }): Promise<SetPersonsAwayResult> {
    const session = this.store.getSession();
    if (!session.loggedIn) {
      return { ok: false, error: 'Not signed in to Netatmo.' };
    }

    const ids = (options.homeIds || []).filter(Boolean);
    if (ids.length === 0) {
      return { ok: false, error: 'No home ID available.' };
    }

    if (session.authMethod === 'demo') {
      return { ok: true };
    }

    const shouldStore = this.store.getSettings().storeSecurityData !== false;

    try {
      for (const hid of ids) {
        await this.apiPost(
          'setpersonsaway',
          { home_id: hid },
          false,
          `Security: mark home empty (${hid})`
        );
        if (shouldStore) {
          this.db.markHomePersonsAway(hid);
        }
      }
      debugLogger.log(
        'info',
        'Security',
        `Marked ${ids.length} home(s) empty via /api/setpersonsaway`,
        ids.join(', '),
        'security'
      );
      return { ok: true };
    } catch (err: any) {
      const msg = err?.message || String(err);
      const needsWriteScope =
        msg.includes('403') ||
        msg.toLowerCase().includes('scope') ||
        msg.toLowerCase().includes('forbidden');
      debugLogger.log(
        'error',
        'Security',
        `setpersonsaway failed: ${msg}`,
        undefined,
        'security'
      );
      return {
        ok: false,
        needsWriteScope,
        error: needsWriteScope
          ? 'Netatmo rejected setting home away (requires write_camera scope or Netatmo Web Sign-In).'
          : msg,
      };
    }
  }

  /**
   * Switches the floodlight mode (`auto` | `on` | `off`) for a supported outdoor camera
   * (`NOC` / `NOC2` Presence) via `POST /api/setstate` with automatic fallback to the
   * camera's local/VPN `/command/floodlight_set_config` endpoint.
   */
  public async setCameraFloodlight(options: {
    homeId: string;
    cameraId: string;
    mode: SecurityFloodlightMode;
  }): Promise<SetCameraFloodlightResult> {
    const sessionData = this.store.getSession();
    if (!sessionData.loggedIn) {
      return { ok: false, error: 'Not signed in to Netatmo.' };
    }

    const homeId = typeof options.homeId === 'string' ? options.homeId.trim() : '';
    const cameraId =
      typeof options.cameraId === 'string' ? options.cameraId.trim() : '';
    const mode = options.mode;

    if (!homeId || !cameraId) {
      return { ok: false, error: 'Missing home ID or camera ID.' };
    }

    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
      return { ok: false, error: 'Invalid floodlight mode requested.' };
    }

    if (sessionData.authMethod === 'demo') {
      return { ok: true, mode, via: 'demo' };
    }

    const shouldStore = this.store.getSettings().storeSecurityData !== false;
    const errors: string[] = [];

    // 1. Primary Cloud API: POST /api/setstate
    try {
      const resp = await this.apiPostJson(
        'setstate',
        {
          home: {
            id: homeId,
            modules: [{ id: cameraId, floodlight: mode }],
          },
        },
        false,
        `Security: set floodlight ${mode} (${cameraId})`
      );

      const bodyErrors: any[] = Array.isArray(resp?.body?.errors)
        ? resp.body.errors
        : [];
      const hasRespError = Boolean(resp?.error) || bodyErrors.length > 0;
      const statusOk = resp?.status === 'ok' || resp?.status === undefined;

      if (!hasRespError && statusOk) {
        if (shouldStore) {
          this.db.updateCameraFloodlight(homeId, cameraId, mode);
        }
        debugLogger.log(
          'info',
          'Security',
          `Set camera ${cameraId} floodlight to ${mode} via /api/setstate`,
          homeId,
          'security'
        );
        return { ok: true, mode, via: 'setstate' };
      }

      const apiErrMsg =
        resp?.error?.message ||
        bodyErrors[0]?.message ||
        (bodyErrors[0]?.code !== undefined
          ? `Netatmo setstate error code ${bodyErrors[0].code}`
          : 'Unexpected response from /api/setstate');
      errors.push(`/api/setstate: ${apiErrMsg}`);
    } catch (err: any) {
      errors.push(`/api/setstate: ${err?.message || String(err)}`);
    }

    // 2. Fallback: Camera local/VPN command endpoint (/command/floodlight_set_config)
    const { vpnUrl, localUrl } = await this.resolveCameraUrls(homeId, cameraId);
    const bases: Array<{ base: string; label: 'local' | 'vpn' }> = [];
    if (localUrl) bases.push({ base: localUrl, label: 'local' });
    if (vpnUrl) bases.push({ base: vpnUrl, label: 'vpn' });

    const encodedConfig = encodeURIComponent(JSON.stringify({ mode }));
    for (const entry of bases) {
      const cmdUrl = `${entry.base}/command/floodlight_set_config?config=${encodedConfig}`;
      try {
        const res = await this.fetchSecurityMedia({
          url: cmdUrl,
          responseType: 'text',
          timeoutMs: 12_000,
        });
        if (res.ok) {
          let cmdJson: any = null;
          if (res.dataText && res.dataText.trim()) {
            try {
              cmdJson = JSON.parse(res.dataText);
            } catch {}
          }
          const cmdOk =
            !cmdJson?.error &&
            (cmdJson === null ||
              cmdJson?.status === 'ok' ||
              cmdJson?.status === undefined);
          if (cmdOk) {
            if (shouldStore) {
              this.db.updateCameraFloodlight(homeId, cameraId, mode);
            }
            debugLogger.log(
              'info',
              'Security',
              `Set camera ${cameraId} floodlight to ${mode} via ${entry.label} /command/floodlight_set_config`,
              homeId,
              'security'
            );
            return { ok: true, mode, via: entry.label };
          }
          errors.push(
            `${entry.label} command: ${
              cmdJson?.error?.message ||
              cmdJson?.error ||
              'Camera rejected floodlight configuration'
            }`
          );
        } else {
          errors.push(`${entry.label} command: ${res.error || `HTTP ${res.status}`}`);
        }
      } catch (cmdErr: any) {
        errors.push(`${entry.label} command: ${cmdErr?.message || String(cmdErr)}`);
      }
    }

    const combined = errors.join(' | ') || 'Failed to update camera floodlight.';
    const lower = combined.toLowerCase();
    const needsWriteScope =
      combined.includes('403') ||
      lower.includes('scope') ||
      lower.includes('forbidden');

    debugLogger.log(
      'error',
      'Security',
      `Failed to set floodlight (${mode}) on camera ${cameraId}: ${combined}`,
      undefined,
      'security'
    );

    return {
      ok: false,
      needsWriteScope,
      error: needsWriteScope
        ? 'Netatmo rejected floodlight change (requires write_presence / write_camera scope or Netatmo Web Sign-In).'
        : combined,
    };
  }

  /**
   * Resolves stream endpoints (`localUrl` + `vpnUrl`), allows their origins in `securityMediaProxy`,
   * and probes HLS candidate playlists in priority order.
   */
  private async probeCameraStreamCandidates(options: {
    homeId: string;
    cameraId: string;
    localPaths: string[];
    vpnPaths: string[];
    unavailableError: string;
  }): Promise<{
    ok: boolean;
    vpnUrl?: string;
    localUrl?: string;
    candidates: string[];
    workingCandidates: string[];
    error?: string;
    needsAccessScope?: boolean;
    isDemo?: boolean;
  }> {
    const sessionData = this.store.getSession();
    if (!sessionData.loggedIn) {
      return {
        ok: false,
        candidates: [],
        workingCandidates: [],
        error: 'Not signed in to Netatmo.',
      };
    }

    if (sessionData.authMethod === 'demo') {
      return {
        ok: true,
        isDemo: true,
        candidates: [],
        workingCandidates: [],
      };
    }

    const tryProbe = async (forceRefreshUrls: boolean) => {
      const { vpnUrl, localUrl, fromCache } = await this.resolveCameraUrls(
        options.homeId,
        options.cameraId,
        forceRefreshUrls
      );

      if (!vpnUrl && !localUrl) {
        return {
          ok: false as const,
          fromCache: Boolean(fromCache),
          needsAccessScope: true,
          candidates: [] as string[],
          workingCandidates: [] as string[],
          error:
            'Netatmo did not expose a camera stream URL (vpn_url). Video playback requires Netatmo Web Sign-In or OAuth access_camera / access_presence scopes.',
        };
      }

      const candidates: string[] = [];
      if (localUrl) {
        securityMediaProxy.allowUrlOrigin(localUrl);
        for (const p of options.localPaths) {
          candidates.push(`${localUrl}${p}`);
        }
      }
      if (vpnUrl) {
        securityMediaProxy.allowUrlOrigin(vpnUrl);
        for (const p of options.vpnPaths) {
          candidates.push(`${vpnUrl}${p}`);
        }
      }

      const workingCandidates: string[] = [];
      let lastError: string | undefined;
      for (const candidate of candidates) {
        const probe = await this.fetchSecurityMedia({
          url: candidate,
          responseType: 'text',
        });
        if (probe.ok && probe.dataText && probe.dataText.includes('#EXTM3U')) {
          workingCandidates.push(candidate);
          break;
        }
        lastError = probe.error || `HTTP ${probe.status}`;
      }

      return {
        ok: workingCandidates.length > 0,
        fromCache: Boolean(fromCache),
        needsAccessScope: false,
        vpnUrl,
        localUrl,
        candidates,
        workingCandidates,
        error:
          workingCandidates.length === 0
            ? `${options.unavailableError} (${lastError || 'stream unavailable'}).`
            : undefined,
      };
    };

    let attempt = await tryProbe(false);
    if (!attempt.ok && attempt.fromCache) {
      this.cameraUrlCache.delete(options.cameraId);
      attempt = await tryProbe(true);
    }

    if (!attempt.ok) {
      return {
        ok: false,
        vpnUrl: attempt.vpnUrl,
        localUrl: attempt.localUrl,
        candidates: attempt.candidates,
        workingCandidates: [],
        needsAccessScope: attempt.needsAccessScope || undefined,
        error: attempt.error,
      };
    }

    return {
      ok: true,
      vpnUrl: attempt.vpnUrl,
      localUrl: attempt.localUrl,
      candidates: attempt.candidates,
      workingCandidates: attempt.workingCandidates,
    };
  }

  /**
   * Wraps probed HLS candidates in local `securityMediaProxy` URLs for Chromium `<video>` playback.
   */
  private async buildProxiedStreamResult(discovered: {
    ok: boolean;
    vpnUrl?: string;
    localUrl?: string;
    candidates: string[];
    workingCandidates: string[];
    error?: string;
    needsAccessScope?: boolean;
    isDemo?: boolean;
    localHintPath?: string;
  }): Promise<SecurityEventVideoResult> {
    if (discovered.isDemo) {
      return { ok: true, isDemo: true };
    }
    if (!discovered.ok || discovered.workingCandidates.length === 0) {
      return {
        ok: false,
        needsAccessScope: discovered.needsAccessScope,
        error: discovered.error || 'Video stream unavailable.',
      };
    }

    const primaryRaw = discovered.workingCandidates[0];
    const remainingRaw = discovered.candidates.filter((u) => u !== primaryRaw);
    const orderedRaw = [primaryRaw, ...remainingRaw];
    const proxied = await Promise.all(
      orderedRaw.map((u) => securityMediaProxy.toProxyUrl(u))
    );

    return {
      ok: true,
      hlsUrl: proxied[0],
      fallbackHlsUrls: proxied.slice(1),
      isLocalStream: Boolean(
        discovered.localUrl && primaryRaw.startsWith(discovered.localUrl)
      ),
    };
  }

  /**
   * Discovers ordered candidate VOD `.m3u8` URLs (`localUrl` + `vpnUrl`) for an event.
   */
  private async discoverVideoCandidates(options: {
    homeId: string;
    cameraId?: string;
    eventId?: string;
    videoId?: string;
  }): Promise<{
    ok: boolean;
    videoId?: string;
    vpnUrl?: string;
    localUrl?: string;
    candidates: string[];
    workingCandidates: string[];
    error?: string;
    needsAccessScope?: boolean;
    isDemo?: boolean;
  }> {
    const sessionData = this.store.getSession();
    if (!sessionData.loggedIn) {
      return {
        ok: false,
        candidates: [],
        workingCandidates: [],
        error: 'Not signed in to Netatmo.',
      };
    }

    if (sessionData.authMethod === 'demo') {
      return {
        ok: true,
        isDemo: true,
        candidates: [],
        workingCandidates: [],
      };
    }

    let videoId = options.videoId;
    if (!videoId && options.eventId) {
      try {
        const eventsResp = await this.apiGet(
          'getevents',
          { home_id: options.homeId, size: 100 },
          false,
          `Security video ID lookup: ${options.eventId}`
        );
        const rawEvents: any[] =
          eventsResp?.body?.home?.events || eventsResp?.body?.events || [];
        const match = rawEvents.find((ev) => String(ev.id) === options.eventId);
        if (match?.video_id) {
          videoId = String(match.video_id);
        }
      } catch {}
    }

    if (!videoId) {
      return {
        ok: false,
        candidates: [],
        workingCandidates: [],
        error: 'No recorded video ID is associated with this event.',
      };
    }

    if (!options.cameraId) {
      return {
        ok: false,
        videoId,
        candidates: [],
        workingCandidates: [],
        error: 'Camera ID is missing for this event.',
      };
    }

    const encodedVid = encodeURIComponent(videoId);
    const probed = await this.probeCameraStreamCandidates({
      homeId: options.homeId,
      cameraId: options.cameraId,
      localPaths: [
        `/vod/${encodedVid}/index_local.m3u8`,
        `/vod/${encodedVid}/index.m3u8`,
        `/vod/${encodedVid}/files/high/index_local.m3u8`,
        `/vod/${encodedVid}/files/high/index.m3u8`,
      ],
      vpnPaths: [
        `/vod/${encodedVid}/index.m3u8`,
        `/vod/${encodedVid}/files/high/index.m3u8`,
        `/vod/${encodedVid}/files/medium/index.m3u8`,
      ],
      unavailableError: 'Recorded video clip could not be opened',
    });

    return {
      ...probed,
      videoId,
    };
  }

  /**
   * Resolves the playable HLS stream URL (`{vpn_url}/vod/{video_id}/index.m3u8`) for an event video.
   */
  public async getSecurityEventVideo(options: {
    homeId: string;
    cameraId?: string;
    eventId?: string;
    videoId?: string;
  }): Promise<SecurityEventVideoResult> {
    const discovered = await this.discoverVideoCandidates(options);
    return this.buildProxiedStreamResult({
      ...discovered,
      localHintPath: discovered.videoId
        ? `/vod/${encodeURIComponent(discovered.videoId)}/index_local.m3u8`
        : undefined,
    });
  }

  /**
   * Resolves the playable live HLS stream URL (`{local_url|vpn_url}/live/index*.m3u8`) for a camera.
   */
  public async getCameraLiveStream(options: {
    homeId: string;
    cameraId: string;
  }): Promise<SecurityEventVideoResult> {
    if (!options.cameraId) {
      return {
        ok: false,
        error: 'Camera ID is required for live streaming.',
      };
    }

    const discovered = await this.probeCameraStreamCandidates({
      homeId: options.homeId,
      cameraId: options.cameraId,
      localPaths: [
        '/live/index_local.m3u8',
        '/live/index.m3u8',
        '/live/files/high/index_local.m3u8',
        '/live/files/high/index.m3u8',
      ],
      vpnPaths: [
        '/live/index.m3u8',
        '/live/files/high/index.m3u8',
        '/live/files/medium/index.m3u8',
      ],
      unavailableError:
        'Live camera stream could not be opened (camera may be offline or monitoring is disabled)',
    });

    return this.buildProxiedStreamResult({
      ...discovered,
      localHintPath: '/live/index_local.m3u8',
    });
  }

  /**
   * Resolves a snapshot image as a Buffer ready to save to disk.
   */
  public async resolveEventSnapshotBuffer(options: {
    homeId: string;
    eventId: string;
    cameraId?: string;
    videoId?: string;
    imageUrl?: string;
    candidateUrls?: string[];
  }): Promise<{ ok: boolean; buffer?: Buffer; ext?: string; error?: string }> {
    const decodeDataUri = (dataUri: string) => {
      const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUri);
      if (!m) return null;
      const mime = m[1].toLowerCase();
      if (mime.includes('svg')) return null;
      let ext = 'jpg';
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
      return {
        buffer: Buffer.from(m[2], 'base64'),
        ext,
      };
    };

    if (options.imageUrl?.startsWith('data:')) {
      const decoded = decodeDataUri(options.imageUrl);
      if (decoded) return { ok: true, ...decoded };
    }

    const refreshed = await this.refreshSecurityEventImage({
      homeId: options.homeId,
      eventId: options.eventId,
      cameraId: options.cameraId,
      videoId: options.videoId,
      candidateUrls: [
        ...(options.imageUrl ? [options.imageUrl] : []),
        ...(options.candidateUrls || []),
      ],
    });

    if (!refreshed.ok || !refreshed.imageUrl) {
      return {
        ok: false,
        error: refreshed.error || 'No snapshot image available to download.',
      };
    }

    if (refreshed.imageUrl.startsWith('data:')) {
      const decoded = decodeDataUri(refreshed.imageUrl);
      if (decoded) return { ok: true, ...decoded };
    }

    return { ok: false, error: 'Snapshot image could not be decoded.' };
  }

  /**
   * Downloads an HLS VOD video (resolving master playlist, optional AES-128 key,
   * and media segments) cleanly into a single playable `.ts` or `.mp4` buffer.
   */
  public async downloadSecurityEventVideo(
    options: {
      homeId: string;
      cameraId?: string;
      eventId?: string;
      videoId?: string;
    },
    chooseSavePath: (suggestedExt: 'ts' | 'mp4') => Promise<string | null>,
    writeTargetFile: (filePath: string, data: Buffer) => Promise<void>,
    onProgress?: (progress: SecurityVideoDownloadProgress) => void
  ): Promise<SecurityDownloadResult> {
    const emitProg = (
      phase: SecurityVideoDownloadProgress['phase'],
      completedSegments: number,
      totalSegments: number,
      bytesDownloaded: number,
      message?: string
    ) => {
      const percent =
        phase === 'writing' || phase === 'done'
          ? 100
          : totalSegments > 0
            ? Math.min(99, Math.round((completedSegments / totalSegments) * 100))
            : 0;
      onProgress?.({
        eventId: options.eventId,
        videoId: options.videoId,
        cameraId: options.cameraId,
        phase,
        completedSegments,
        totalSegments,
        bytesDownloaded,
        percent,
        message,
      });
    };

    emitProg('resolving', 0, 0, 0, 'Resolving camera video stream...');
    const discovered = await this.discoverVideoCandidates(options);
    if (discovered.isDemo) {
      const msg = 'Demo events do not contain a downloadable live video stream.';
      emitProg('error', 0, 0, 0, msg);
      return {
        success: false,
        error: msg,
      };
    }
    if (!discovered.ok || discovered.workingCandidates.length === 0) {
      const msg = discovered.error || 'Video clip is unavailable.';
      emitProg('error', 0, 0, 0, msg);
      return {
        success: false,
        error: msg,
      };
    }

    return this.downloadHlsSegmentsToFile(
      discovered.workingCandidates[0],
      chooseSavePath,
      writeTargetFile,
      emitProg,
      `security video ${options.eventId || options.videoId || ''}`
    );
  }

  /**
   * Discovers and downloads the 24-hour timelapse replay for a supported outdoor camera (Presence / NOC).
   */
  public async downloadCameraReplay(
    options: {
      homeId: string;
      cameraId: string;
      cameraName?: string;
    },
    chooseSavePath: (suggestedExt: 'mp4' | 'ts') => Promise<string | null>,
    writeTargetFile: (filePath: string, data: Buffer) => Promise<void>,
    onProgress?: (progress: SecurityVideoDownloadProgress) => void
  ): Promise<SecurityDownloadResult> {
    const emitProg = (
      phase: SecurityVideoDownloadProgress['phase'],
      completedSegments: number,
      totalSegments: number,
      bytesDownloaded: number,
      message?: string
    ) => {
      const percent =
        phase === 'writing' || phase === 'done'
          ? 100
          : totalSegments > 0
            ? Math.min(99, Math.round((completedSegments / totalSegments) * 100))
            : 0;
      onProgress?.({
        cameraId: options.cameraId,
        phase,
        completedSegments,
        totalSegments,
        bytesDownloaded,
        percent,
        message,
      });
    };

    const sessionData = this.store.getSession();
    if (sessionData.authMethod === 'demo') {
      const msg =
        'Demo mode does not contain recorded 24h camera footage. Sign in with your Netatmo account to download the 24h replay for outdoor cameras.';
      emitProg('error', 0, 0, 0, msg);
      return { success: false, error: msg };
    }

    emitProg('resolving', 0, 0, 0, 'Locating outdoor camera stream endpoints...');
    const { vpnUrl, localUrl } = await this.resolveCameraUrls(
      options.homeId,
      options.cameraId
    );

    if (!vpnUrl && !localUrl) {
      const msg =
        'Netatmo did not expose a camera connection URL (vpn_url / local_url). Video playback requires Netatmo Web Sign-In or OAuth access_presence scopes.';
      emitProg('error', 0, 0, 0, msg);
      return { success: false, error: msg };
    }

    if (localUrl) securityMediaProxy.allowUrlOrigin(localUrl);
    if (vpnUrl) securityMediaProxy.allowUrlOrigin(vpnUrl);

    emitProg(
      'resolving',
      0,
      0,
      0,
      'Requesting 24h timelapse from camera (this can take 1–2 minutes)...'
    );

    const bases: Array<{ base: string; label: 'local' | 'vpn'; isLocal: boolean }> =
      [];
    if (localUrl) bases.push({ base: localUrl, label: 'local', isLocal: true });
    if (vpnUrl) bases.push({ base: vpnUrl, label: 'vpn', isLocal: false });

    const commandErrors: string[] = [];

    // 1. Primary Netatmo Presence/NOC timelapse endpoint: /command/dl/timelapse
    // This endpoint compiles and streams the 24h MP4 directly (can take 1-2 minutes),
    // and should be fetched in a single GET without a Range pre-probe.
    for (const entry of bases) {
      const timelapseUrl = `${entry.base}/command/dl/timelapse`;
      try {
        const res = await this.fetchSecurityMedia({
          url: timelapseUrl,
          responseType: 'arraybuffer',
          timeoutMs: 180_000,
          onProgress: (received, total) => {
            emitProg(
              'downloading',
              received,
              total,
              received,
              'Downloading 24h timelapse...'
            );
          },
        });

        if (res.ok && res.dataBuffer) {
          const buf = Buffer.from(res.dataBuffer);
          const ct = (res.contentType || '').toLowerCase();
          const hasFtyp =
            buf.byteLength >= 12 &&
            buf.subarray(4, 32).includes(Buffer.from('ftyp'));
          const isExplicitNonVideo =
            ct.includes('application/json') ||
            ct.includes('text/html') ||
            ct.includes('text/plain');

          if (
            !isExplicitNonVideo &&
            buf.byteLength > 256 &&
            (hasFtyp ||
              ct.includes('video/') ||
              ct.includes('application/octet-stream'))
          ) {
            const savePath = await chooseSavePath('mp4');
            if (!savePath) {
              emitProg('canceled', 0, 1, 0);
              return { success: false, canceled: true };
            }

            emitProg(
              'writing',
              1,
              1,
              buf.byteLength,
              'Saving 24h timelapse to disk...'
            );
            await writeTargetFile(savePath, buf);
            emitProg('done', 1, 1, buf.byteLength, 'Download complete.');

            debugLogger.log(
              'info',
              'SecurityVideo',
              `Downloaded 24h timelapse (${buf.byteLength} bytes, via ${entry.label}) to ${savePath}`,
              undefined,
              'security'
            );

            return {
              success: true,
              filePath: savePath,
              bytesWritten: buf.byteLength,
              segmentCount: 1,
            };
          }

          const snippet = buf
            .subarray(0, 160)
            .toString('utf8')
            .replace(/\s+/g, ' ')
            .trim();
          commandErrors.push(
            `${entry.label}: non-video response (${ct || 'unknown'}, ${buf.byteLength}B${snippet ? `: ${snippet}` : ''})`
          );
        } else {
          commandErrors.push(
            `${entry.label}: ${res.error || `HTTP ${res.status}`}`
          );
        }
      } catch (err: any) {
        commandErrors.push(`${entry.label}: ${err?.message || String(err)}`);
      }
    }

    // 2. Fallback HLS playlist probe in case firmware serves segmented timelapse
    const hlsCandidates: string[] = [];
    for (const entry of bases) {
      if (entry.isLocal) {
        hlsCandidates.push(
          `${entry.base}/timelapse/index_local.m3u8`,
          `${entry.base}/timelapse/files/high/index_local.m3u8`,
          `${entry.base}/vod/timelapse/index_local.m3u8`
        );
      }
      hlsCandidates.push(
        `${entry.base}/timelapse/index.m3u8`,
        `${entry.base}/timelapse/files/high/index.m3u8`,
        `${entry.base}/vod/timelapse/index.m3u8`
      );
    }

    let workingHlsUrl: string | null = null;
    for (const hlsUrl of hlsCandidates) {
      try {
        const probe = await this.fetchSecurityMedia({
          url: hlsUrl,
          responseType: 'text',
          timeoutMs: 10_000,
        });
        if (probe.ok && probe.dataText?.includes('#EXTM3U')) {
          workingHlsUrl = hlsUrl;
          break;
        }
      } catch {
        // ignore fallback probe failure; keep primary command errors
      }
    }

    if (workingHlsUrl) {
      return this.downloadHlsSegmentsToFile(
        workingHlsUrl,
        chooseSavePath,
        writeTargetFile,
        emitProg,
        `24h replay for outdoor camera ${options.cameraName || options.cameraId}`
      );
    }

    const detail =
      commandErrors.length > 0
        ? commandErrors.join('; ')
        : 'no timelapse endpoint available';
    const msg = `24h timelapse is not available (${detail}). Netatmo outdoor cameras require 24 hours of continuous power, connection, and active monitoring before a 24h replay is available.`;
    emitProg('error', 0, 0, 0, msg);
    return { success: false, error: msg };
  }

  /**
   * Downloads all segments from an HLS media playlist, decrypts AES-128 chunks if present,
   * prompts the user for the save path, and saves the stitched video file to disk.
   */
  private async downloadHlsSegmentsToFile(
    playlistUrl: string,
    chooseSavePath: (suggestedExt: 'ts' | 'mp4') => Promise<string | null>,
    writeTargetFile: (filePath: string, data: Buffer) => Promise<void>,
    emitProg: (
      phase: SecurityVideoDownloadProgress['phase'],
      completedSegments: number,
      totalSegments: number,
      bytesDownloaded: number,
      message?: string
    ) => void,
    logLabel = 'security video'
  ): Promise<SecurityDownloadResult> {
    emitProg('resolving', 0, 0, 0, 'Reading HLS segment playlist...');
    const mediaPlaylistRes = await this.resolveMediaPlaylist(playlistUrl);
    if (!mediaPlaylistRes.ok || !mediaPlaylistRes.text || !mediaPlaylistRes.baseUrl) {
      const msg = mediaPlaylistRes.error || 'Failed to read HLS media playlist.';
      emitProg('error', 0, 0, 0, msg);
      return {
        success: false,
        error: msg,
      };
    }

    const parsedPlaylist = this.parseMediaPlaylist(
      mediaPlaylistRes.text,
      mediaPlaylistRes.baseUrl
    );
    if (parsedPlaylist.segments.length === 0) {
      const msg = 'No video segments found in HLS playlist.';
      emitProg('error', 0, 0, 0, msg);
      return {
        success: false,
        error: msg,
      };
    }

    const savePath = await chooseSavePath(parsedPlaylist.ext);
    if (!savePath) {
      emitProg('canceled', 0, parsedPlaylist.segments.length, 0);
      return { success: false, canceled: true };
    }

    const totalSegments = parsedPlaylist.segments.length;
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    emitProg(
      'downloading',
      0,
      totalSegments,
      0,
      `Downloading 0 / ${totalSegments} segments...`
    );

    if (parsedPlaylist.initMapUrl) {
      const initRes = await this.fetchSecurityMedia({
        url: parsedPlaylist.initMapUrl,
        responseType: 'arraybuffer',
      });
      if (initRes.ok && initRes.dataBuffer) {
        const initBuf = Buffer.from(initRes.dataBuffer);
        totalBytes += initBuf.byteLength;
        chunks.push(initBuf);
      }
    }

    const keyCache = new Map<string, Buffer>();
    let segIndex = 0;

    for (const seg of parsedPlaylist.segments) {
      const res = await this.fetchSecurityMedia({
        url: seg.url,
        responseType: 'arraybuffer',
        rangeStart: seg.rangeStart,
        rangeEnd: seg.rangeEnd,
      });

      if (!res.ok || !res.dataBuffer) {
        const msg = `Failed while downloading segment ${
          segIndex + 1
        }/${totalSegments}: ${res.error || `HTTP ${res.status}`}`;
        emitProg('error', segIndex, totalSegments, totalBytes, msg);
        return {
          success: false,
          error: msg,
        };
      }

      let segBuf: Buffer = Buffer.from(res.dataBuffer);
      if (seg.keyUrl) {
        let keyBuf = keyCache.get(seg.keyUrl);
        if (!keyBuf) {
          const keyRes = await this.fetchSecurityMedia({
            url: seg.keyUrl,
            responseType: 'arraybuffer',
          });
          if (!keyRes.ok || !keyRes.dataBuffer || keyRes.dataBuffer.byteLength !== 16) {
            const msg = 'Failed to fetch HLS decryption key.';
            emitProg('error', segIndex, totalSegments, totalBytes, msg);
            return {
              success: false,
              error: msg,
            };
          }
          keyBuf = Buffer.from(keyRes.dataBuffer);
          keyCache.set(seg.keyUrl, keyBuf);
        }

        const ivBuf = seg.ivHex
          ? Buffer.from(seg.ivHex.replace(/^0x/i, '').padStart(32, '0'), 'hex')
          : (() => {
              const b = Buffer.alloc(16, 0);
              b.writeUInt32BE(parsedPlaylist.mediaSequence + segIndex, 12);
              return b;
            })();

        const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf);
        segBuf = Buffer.concat([decipher.update(segBuf), decipher.final()]);
      }

      chunks.push(segBuf);
      totalBytes += segBuf.byteLength;
      segIndex++;
      emitProg(
        'downloading',
        segIndex,
        totalSegments,
        totalBytes,
        `Downloading segment ${segIndex} / ${totalSegments}`
      );
    }

    emitProg('writing', totalSegments, totalSegments, totalBytes, 'Writing video file...');
    const finalBuffer = Buffer.concat(chunks);
    await writeTargetFile(savePath, finalBuffer);
    emitProg('done', totalSegments, totalSegments, finalBuffer.byteLength, 'Download complete');

    debugLogger.log(
      'info',
      'SecurityVideo',
      `Downloaded ${logLabel} (${totalSegments} segments, ${finalBuffer.byteLength} bytes) to ${savePath}`,
      undefined,
      'security'
    );

    return {
      success: true,
      filePath: savePath,
      bytesWritten: finalBuffer.byteLength,
      segmentCount: totalSegments,
    };
  }

  /** Fetches an HLS master or media playlist and resolves the highest-bandwidth media playlist variant. */
  private async resolveMediaPlaylist(playlistUrl: string): Promise<{
    ok: boolean;
    text?: string;
    baseUrl?: string;
    error?: string;
  }> {
    const res = await this.fetchSecurityMedia({
      url: playlistUrl,
      responseType: 'text',
    });
    if (!res.ok || !res.dataText) {
      return { ok: false, error: res.error || `HTTP ${res.status}` };
    }

    const baseUrl = res.finalUrl || playlistUrl;
    const text = res.dataText;

    if (!text.includes('#EXT-X-STREAM-INF')) {
      return { ok: true, text, baseUrl };
    }

    // Master playlist: select highest-bandwidth variant URL
    const lines = text.split(/\r?\n/);
    let bestUrl: string | null = null;
    let bestBw = -1;
    let pendingBw = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const bwMatch = /BANDWIDTH=(\d+)/i.exec(line);
        pendingBw = bwMatch ? Number(bwMatch[1]) : 0;
      } else if (!line.startsWith('#')) {
        try {
          const abs = new URL(line, baseUrl).toString();
          if (pendingBw > bestBw || !bestUrl) {
            bestBw = pendingBw;
            bestUrl = abs;
          }
        } catch {}
      }
    }

    if (!bestUrl) {
      return { ok: false, error: 'Master HLS playlist has no variant streams.' };
    }

    const levelRes = await this.fetchSecurityMedia({
      url: bestUrl,
      responseType: 'text',
    });
    if (!levelRes.ok || !levelRes.dataText) {
      return { ok: false, error: levelRes.error || `HTTP ${levelRes.status}` };
    }

    return {
      ok: true,
      text: levelRes.dataText,
      baseUrl: levelRes.finalUrl || bestUrl,
    };
  }

  /** Parses an HLS media playlist into initialization map, key/IV, byte-range, and segment entries. */
  private parseMediaPlaylist(
    text: string,
    baseUrl: string
  ): {
    ext: 'ts' | 'mp4';
    mediaSequence: number;
    initMapUrl?: string;
    segments: Array<{
      url: string;
      keyUrl?: string;
      ivHex?: string;
      rangeStart?: number;
      rangeEnd?: number;
    }>;
  } {
    const lines = text.split(/\r?\n/);
    let mediaSequence = 0;
    let initMapUrl: string | undefined;
    let currentKeyUrl: string | undefined;
    let currentIvHex: string | undefined;
    let pendingByteRange: { start: number; end: number } | undefined;
    let lastByteEnd = 0;
    let usesMp4 = false;

    const segments: Array<{
      url: string;
      keyUrl?: string;
      ivHex?: string;
      rangeStart?: number;
      rangeEnd?: number;
    }> = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const val = Number(line.split(':')[1]);
        if (Number.isFinite(val)) mediaSequence = val;
        continue;
      }

      if (line.startsWith('#EXT-X-MAP:')) {
        const uriMatch = /URI="([^"]+)"/i.exec(line);
        if (uriMatch) {
          try {
            initMapUrl = new URL(uriMatch[1], baseUrl).toString();
            usesMp4 = true;
          } catch {}
        }
        continue;
      }

      if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = /METHOD=([A-Z0-9-]+)/i.exec(line);
        const method = methodMatch?.[1]?.toUpperCase();
        if (method === 'NONE') {
          currentKeyUrl = undefined;
          currentIvHex = undefined;
        } else if (method === 'AES-128') {
          const uriMatch = /URI="([^"]+)"/i.exec(line);
          const ivMatch = /IV=([^,\s]+)/i.exec(line);
          if (uriMatch) {
            try {
              currentKeyUrl = new URL(uriMatch[1], baseUrl).toString();
            } catch {}
          }
          currentIvHex = ivMatch?.[1];
        }
        continue;
      }

      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const spec = line.slice('#EXT-X-BYTERANGE:'.length).trim();
        const [lenStr, offStr] = spec.split('@');
        const len = Number(lenStr);
        if (Number.isFinite(len) && len > 0) {
          const start =
            offStr !== undefined && Number.isFinite(Number(offStr))
              ? Number(offStr)
              : lastByteEnd;
          const end = start + len; // exclusive to match fetchSecurityMedia
          lastByteEnd = end;
          pendingByteRange = { start, end };
        }
        continue;
      }

      if (line.startsWith('#')) {
        continue;
      }

      try {
        const absUrl = new URL(line, baseUrl).toString();
        if (/\.(m4s|mp4)(\?|$)/i.test(absUrl)) {
          usesMp4 = true;
        }
        segments.push({
          url: absUrl,
          keyUrl: currentKeyUrl,
          ivHex: currentIvHex,
          rangeStart: pendingByteRange?.start,
          rangeEnd: pendingByteRange?.end,
        });
        pendingByteRange = undefined;
      } catch {}
    }

    return {
      ext: usesMp4 ? 'mp4' : 'ts',
      mediaSequence,
      initMapUrl,
      segments,
    };
  }

  /** Builds synthetic demo cameras, persons, and timeline events when running in demo mode. */
  private getDemoSecurityData(): SecurityDataPayload {
    const now = Math.floor(Date.now() / 1000);
    const homeId = 'demo-home-zurich';
    const homeName = 'Zürich Home (Demo)';

    const cameras: SecurityCamera[] = [
      {
        id: '70:ee:50:aa:11:01',
        homeId,
        homeName,
        name: 'Living Room Welcome',
        type: 'NACamera',
        roomName: 'Living Room',
        monitoring: 'on',
        status: 'on',
        sdStatus: 4,
        alimStatus: 2,
        wifiStrength: 42,
        wifiState: 'full',
        firmwareRevision: 3026000,
        isLocal: true,
      },
      {
        id: '70:ee:50:aa:11:02',
        homeId,
        homeName,
        name: 'Driveway Presence',
        type: 'NOC',
        roomName: 'Driveway',
        monitoring: 'on',
        status: 'on',
        sdStatus: 4,
        alimStatus: 2,
        wifiStrength: 58,
        wifiState: 'good',
        firmwareRevision: 3042000,
        floodlight: 'auto',
        isLocal: false,
      },
      {
        id: '70:ee:50:aa:11:03',
        homeId,
        homeName,
        name: 'Front Doorbell',
        type: 'NDB',
        roomName: 'Entrance',
        monitoring: 'on',
        status: 'on',
        sdStatus: 4,
        alimStatus: 2,
        wifiStrength: 63,
        wifiState: 'average',
        firmwareRevision: 1085000,
        isLocal: false,
      },
    ];

    const persons: SecurityPerson[] = [
      { id: 'p-1', homeId, pseudo: 'Martin', outOfSight: false, lastSeen: now - 1400 },
      { id: 'p-2', homeId, pseudo: 'Dana', outOfSight: true, lastSeen: now - 14400 },
    ];

    const events: SecurityEvent[] = [
      {
        id: 'demo-ev-1',
        homeId,
        homeName,
        cameraId: cameras[1].id,
        cameraName: cameras[1].name,
        type: 'outdoor',
        category: 'vehicle',
        time: now - 420,
        message: 'Car detected in Driveway',
        videoId: 'demo-vid-1',
        videoStatus: 'available',
        subEvents: [
          {
            id: 'demo-sub-1',
            type: 'vehicle',
            time: now - 420,
            message: 'Car detected',
          },
          {
            id: 'demo-sub-2',
            type: 'human',
            time: now - 415,
            message: 'Person seen near vehicle',
          },
        ],
      },
      {
        id: 'demo-ev-2',
        homeId,
        homeName,
        cameraId: cameras[0].id,
        cameraName: cameras[0].name,
        type: 'person',
        category: 'human',
        time: now - 1400,
        message: 'Martin was seen by Living Room Welcome',
        personId: 'p-1',
        personName: 'Martin',
        videoId: 'demo-vid-2',
        videoStatus: 'available',
      },
      {
        id: 'demo-ev-3',
        homeId,
        homeName,
        cameraId: cameras[2].id,
        cameraName: cameras[2].name,
        type: 'incoming_call',
        time: now - 5400,
        message: 'Someone rang at Front Doorbell',
        videoId: 'demo-vid-3',
        videoStatus: 'available',
      },
      {
        id: 'demo-ev-4',
        homeId,
        homeName,
        cameraId: cameras[1].id,
        cameraName: cameras[1].name,
        type: 'outdoor',
        category: 'animal',
        time: now - 18900,
        message: 'Animal detected in Driveway',
        videoId: 'demo-vid-4',
        videoStatus: 'available',
        subEvents: [
          {
            id: 'demo-sub-3',
            type: 'animal',
            time: now - 18900,
            message: 'Animal detected',
          },
        ],
      },
      {
        id: 'demo-ev-5',
        homeId,
        homeName,
        cameraId: cameras[0].id,
        cameraName: cameras[0].name,
        type: 'movement',
        time: now - 36000,
        message: 'Motion detected by Living Room Welcome',
        videoId: 'demo-vid-5',
        videoStatus: 'available',
      },
    ];

    return {
      homes: [
        {
          id: homeId,
          name: homeName,
          timezone: 'Europe/Zurich',
          cameras,
          persons,
        },
      ],
      events,
      fetchedAt: Date.now(),
    };
  }
}
