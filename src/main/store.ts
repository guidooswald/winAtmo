import { app, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  AccountInfo,
  PinnedSensorItem,
  SessionData,
  StoredApiKeysInfo,
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
  storeApiKeysLocally: false,
  autoUpdateTokens: true,
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
  private apiKeysPath: string;
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
    this.apiKeysPath = path.join(userDataDir, 'netatmo-api-keys.enc.json');
    this.state = this.load();
  }

  public async init(): Promise<void> {
    await this.decryptLoadedState();
    await this.loadEncryptedApiKeysFile();
  }

  private async loadEncryptedApiKeysFile(): Promise<void> {
    try {
      if (fs.existsSync(this.apiKeysPath)) {
        const raw = await fs.promises.readFile(this.apiKeysPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.encryptedData) {
          const plainJson = await decryptSecretAsync(parsed.encryptedData);
          if (plainJson) {
            const creds = JSON.parse(plainJson);
            if (creds.clientId) {
              this.state.settings.oauthClientId = creds.clientId;
            }
            if (creds.clientSecret) {
              this.state.settings.oauthClientSecret = creds.clientSecret;
              this.cachedEncryptedSecrets.plainOauthSecret = creds.clientSecret;
            }
            this.state.settings.storeApiKeysLocally = true;
            if (creds.autoUpdate !== undefined) {
              this.state.settings.autoUpdateTokens = Boolean(creds.autoUpdate);
            }
            if (creds.accessToken && !this.state.session.accessToken) {
              this.state.session.accessToken = creds.accessToken;
              this.cachedEncryptedSecrets.plainAccessToken = creds.accessToken;
              if (creds.refreshToken) {
                this.state.session.refreshToken = creds.refreshToken;
                this.cachedEncryptedSecrets.plainRefreshToken = creds.refreshToken;
              }
              if (creds.expiresAt) {
                this.state.session.expiresAt = creds.expiresAt;
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[AppStore] Failed to load encrypted API keys file:', err);
    }
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

  public clearSession(clearStoredKeys = false): void {
    this.cachedEncryptedSecrets = {};
    this.cachedEncryptedCookies = undefined;
    this.state.session = { ...DEFAULT_SESSION };
    this.state.cachedStations = [];
    this.state.lastSyncAt = undefined;
    if (clearStoredKeys) {
      this.clearStoredApiKeys(true).catch(() => {});
    }
    this.save();
  }

  public getAccountInfo(): AccountInfo {
    const s = this.state.session;
    const hasFile = fs.existsSync(this.apiKeysPath);
    return {
      loggedIn: s.loggedIn,
      email: s.email,
      userId: s.userId,
      authMethod: s.authMethod,
      country: s.country,
      locale: s.locale,
      tokenExpiresAt: s.expiresAt,
      hasStoredKeys: hasFile || Boolean(this.state.settings.oauthClientId),
      autoUpdateEnabled: Boolean(this.state.settings.autoUpdateTokens),
    };
  }

  private async writeEncryptedApiKeysFile(
    creds: Record<string, any>
  ): Promise<void> {
    const plain = JSON.stringify(creds, null, 2);
    const cipher = await encryptSecretAsync(plain);
    const fileContent = JSON.stringify(
      {
        format: 'winatmo-dpapi-encrypted-credentials',
        version: 1,
        notice:
          'Locally encrypted Netatmo API keys and tokens. Never commit to git or sync to external servers.',
        encryptedData: cipher,
        updatedAt: Math.floor(Date.now() / 1000),
      },
      null,
      2
    );
    await fs.promises.writeFile(this.apiKeysPath, fileContent, 'utf-8');
  }

  public async saveApiKeys(payload: {
    clientId: string;
    clientSecret: string;
    accessToken?: string;
    refreshToken?: string;
    autoUpdate?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const cleanClientId = payload.clientId.trim();
      const cleanClientSecret = payload.clientSecret.trim();
      const cleanAccessToken = payload.accessToken?.trim();
      const cleanRefreshToken = payload.refreshToken?.trim();
      const autoUpdate =
        payload.autoUpdate !== undefined ? payload.autoUpdate : true;

      this.state.settings.oauthClientId = cleanClientId;
      this.state.settings.oauthClientSecret = cleanClientSecret;
      this.state.settings.storeApiKeysLocally = true;
      this.state.settings.autoUpdateTokens = autoUpdate;

      this.cachedEncryptedSecrets.plainOauthSecret = cleanClientSecret;
      this.cachedEncryptedSecrets.encOauthSecret = undefined;

      if (cleanAccessToken) {
        this.state.session.accessToken = cleanAccessToken;
        this.cachedEncryptedSecrets.plainAccessToken = cleanAccessToken;
        this.cachedEncryptedSecrets.encAccessToken = undefined;
      }
      if (cleanRefreshToken) {
        this.state.session.refreshToken = cleanRefreshToken;
        this.cachedEncryptedSecrets.plainRefreshToken = cleanRefreshToken;
        this.cachedEncryptedSecrets.encRefreshToken = undefined;
      }

      await this.writeEncryptedApiKeysFile({
        clientId: cleanClientId,
        clientSecret: cleanClientSecret,
        accessToken: cleanAccessToken || this.state.session.accessToken,
        refreshToken: cleanRefreshToken || this.state.session.refreshToken,
        expiresAt: this.state.session.expiresAt,
        authMethod: this.state.session.authMethod || 'oauth',
        autoUpdate,
        updatedAt: Math.floor(Date.now() / 1000),
      });

      this.save();
      return { success: true };
    } catch (err: any) {
      console.error('[AppStore] Failed to save API keys:', err);
      return {
        success: false,
        error: err?.message || 'Failed to save API keys',
      };
    }
  }

  public async updateStoredApiKeysTokens(
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number
  ): Promise<void> {
    if (
      !this.state.settings.storeApiKeysLocally &&
      !fs.existsSync(this.apiKeysPath)
    ) {
      return;
    }
    try {
      await this.writeEncryptedApiKeysFile({
        clientId: this.state.settings.oauthClientId,
        clientSecret: this.state.settings.oauthClientSecret,
        accessToken,
        refreshToken: refreshToken || this.state.session.refreshToken,
        expiresAt: expiresAt || this.state.session.expiresAt,
        authMethod: this.state.session.authMethod || 'oauth',
        autoUpdate: this.state.settings.autoUpdateTokens,
        updatedAt: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      console.warn(
        '[AppStore] Failed to update tokens in encrypted keys file:',
        err
      );
    }
  }

  public async clearStoredApiKeys(clearSettings = true): Promise<void> {
    try {
      if (fs.existsSync(this.apiKeysPath)) {
        await fs.promises.unlink(this.apiKeysPath);
      }
    } catch (err) {
      console.warn('[AppStore] Failed to delete encrypted keys file:', err);
    }
    if (clearSettings) {
      this.state.settings.oauthClientId = undefined;
      this.state.settings.oauthClientSecret = undefined;
      this.state.settings.storeApiKeysLocally = false;
      this.cachedEncryptedSecrets.plainOauthSecret = undefined;
      this.cachedEncryptedSecrets.encOauthSecret = undefined;
      this.save();
    }
  }

  public getStoredApiKeysInfo(): StoredApiKeysInfo {
    const hasFile = fs.existsSync(this.apiKeysPath);
    const s = this.state.settings;
    const sess = this.state.session;
    return {
      hasStoredKeys: hasFile || Boolean(s.oauthClientId && s.oauthClientSecret),
      storeApiKeysLocally: Boolean(s.storeApiKeysLocally || hasFile),
      autoUpdateTokens: Boolean(s.autoUpdateTokens),
      clientId: s.oauthClientId
        ? `${s.oauthClientId.slice(0, 6)}...${s.oauthClientId.slice(-4)}`
        : undefined,
      hasClientSecret: Boolean(s.oauthClientSecret),
      hasAccessToken: Boolean(sess.accessToken),
      hasRefreshToken: Boolean(sess.refreshToken),
      tokenExpiresAt: sess.expiresAt,
      filePath: hasFile ? this.apiKeysPath : undefined,
      updatedAt: sess.expiresAt ? sess.expiresAt - 10800 : undefined,
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
