import { AppStore } from './store';
import { TimeSeriesDatabase, BatchMeasurementRow } from './database';
import { debugLogger } from './debugLogger';
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
  SecurityEvent,
  SecurityEventImageRefreshResult,
  SecurityEventVideoResult,
  SecurityHome,
  SecurityMediaFetchResult,
  SecurityPerson,
  SecuritySubEvent,
  StationModule,
  StoredCookie,
  SyncProgress,
  WeatherStation,
} from '../renderer/types';

export class NetatmoClient {
  private store: AppStore;
  private db: TimeSeriesDatabase;
  private silentRefreshCallback?: () => Promise<string | null>;
  private onProgressCallback?: (progress: SyncProgress) => void;
  private onQueryStatusCallback?: (status: MeasureQueryStatus) => void;
  private onAccountUpdatedCallback?: (account: AccountInfo) => void;
  private isSyncing = false;
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

  public setAccountUpdatedHandler(cb: (account: AccountInfo) => void): void {
    this.onAccountUpdatedCallback = cb;
  }

  public setSilentRefreshHandler(fn: () => Promise<string | null>): void {
    this.silentRefreshCallback = fn;
  }

  public setProgressHandler(fn: (progress: SyncProgress) => void): void {
    this.onProgressCallback = fn;
  }

  public setQueryStatusHandler(fn: (status: MeasureQueryStatus) => void): void {
    this.onQueryStatusCallback = fn;
  }

  public getSyncProgress(): SyncProgress {
    return { ...this.currentProgress };
  }

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

