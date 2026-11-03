import { app, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  AccountInfo,
  PinnedSensorItem,
  SessionData,
  UserSettings,
  WeatherStation,
} from '../renderer/types';

const DPAPI_PREFIX = 'dpapi:';

async function encryptSecretAsync(plain?: string): Promise<string | undefined> {
  if (!plain) return undefined;
  if (plain.startsWith(DPAPI_PREFIX)) return plain;
  try {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
      const isAvail = await safeStorage.isAsyncEncryptionAvailable();
      if (isAvail && typeof safeStorage.encryptStringAsync === 'function') {
        const buf = await safeStorage.encryptStringAsync(plain);
        return DPAPI_PREFIX + buf.toString('base64');
      }
    }
  } catch {}
  return plain;
}

async function decryptSecretAsync(stored?: string): Promise<string | undefined> {
  if (!stored) return undefined;
  if (!stored.startsWith(DPAPI_PREFIX)) return stored;
  try {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
      const isAvail = await safeStorage.isAsyncEncryptionAvailable();
      if (isAvail && typeof safeStorage.decryptStringAsync === 'function') {
        const buf = Buffer.from(stored.slice(DPAPI_PREFIX.length), 'base64');
        const res = await safeStorage.decryptStringAsync(buf);
        if (typeof res === 'string') return res;
        if (res && typeof (res as any).result === 'string') return (res as any).result;
      }
    }
  } catch {}
  return undefined;
}

interface PersistedState {
  settings: UserSettings;
  session: SessionData;
  cachedStations: WeatherStation[];
  lastSyncAt?: number;
}

const DEFAULT_SETTINGS: UserSettings = {
  historyDays: 14, // Default 14 days as requested
  historyMaxMode: false, // Can be toggled in settings to load up to Netatmo's maximum (since station setup)
  defaultScale: '30min',
  refreshIntervalMinutes: 5,
  temperatureUnit: 'C',
  pressureUnit: 'mbar',
  windUnit: 'kph',
  rainUnit: 'mm',
  theme: 'fluent-dark',
  widgetEnabled: false,
  widgetAlwaysOnTop: true,
  widgetLocked: false,
  widgetOpacity: 0.94,
  widgetCompact: false,
  pinnedSensors: [],
  taskbarDisplayMode: 'sensor',
  taskbarSensorTarget: 'outdoor_temp',
  minimizeToTray: true,
  launchOnStartup: false,
};

const DEFAULT_SESSION: SessionData = {
  loggedIn: false,
  authMethod: 'web',
  cookies: [],
};

export class AppStore {
  private filePath: string;
  private state: PersistedState;
  private saveTimeout: NodeJS.Timeout | null = null;
  private isSaving = false;
  private saveQueued = false;
  private cachedEncryptedSecrets: {
    plainAccessToken?: string;
    encAccessToken?: string;
    plainRefreshToken?: string;
    encRefreshToken?: string;
    plainOauthSecret?: string;
    encOauthSecret?: string;
  } = {};
  private cachedEncryptedCookies?: any[];

  constructor() {
    const userDataDir = app.getPath('userData');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    this.filePath = path.join(userDataDir, 'winatmo-config.json');
    this.state = this.load();
  }

  public async init(): Promise<void> {
    await this.decryptLoadedState();
  }

  private async decryptLoadedState(): Promise<void> {
    try {
      if (this.state.settings.oauthClientSecret) {
        this.cachedEncryptedSecrets.encOauthSecret =
          this.state.settings.oauthClientSecret;
        this.state.settings.oauthClientSecret = await decryptSecretAsync(
          this.state.settings.oauthClientSecret
        );
        this.cachedEncryptedSecrets.plainOauthSecret =
          this.state.settings.oauthClientSecret;
      }
      if (this.state.session.accessToken) {
        this.cachedEncryptedSecrets.encAccessToken =
          this.state.session.accessToken;
        this.state.session.accessToken = await decryptSecretAsync(
          this.state.session.accessToken
        );
        this.cachedEncryptedSecrets.plainAccessToken =
          this.state.session.accessToken;
      }
      if (this.state.session.refreshToken) {
        this.cachedEncryptedSecrets.encRefreshToken =
          this.state.session.refreshToken;
        this.state.session.refreshToken = await decryptSecretAsync(
          this.state.session.refreshToken
        );
        this.cachedEncryptedSecrets.plainRefreshToken =
          this.state.session.refreshToken;
      }
      if (Array.isArray(this.state.session.cookies)) {
        this.cachedEncryptedCookies = this.state.session.cookies;
        this.state.session.cookies = await Promise.all(
          this.state.session.cookies.map(async (c: any) => ({
            ...c,
            value: (await decryptSecretAsync(c.value)) || '',
          }))
        );
      }
    } catch (err) {
      console.warn('[AppStore] Failed to decrypt secrets:', err);
    }
  }

