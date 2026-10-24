import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  AccountInfo,
  PinnedSensorItem,
  SessionData,
  UserSettings,
  WeatherStation,
} from '../renderer/types';

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
  theme: 'dark',
  widgetEnabled: true,
  widgetAlwaysOnTop: true,
  widgetLocked: false,
  widgetOpacity: 0.94,
  widgetCompact: false,
  pinnedSensors: [],
  minimizeToTray: true,
};

const DEFAULT_SESSION: SessionData = {
  loggedIn: false,
  authMethod: 'web',
  cookies: [],
};

export class AppStore {
  private filePath: string;
  private state: PersistedState;

  constructor() {
    const userDataDir = app.getPath('userData');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    this.filePath = path.join(userDataDir, 'winatmo-config.json');
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
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
          session: { ...DEFAULT_SESSION, ...(parsed.session || {}) },
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
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.state, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('[AppStore] Failed to save state:', err);
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
    this.state.session = { ...DEFAULT_SESSION };
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