            if (clientId && clientSecret) {
              await this.store.saveApiKeys({
                clientId,
                clientSecret,
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
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          }).toString(),
        });

        const rawText = await res.text();
        const tokenDuration = Math.max(1, Math.round(performance.now() - tokenStart));
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
          rawBody: rawText,
          error: res.ok ? undefined : data?.error || `HTTP ${res.status}`,
          note: 'OAuth2 refresh_token',
        });

        if (res.ok && data?.access_token) {
          const newExpiresAt = now + (Number(data.expires_in) || 10800);
          const newRefreshToken = data.refresh_token || session.refreshToken;

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
        const tokenDuration = Math.max(1, Math.round(performance.now() - tokenStart));
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
        console.warn('[NetatmoClient] OAuth token refresh network error:', err);
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
  }

  /**
   * Executes an authenticated GET request against Netatmo API with automatic fallback
   * between `app.netatmo.net` and `api.netatmo.com` and automatic token refresh on 401/403.
   */
  private async apiGet(
    endpoint: string,
    params: Record<string, string | number | boolean | undefined> = {},
    retried = false,
    requestNote?: string
  ): Promise<any> {
    const token = await this.ensureAccessToken(false);
    const session = this.store.getSession();

    const preferredBase = session.apiBase || 'api.netatmo.com';
    const fallbackBase =
      preferredBase === 'api.netatmo.com'
        ? 'app.netatmo.net'
        : 'api.netatmo.com';

    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
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
        res = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(20000),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
          },
        });
      } catch (netErr: any) {
        lastNetworkErr = netErr;
        const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
        debugLogger.recordApiRequest({
          method: 'GET',
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
          `GET /${endpoint} failed on ${base} (${netErr?.code || netErr?.message}), trying fallback...`
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
          method: 'GET',
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
            return this.apiGet(endpoint, params, true, requestNote);
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
          method: 'GET',
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
          return this.apiGet(endpoint, params, true, requestNote);
        }
        throw new Error(
          'Netatmo API rate limit reached. Please wait a moment before syncing again.'
        );
      }

      if (res.ok && parsedJson) {
        debugLogger.recordApiRequest({
          method: 'GET',
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
        method: 'GET',
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

  /**
   * Fetches all Weather Stations and Healthy Home Coach devices from the user's Netatmo account.
   */
  public async fetchStations(): Promise<WeatherStation[]> {
    const session = this.store.getSession();
    if (session.authMethod === 'demo') {
      return this.store.getCachedStations();
    }

    const stationsData = await this.apiGet('getstationsdata', {
      get_favorites: true,
    });

    const stations = this.parseStationsPayload(stationsData);

    // Also try fetching Healthy Home Coach (Aircare) devices if any exist on the account
    try {
      const coachData = await this.apiGet('gethomecoachsdata');
      this.mergeHomeCoachPayload(stations, coachData);
    } catch {
      // Optional scope/device type; ignore if account has no Home Coach
    }

    // Update user email/locale if present in payload
    const user = stationsData?.body?.user;
    if (user?.mail) {
      this.store.updateSession({
        email: user.mail,
        country: user.administrative?.country,
        locale: user.administrative?.reg_locale || user.administrative?.lang,
      });
    }

    this.store.setCachedStations(stations);
    this.ingestDashboardSnapshot(stations);
    return stations;
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

      const stations = await this.fetchStations();

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
          // 2. Fetch forward delta from coverage.maxTs to now
          if (now > coverage.maxTs + stepSeconds / 2) {
            windowsToFetch.push({
              begin: Math.max(requestedBegin, coverage.maxTs - stepSeconds),
              end: now,
            });
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
        optimize: false,
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

    // Determine upfront whether this query requires remote Netatmo Cloud API requests or is served 100% from local SQLite
    let willHitApi = false;
    if (session.loggedIn && session.authMethod !== 'demo') {
      for (const [, group] of byModule.entries()) {
        const sample = group[0];
        const st = stations.find((s) => s.id === sample.stationId);
        const mod = st?.modules.find((m) => m.id === sample.moduleId);
        if (mod) {
          const coverage = this.db.getSyncCoverage(mod.id, req.scale);
          const stepSec = this.db.getScaleSeconds(req.scale);
          const effectiveBegin = Math.max(req.dateBegin, st?.dateSetup || mod.dateSetup || 0);
          const spanSec = Math.max(0, req.dateEnd - effectiveBegin);
          const expectedPoints = Math.max(1, Math.floor(spanSec / stepSec));

          const needsBackfill =
            !coverage || req.dateBegin < coverage.minTs - stepSec * 4;
          const needsForward =
            !coverage || req.dateEnd > coverage.maxTs + stepSec * 2;
          const existingPoints = this.db.queryPoints(
            mod.id,
            sample.metric,
            req.scale,
            req.dateBegin,
            req.dateEnd
          );

          const hasZeroPoints = existingPoints.length === 0;
          const hasSparsePoints = existingPoints.length < expectedPoints * 0.7;
          const hasGapAtStart =
            existingPoints.length > 0 &&
            existingPoints[0].ts > effectiveBegin + stepSec * 3;
          const hasGapAtEnd =
            existingPoints.length > 0 &&
            existingPoints[existingPoints.length - 1].ts < req.dateEnd - stepSec * 3;
          const isMissingData =
            hasZeroPoints || hasSparsePoints || hasGapAtStart || hasGapAtEnd;

          if (req.forceRemoteFetch || needsBackfill || needsForward || isMissingData) {
            willHitApi = true;
            break;
          }
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
        const coverage = this.db.getSyncCoverage(mod.id, req.scale);
        const stepSec = this.db.getScaleSeconds(req.scale);
        const effectiveBegin = Math.max(req.dateBegin, st?.dateSetup || mod.dateSetup || 0);
        const spanSec = Math.max(0, req.dateEnd - effectiveBegin);
        const expectedPoints = Math.max(1, Math.floor(spanSec / stepSec));

        const needsBackfill =
          !coverage || req.dateBegin < coverage.minTs - stepSec * 4;
        const needsForward =
          !coverage || req.dateEnd > coverage.maxTs + stepSec * 2;
        const existingPoints = this.db.queryPoints(
          mod.id,
          sample.metric,
          req.scale,
          req.dateBegin,
          req.dateEnd
        );

        const hasZeroPoints = existingPoints.length === 0;
        const hasSparsePoints = existingPoints.length < expectedPoints * 0.7;
        const hasGapAtStart =
          existingPoints.length > 0 &&
          existingPoints[0].ts > effectiveBegin + stepSec * 3;
        const hasGapAtEnd =
          existingPoints.length > 0 &&
          existingPoints[existingPoints.length - 1].ts < req.dateEnd - stepSec * 3;
        const isMissingData =
          hasZeroPoints || hasSparsePoints || hasGapAtStart || hasGapAtEnd;

        if (req.forceRemoteFetch || needsBackfill || needsForward || isMissingData) {
          try {
            const fetchBegin =
              !req.forceRemoteFetch && coverage && !needsBackfill && !isMissingData
                ? Math.max(req.dateBegin, coverage.maxTs - stepSec)
                : req.dateBegin;
            await this.fetchAndStoreModuleWindow(
              sample.stationId,
              mod,
              req.scale,
              fetchBegin,
              req.dateEnd
            );
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
        let points = this.db.queryPoints(
          item.moduleId,
          item.metric,
          req.scale,
          req.dateBegin,
          req.dateEnd
        );

        // Fail-safe: If points are still completely empty after primary sync, do an immediate direct window fetch
        if (
          points.length === 0 &&
          mod &&
          session.loggedIn &&
          session.authMethod !== 'demo' &&
          !didFetchForModule &&
          !authFailed
        ) {
          try {
            await this.fetchAndStoreModuleWindow(
              sample.stationId,
              mod,
              req.scale,
              req.dateBegin,
              req.dateEnd
            );
            didFetchForModule = true;
            points = this.db.queryPoints(
              item.moduleId,
              item.metric,
              req.scale,
              req.dateBegin,
              req.dateEnd
            );
          } catch (err: any) {
            if (
              err?.message?.includes('session expired') ||
              err?.message?.includes('authentication failed')
            ) {
              authFailed = true;
            }
          }
        }

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
      return pic.url.trim();
    }
    if (pic.id && pic.key) {
      return `https://api.netatmo.com/api/getcamerapicture?image_id=${encodeURIComponent(
        String(pic.id)
      )}&key=${encodeURIComponent(String(pic.key))}`;
    }
    return undefined;
  }

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
   * Fetches Netatmo Security homes, live camera hardware status, and event timeline.
   */
  public async fetchSecurityData(options?: {
    homeId?: string;
    size?: number;
    offsetEventId?: string;
  }): Promise<SecurityDataPayload> {
    const session = this.store.getSession();
    if (!session.loggedIn) {
      return { homes: [], events: [], fetchedAt: Date.now() };
    }

    if (session.authMethod === 'demo') {
      return this.getDemoSecurityData();
    }

    const size = options?.size ?? 40;
    const homes: SecurityHome[] = [];
    const allEvents: SecurityEvent[] = [];
    const cameraNamesById = new Map<string, string>();
    const personsById = new Map<string, string>();

    try {
      const homesResp = await this.apiGet(
        'homesdata',
        {},
        false,
        'Security: discover homes & cameras'
      );
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

        const persons: SecurityPerson[] = (Array.isArray(h.persons) ? h.persons : []).map(
          (p: any) => {
            const pid = String(p.id);
            const pname = p.pseudo ? String(p.pseudo) : undefined;
            if (pname) personsById.set(pid, pname);
            return {
              id: pid,
              homeId,
              pseudo: pname,
              outOfSight: p.out_of_sight,
              lastSeen: p.last_seen,
              faceUrl: p.face?.url,
            };
          }
        );

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
            roomName: m.room_id ? roomNamesById.get(String(m.room_id)) : undefined,
            lastSetup: m.setup_date,
          });
        }

        if (cameras.length > 0) {
          // Fetch live camera status via /api/homestatus
          try {
            const statusResp = await this.apiGet(
              'homestatus',
              { home_id: homeId },
              false,
              `Security status: ${homeName}`
            );
            const statusModules: any[] = Array.isArray(statusResp?.body?.home?.modules)
              ? statusResp.body.home.modules
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
                  cam.vpnUrl = String(sm.vpn_url);
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

          // Fetch event list via /api/getevents
          try {
            const eventsResp = await this.apiGet(
              'getevents',
              {
                home_id: homeId,
                size,
                event_id: options?.offsetEventId,
              },
              false,
              `Security events: ${homeName} (size=${size})`
            );
            const rawEvents: any[] =
              eventsResp?.body?.home?.events ||
              eventsResp?.body?.events ||
              [];
            for (const ev of rawEvents) {
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
            const persons: SecurityPerson[] = (Array.isArray(lh.persons) ? lh.persons : []).map(
              (p: any) => {
                const pid = String(p.id);
                const pname = p.pseudo ? String(p.pseudo) : undefined;
                if (pname) personsById.set(pid, pname);
                return {
                  id: pid,
                  homeId,
                  pseudo: pname,
                  outOfSight: p.out_of_sight,
                  lastSeen: p.last_seen,
                  faceUrl: p.face?.url,
                };
              }
            );
            const cameras: SecurityCamera[] = (Array.isArray(lh.cameras) ? lh.cameras : []).map(
              (c: any) => {
                const cid = String(c.id);
                const cname = String(c.name || c.type || cid);
                cameraNamesById.set(cid, cname);
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
                  vpnUrl: c.vpn_url ? String(c.vpn_url) : undefined,
                };
              }
            );
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

      allEvents.sort((a, b) => b.time - a.time);

      return {
        homes,
        events: allEvents,
        fetchedAt: Date.now(),
      };
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
  }

  /**
   * Fetches binary or text media (images, HLS playlists, TS segments) through Node so
   * Netatmo CDN URLs and local camera LAN URLs work without renderer CORS or mixed-content blocks.
   */
  public async fetchSecurityMedia(req: {
    url: string;
    responseType?: 'text' | 'arraybuffer';
    headers?: Record<string, string>;
    rangeStart?: number;
    rangeEnd?: number;
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

    const headers: Record<string, string> = { ...(req.headers || {}) };
    if (req.rangeStart !== undefined) {
      headers['Range'] = `bytes=${req.rangeStart}-${
        req.rangeEnd !== undefined ? req.rangeEnd : ''
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

    try {
      const res = await fetch(parsed.toString(), {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });

      const finalUrl = res.url || parsed.toString();
      const contentType = res.headers.get('content-type') || undefined;

      if (!res.ok) {
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
        return {
          ok: true,
          status: res.status,
          statusText: res.statusText || 'OK',
          finalUrl,
          contentType,
          dataText,
        };
      }

      const buf = await res.arrayBuffer();
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText || 'OK',
        finalUrl,
        contentType,
        dataBuffer: new Uint8Array(buf),
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      debugLogger.log('warn', 'Security', `Media fetch failed (${parsed.host}): ${msg}`);
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
   * Resolves the freshest cloud `vpn_url` (and optional LAN `local_url`) for a camera.
   */
  private async resolveCameraUrls(
    homeId: string,
    cameraId: string
  ): Promise<{ vpnUrl?: string; localUrl?: string; isLocal?: boolean }> {
    let vpnUrl: string | undefined;
    let isLocal = false;

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

    let localUrl: string | undefined;
    if (vpnUrl && isLocal) {
      try {
        const pingRes = await fetch(`${vpnUrl}/command/ping`, {
          method: 'GET',
          signal: AbortSignal.timeout(2200),
        });
        if (pingRes.ok) {
          const pingJson: any = await pingRes.json();
          if (typeof pingJson?.local_url === 'string' && pingJson.local_url.startsWith('http')) {
            localUrl = pingJson.local_url.replace(/\/+$/, '');
          }
        }
      } catch {
        // LAN ping is best-effort; fallback to cloud vpnUrl cleanly
      }
    }

    return { vpnUrl, localUrl, isLocal };
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
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="320" cy="155" r="44" fill="#38bdf8" fill-opacity="0.18" stroke="#38bdf8" stroke-width="2"/><path d="M304 147h22l10-6v28l-10-6h-22z" fill="#38bdf8"/><text x="320" y="232" text-anchor="middle" fill="#f8fafc" font-family="Segoe UI,sans-serif" font-size="18" font-weight="600">Demo Camera Snapshot</text><text x="320" y="258" text-anchor="middle" fill="#94a3b8" font-family="Segoe UI,sans-serif" font-size="13">Event ${options.eventId} • Refreshed preview</text></svg>`;
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
      return { ok: true, imageUrl: dataUrl, vignetteUrl: dataUrl };
    }

    let refreshedEvent: SecurityEvent | undefined;
    try {
      const homeData = await this.apiGet(
        'homesdata',
        {},
        false,
        `Security image refresh home lookup`
      );
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
    const pushUrl = (u?: string) => {
      if (u && u.trim() && !candidates.includes(u.trim())) {
        candidates.push(u.trim());
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
    for (const u of options.candidateUrls || []) {
      pushUrl(u);
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

    for (const url of candidates) {
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
        return {
          ok: true,
          imageUrl: dataUrl,
          vignetteUrl: dataUrl,
          snapshotExpiresAt: refreshedEvent?.snapshotExpiresAt,
          event: refreshedEvent
            ? {
                ...refreshedEvent,
                snapshotUrl: dataUrl,
              }
            : undefined,
        };
      }
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
   * Resolves the playable HLS stream URL (`{vpn_url}/vod/{video_id}/index.m3u8`) for an event video.
   */
  public async getSecurityEventVideo(options: {
    homeId: string;
    cameraId?: string;
    eventId?: string;
    videoId?: string;
  }): Promise<SecurityEventVideoResult> {
    const session = this.store.getSession();
    if (!session.loggedIn) {
      return { ok: false, error: 'Not signed in to Netatmo.' };
    }

    if (session.authMethod === 'demo') {
      return { ok: true, isDemo: true };
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
        error: 'No recorded video ID is associated with this event.',
      };
    }

    if (!options.cameraId) {
      return {
        ok: false,
        error: 'Camera ID is missing for this event.',
      };
    }

    const { vpnUrl, localUrl } = await this.resolveCameraUrls(
      options.homeId,
      options.cameraId
    );

    if (!vpnUrl && !localUrl) {
      return {
        ok: false,
        needsAccessScope: true,
        error:
          'Netatmo did not expose a camera stream URL (vpn_url). Video playback requires Netatmo Web Sign-In or OAuth access_camera / access_presence scopes.',
      };
    }

    const candidates: string[] = [];
    if (localUrl) {
      candidates.push(`${localUrl}/vod/${encodeURIComponent(videoId)}/index_local.m3u8`);
      candidates.push(
        `${localUrl}/vod/${encodeURIComponent(videoId)}/files/high/index_local.m3u8`
      );
    }
    if (vpnUrl) {
      candidates.push(`${vpnUrl}/vod/${encodeURIComponent(videoId)}/index.m3u8`);
      candidates.push(
        `${vpnUrl}/vod/${encodeURIComponent(videoId)}/files/high/index.m3u8`
      );
    }

    let workingUrl: string | undefined;
    let lastError: string | undefined;
    for (const candidate of candidates) {
      const probe = await this.fetchSecurityMedia({
        url: candidate,
        responseType: 'text',
      });
      if (probe.ok && probe.dataText && probe.dataText.includes('#EXTM3U')) {
        workingUrl = candidate;
        break;
      }
      lastError = probe.error || `HTTP ${probe.status}`;
    }

    const fallbackHlsUrls = candidates.filter((u) => u !== workingUrl);

    if (!workingUrl) {
      return {
        ok: false,
        vpnUrl,
        localUrl,
        fallbackHlsUrls: candidates,
        error: `Recorded video clip could not be opened (${
          lastError || 'unavailable on camera SD card or expired'
        }).`,
      };
    }

    return {
      ok: true,
      hlsUrl: workingUrl,
      localHlsUrl: localUrl
        ? `${localUrl}/vod/${encodeURIComponent(videoId)}/index_local.m3u8`
        : undefined,
      fallbackHlsUrls,
      vpnUrl,
      localUrl,
    };
  }

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