  private load(): PersistedState {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        const rawStations: WeatherStation[] = Array.isArray(
          parsed.cachedStations
        )
          ? parsed.cachedStations
          : [];
        const normalizedStations = this.normalizeStations(rawStations);
        const settings: UserSettings = {
          ...DEFAULT_SETTINGS,
          ...(parsed.settings || {}),
        };

        const rawSession = { ...DEFAULT_SESSION, ...(parsed.session || {}) };

        if (normalizedStations.length > 0 && settings.pinnedSensors?.length) {
          const primaryHome = normalizedStations[0];
          settings.pinnedSensors = settings.pinnedSensors.map((pin) => {
            const mod = primaryHome.modules.find((m) => m.id === pin.moduleId);
            if (mod) {
              return {
                ...pin,
                id: `${primaryHome.id}::${mod.id}::${pin.metric}`,
                stationId: primaryHome.id,
                stationName: primaryHome.stationName,
                moduleName: mod.moduleName,
              };
            }
            return pin;
          });
        }
        return {
          settings,
          session: rawSession,
          cachedStations: normalizedStations,
          lastSyncAt: parsed.lastSyncAt,
        };
      }
    } catch (err) {
      console.warn('[AppStore] Failed to load state, using defaults:', err);
    }
    return {
      settings: { ...DEFAULT_SETTINGS },
      session: { ...DEFAULT_SESSION },
      cachedStations: [],
    };
  }

  private save(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveAsync().catch((err) =>
        console.error('[AppStore] Failed to save state:', err)
      );
    }, 50);
  }

  public async saveAsync(): Promise<void> {
    if (this.isSaving) {
      this.saveQueued = true;
      return;
    }
    this.isSaving = true;
    try {
      const sessionSnapshot = { ...this.state.session };
      const settingsSnapshot = { ...this.state.settings };

      // Encrypt accessToken if changed
      let encAccessToken: string | undefined = this.cachedEncryptedSecrets.encAccessToken;
      if (sessionSnapshot.accessToken !== this.cachedEncryptedSecrets.plainAccessToken) {
        encAccessToken = await encryptSecretAsync(sessionSnapshot.accessToken);
        this.cachedEncryptedSecrets.plainAccessToken = sessionSnapshot.accessToken;
        this.cachedEncryptedSecrets.encAccessToken = encAccessToken;
      }

      // Encrypt refreshToken if changed
      let encRefreshToken: string | undefined = this.cachedEncryptedSecrets.encRefreshToken;
      if (sessionSnapshot.refreshToken !== this.cachedEncryptedSecrets.plainRefreshToken) {
        encRefreshToken = await encryptSecretAsync(sessionSnapshot.refreshToken);
        this.cachedEncryptedSecrets.plainRefreshToken = sessionSnapshot.refreshToken;
        this.cachedEncryptedSecrets.encRefreshToken = encRefreshToken;
      }

      // Encrypt oauthClientSecret if changed
      let encOauthSecret: string | undefined = this.cachedEncryptedSecrets.encOauthSecret;
      if (settingsSnapshot.oauthClientSecret !== this.cachedEncryptedSecrets.plainOauthSecret) {
        encOauthSecret = await encryptSecretAsync(settingsSnapshot.oauthClientSecret);
        this.cachedEncryptedSecrets.plainOauthSecret = settingsSnapshot.oauthClientSecret;
        this.cachedEncryptedSecrets.encOauthSecret = encOauthSecret;
      }

      const encCookies = await Promise.all(
        (sessionSnapshot.cookies || []).map(async (c) => ({
          ...c,
          value: (await encryptSecretAsync(c.value)) || '',
        }))
      );
      this.cachedEncryptedCookies = encCookies;

      const diskState: PersistedState = {
        ...this.state,
        settings: {
          ...settingsSnapshot,
          oauthClientSecret: encOauthSecret,
        },
        session: {
          ...sessionSnapshot,
          accessToken: encAccessToken,
          refreshToken: encRefreshToken,
          cookies: encCookies,
        },
      };

      await fs.promises.writeFile(
        this.filePath,
        JSON.stringify(diskState, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('[AppStore] Failed to save state asynchronously:', err);
    } finally {
      this.isSaving = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        this.save();
      }
    }
  }

  public flushSync(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    try {
      const diskState: PersistedState = {
        ...this.state,
        settings: {
          ...this.state.settings,
          oauthClientSecret:
            this.cachedEncryptedSecrets.encOauthSecret ||
            this.state.settings.oauthClientSecret,
        },
        session: {
          ...this.state.session,
          accessToken:
            this.cachedEncryptedSecrets.encAccessToken ||
            this.state.session.accessToken,
          refreshToken:
            this.cachedEncryptedSecrets.encRefreshToken ||
            this.state.session.refreshToken,
          cookies: this.cachedEncryptedCookies || this.state.session.cookies,
        },
      };
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(diskState, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('[AppStore] Failed to flush state synchronously:', err);
    }
  }

  public getSettings(): UserSettings {
    return { ...this.state.settings };
  }

  public updateSettings(partial: Partial<UserSettings>): UserSettings {
    this.state.settings = {
      ...this.state.settings,
      ...partial,
    };
    this.save();
    return this.getSettings();
  }

  public getSession(): SessionData {
    return { ...this.state.session };
  }

  public updateSession(partial: Partial<SessionData>): SessionData {
    this.state.session = {
      ...this.state.session,
      ...partial,
    };
    this.save();
    return this.getSession();
  }

  public clearSession(): void {
    this.cachedEncryptedSecrets = {};
    this.cachedEncryptedCookies = undefined;
    this.state.session = { ...DEFAULT_SESSION };
    this.state.cachedStations = [];
    this.state.lastSyncAt = undefined;
    this.save();
  }

  public getAccountInfo(): AccountInfo {
    const s = this.state.session;
    return {
      loggedIn: s.loggedIn,
      email: s.email,
      userId: s.userId,
      authMethod: s.authMethod,
      country: s.country,
      locale: s.locale,
      tokenExpiresAt: s.expiresAt,
    };
  }

  /**
   * Ensures any NHC Air Quality sensors are grouped into the primary Weather Station Home
   * and use their room name instead of "Indoor".
   */
  private normalizeStations(stations: WeatherStation[]): WeatherStation[] {
    if (!Array.isArray(stations) || stations.length === 0) return [];

    const primaryHome = stations.find((s) => s.type !== 'NHC') || stations[0];
    const result: WeatherStation[] = [];

    for (const st of stations) {
      if (st.type === 'NHC' && st.id !== primaryHome.id) {
        for (const mod of st.modules) {
          const roomName = (
            st.stationName ||
            st.homeName ||
            (mod.moduleName &&
            mod.moduleName.trim().toLowerCase() !== 'indoor'
              ? mod.moduleName
              : '') ||
            'Air Quality'
          ).trim();

          const normalizedMod = {
            ...mod,
            stationId: primaryHome.id,
            stationName: primaryHome.stationName,
            homeName: primaryHome.homeName,
            moduleName: roomName,
          };

          const existingIdx = primaryHome.modules.findIndex(
            (m) => m.id === normalizedMod.id
          );
          if (existingIdx >= 0) {
            primaryHome.modules[existingIdx] = normalizedMod;
          } else {
            primaryHome.modules.push(normalizedMod);
          }
        }
      } else {
        // Also normalize any NHC modules already inside primaryHome
        st.modules = st.modules.map((mod) => {
          if (
            mod.type === 'NHC' &&
            mod.moduleName.trim().toLowerCase() === 'indoor'
          ) {
            return {
              ...mod,
              moduleName: (st.stationName || st.homeName || 'Air Quality').trim(),
            };
          }
          return {
            ...mod,
            moduleName: mod.moduleName.trim(),
          };
        });
        result.push(st);
      }
    }

    return result;
  }

  public getCachedStations(): WeatherStation[] {
    return this.state.cachedStations || [];
  }

  public setCachedStations(stations: WeatherStation[]): void {
    const normalized = this.normalizeStations(stations);
    this.state.cachedStations = normalized;
    this.state.lastSyncAt = Math.floor(Date.now() / 1000);

    // If user has no pinned sensors yet, auto-pin the most useful default sensors
    if (
      this.state.settings.pinnedSensors.length === 0 &&
      normalized.length > 0
    ) {
      const defaults: PinnedSensorItem[] = [];
      for (const st of normalized) {
        // Outdoor temperature first if available
        const outdoor = st.modules.find((m) => m.type === 'NAModule1');
        if (outdoor && outdoor.availableMetrics.includes('temperature')) {
          defaults.push({
            id: `${st.id}::${outdoor.id}::temperature`,
            stationId: st.id,
            moduleId: outdoor.id,
            moduleName: outdoor.moduleName,
            stationName: st.stationName,
            metric: 'temperature',
            color: '#38bdf8',
          });
        }
        // Main indoor temperature and CO2
        const mainMod = st.modules.find(
          (m) => m.type === 'NAMain' || m.type === 'NHC'
        );
        if (mainMod) {
          if (mainMod.availableMetrics.includes('temperature')) {
            defaults.push({
              id: `${st.id}::${mainMod.id}::temperature`,
              stationId: st.id,
              moduleId: mainMod.id,
              moduleName: mainMod.moduleName,
              stationName: st.stationName,
              metric: 'temperature',
              color: '#f59e0b',
            });
          }
          if (mainMod.availableMetrics.includes('co2')) {
            defaults.push({
              id: `${st.id}::${mainMod.id}::co2`,
              stationId: st.id,
              moduleId: mainMod.id,
              moduleName: mainMod.moduleName,
              stationName: st.stationName,
              metric: 'co2',
              color: '#10b981',
            });
          }
        }
        // Rain or Wind if present
        const rain = st.modules.find((m) => m.type === 'NAModule3');
        if (rain && rain.availableMetrics.includes('rain')) {
          defaults.push({
            id: `${st.id}::${rain.id}::rain`,
            stationId: st.id,
            moduleId: rain.id,
            moduleName: rain.moduleName,
            stationName: st.stationName,
            metric: 'rain',
            color: '#60a5fa',
          });
        }
        if (defaults.length >= 4) break;
      }
      if (defaults.length > 0) {
        this.state.settings.pinnedSensors = defaults.slice(0, 4);
      }
    }

    this.save();
  }

  public getLastSyncAt(): number | undefined {
    return this.state.lastSyncAt;
  }
}
