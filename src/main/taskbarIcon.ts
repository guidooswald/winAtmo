import { BrowserWindow, nativeImage } from 'electron';
import { UserSettings, WeatherStation, StationModule } from '../renderer/types';

export interface TaskbarReadingResult {
  text: string;
  fullLabel: string;
  color: string;
  stationName: string;
  moduleName: string;
  metric: string;
}

let iconRendererWindow: BrowserWindow | null = null;
let isRendererReady = false;

/**
 * Initializes the hidden offscreen window used for crisp DirectWrite canvas rendering.
 */
export async function initTaskbarIconRenderer(): Promise<void> {
  if (iconRendererWindow && !iconRendererWindow.isDestroyed()) return;

  try {
    iconRendererWindow = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: {
        offscreen: true,
        contextIsolation: false,
      },
    });

    const html = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="32" height="32"></canvas></body></html>`;
    await iconRendererWindow.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    );
    isRendererReady = true;
  } catch (err) {
    console.warn('[TaskbarIcon] Failed to initialize offscreen canvas renderer:', err);
    isRendererReady = false;
  }
}

/**
 * Resolves the target sensor reading from the cached stations according to user settings.
 */
export function resolveTaskbarReading(
  stations: WeatherStation[],
  settings: UserSettings
): TaskbarReadingResult | null {
  if (settings.taskbarDisplayMode === 'icon' || !stations || stations.length === 0) {
    return null;
  }

  const target = settings.taskbarSensorTarget || 'outdoor_temp';

  // 1. Outdoor Temperature (Default)
  if (target === 'outdoor_temp') {
    // Look for outdoor module first
    for (const st of stations) {
      const outdoor = st.modules.find(
        (m) =>
          (m.type === 'NAModule1' ||
            m.moduleName.toLowerCase().includes('outdoor') ||
            m.moduleName.toLowerCase().includes('aussen') ||
            m.moduleName.toLowerCase().includes('ext')) &&
          m.dashboard?.Temperature !== undefined
      );
      if (outdoor?.dashboard?.Temperature !== undefined) {
        return formatTemperatureReading(
          outdoor.dashboard.Temperature,
          st.stationName,
          outdoor.moduleName,
          settings
        );
      }
    }

    // Fallback: any module with temperature not equal to main station
    for (const st of stations) {
      const mod = st.modules.find(
        (m) => m.type !== 'NAMain' && m.dashboard?.Temperature !== undefined
      );
      if (mod?.dashboard?.Temperature !== undefined) {
        return formatTemperatureReading(
          mod.dashboard.Temperature,
          st.stationName,
          mod.moduleName,
          settings
        );
      }
    }

    // Fallback: main station temperature
    const first = stations[0];
    const mainMod = first.modules.find((m) => m.dashboard?.Temperature !== undefined);
    if (mainMod?.dashboard?.Temperature !== undefined) {
      return formatTemperatureReading(
        mainMod.dashboard.Temperature,
        first.stationName,
        mainMod.moduleName,
        settings
      );
    }
  }

  // 2. Indoor Temperature
  if (target === 'indoor_temp') {
    for (const st of stations) {
      const mod = st.modules.find(
        (m) =>
          (m.type === 'NAMain' || m.type === 'NAModule4') &&
          m.dashboard?.Temperature !== undefined
      );
      if (mod?.dashboard?.Temperature !== undefined) {
        return formatTemperatureReading(
          mod.dashboard.Temperature,
          st.stationName,
          mod.moduleName,
          settings
        );
      }
    }
  }

  // 3. Indoor CO2
  if (target === 'indoor_co2') {
    for (const st of stations) {
      const mod = st.modules.find((m) => m.dashboard?.CO2 !== undefined);
      if (mod?.dashboard?.CO2 !== undefined) {
        const co2 = mod.dashboard.CO2;
        let text = `${co2}`;
        if (co2 >= 1000) {
          text = `${(co2 / 1000).toFixed(1)}k`;
        }
        let color = '#10b981'; // Green
        if (co2 >= 1500) color = '#ef4444'; // Red alert
        else if (co2 >= 1000) color = '#f59e0b'; // Amber warning

        return {
          text,
          fullLabel: `${mod.moduleName} CO₂: ${co2} ppm`,
          color,
          stationName: st.stationName,
          moduleName: mod.moduleName,
          metric: 'co2',
        };
      }
    }
  }

  // 4. Outdoor Humidity
  if (target === 'outdoor_humidity') {
    for (const st of stations) {
      const mod = st.modules.find(
        (m) =>
          (m.type === 'NAModule1' ||
            m.moduleName.toLowerCase().includes('outdoor') ||
            m.moduleName.toLowerCase().includes('aussen')) &&
          m.dashboard?.Humidity !== undefined
      );
      if (mod?.dashboard?.Humidity !== undefined) {
        return formatHumidityReading(
          mod.dashboard.Humidity,
          st.stationName,
          mod.moduleName
        );
      }
    }
  }

  // 5. Indoor Humidity
  if (target === 'indoor_humidity') {
    for (const st of stations) {
      const mod = st.modules.find(
        (m) => m.type === 'NAMain' && m.dashboard?.Humidity !== undefined
      );
      if (mod?.dashboard?.Humidity !== undefined) {
        return formatHumidityReading(
          mod.dashboard.Humidity,
          st.stationName,
          mod.moduleName
        );
      }
    }
  }

  // 6. Barometric Pressure
  if (target === 'pressure') {
    for (const st of stations) {
      const mod = st.modules.find((m) => m.dashboard?.Pressure !== undefined);
      if (mod?.dashboard?.Pressure !== undefined) {
        const p = mod.dashboard.Pressure;
        const text =
          settings.pressureUnit === 'inHg'
            ? p.toFixed(1)
            : `${Math.round(p)}`;
        return {
          text,
          fullLabel: `${st.stationName} Pressure: ${p.toFixed(1)} ${settings.pressureUnit}`,
          color: '#8b5cf6',
          stationName: st.stationName,
          moduleName: mod.moduleName,
          metric: 'pressure',
        };
      }
    }
  }

  // 7. Custom sensor ID format: `${stationId}::${moduleId}::${metric}`
  if (target.includes('::')) {
    const [stationId, moduleId, metric] = target.split('::');
    const st = stations.find((s) => s.id === stationId);
    const mod = st?.modules.find((m) => m.id === moduleId);
    if (mod?.dashboard) {
      const d = mod.dashboard as Record<string, any>;
      const rawVal =
        metric === 'temperature'
          ? d.Temperature
          : metric === 'humidity'
          ? d.Humidity
          : metric === 'co2'
          ? d.CO2
          : metric === 'pressure'
          ? d.Pressure
          : metric === 'noise'
          ? d.Noise
          : metric === 'rain'
          ? d.Rain
          : metric === 'windstrength'
          ? d.WindStrength
          : undefined;

      if (rawVal !== undefined) {
        if (metric === 'temperature') {
          return formatTemperatureReading(
            rawVal,
            st?.stationName || '',
            mod.moduleName,
            settings
          );
        }
        if (metric === 'humidity') {
          return formatHumidityReading(
            rawVal,
            st?.stationName || '',
            mod.moduleName
          );
        }
        if (metric === 'co2') {
          const co2 = rawVal;
          const text = co2 >= 1000 ? `${(co2 / 1000).toFixed(1)}k` : `${co2}`;
          const color =
            co2 >= 1500 ? '#ef4444' : co2 >= 1000 ? '#f59e0b' : '#10b981';
          return {
            text,
            fullLabel: `${mod.moduleName} CO₂: ${co2} ppm`,
            color,
            stationName: st?.stationName || '',
            moduleName: mod.moduleName,
            metric,
          };
        }
        return {
          text: `${Math.round(rawVal)}`,
          fullLabel: `${mod.moduleName}: ${rawVal}`,
          color: '#0ea5e9',
          stationName: st?.stationName || '',
          moduleName: mod.moduleName,
          metric,
        };
      }
    }
  }

  return null;
}

function formatTemperatureReading(
  rawCelsius: number,
  stationName: string,
  moduleName: string,
  settings: UserSettings
): TaskbarReadingResult {
  const isF = settings.temperatureUnit === 'F';
  const val = isF ? (rawCelsius * 9) / 5 + 32 : rawCelsius;
  const rounded = Math.round(val);

  // Formatting text for 32x32 icon:
  // e.g. "18°", "-4°", "102"
  let text = `${rounded}°`;
  if (rounded >= 100 || rounded <= -10) {
    // 3+ digits: omit degree mark to keep numbers crisp and large
    text = `${rounded}`;
  }

  // Semantic color based on Celsius temperature:
  let color = '#10b981'; // Comfortable (15 - 23°C / 59 - 73°F)
  if (rawCelsius < 0) {
    color = '#38bdf8'; // Freezing / Ice cyan
  } else if (rawCelsius < 15) {
    color = '#0ea5e9'; // Cool / Sky blue
  } else if (rawCelsius >= 28) {
    color = '#ef4444'; // Hot / Crimson
  } else if (rawCelsius >= 23) {
    color = '#f59e0b'; // Warm / Amber
  }

  const fullLabel = `${moduleName}: ${val.toFixed(1)}°${settings.temperatureUnit}`;

  return {
    text,
    fullLabel,
    color,
    stationName,
    moduleName,
    metric: 'temperature',
  };
}

function formatHumidityReading(
  hum: number,
  stationName: string,
  moduleName: string
): TaskbarReadingResult {
  const rounded = Math.round(hum);
  let color = '#0ea5e9';
  if (rounded < 30) color = '#f59e0b';
  else if (rounded > 70) color = '#3b82f6';

  return {
    text: `${rounded}%`,
    fullLabel: `${moduleName} Humidity: ${hum}%`,
    color,
    stationName,
    moduleName,
    metric: 'humidity',
  };
}

/**
 * Generates an Electron.NativeImage representing the taskbar icon.
 * If reading is provided, renders a high-contrast badge icon with the sensor value.
 * Otherwise, falls back to the default application nativeImage.
 */
export async function generateTaskbarIcon(
  reading: TaskbarReadingResult | null,
  defaultImage: Electron.NativeImage
): Promise<Electron.NativeImage> {
  if (!reading) {
    return defaultImage;
  }

  if (isRendererReady && iconRendererWindow && !iconRendererWindow.isDestroyed()) {
    try {
      const dataUrl = await iconRendererWindow.webContents.executeJavaScript(`
        (() => {
          const canvas = document.getElementById('c');
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, 32, 32);

          // Deep dark slate background badge
          ctx.fillStyle = '#090d16';
          ctx.beginPath();
          ctx.roundRect(1, 1, 30, 30, 6.5);
          ctx.fill();

          // Soft inner gradient
          const grad = ctx.createLinearGradient(0, 0, 0, 32);
          grad.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
          grad.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(1.5, 1.5, 29, 29, 6);
          ctx.fill();

          // Accent border with sensor semantic status color
          ctx.strokeStyle = '${reading.color}';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(1.5, 1.5, 29, 29, 6);
          ctx.stroke();

          // Text layout
          const str = '${reading.text}';
          const len = str.length;
          let fontSize = 14;
          let yOffset = 16.5;

          if (len <= 2) {
            fontSize = 15.5;
            yOffset = 16.5;
          } else if (len === 3) {
            fontSize = 13.5;
            yOffset = 16.5;
          } else if (len === 4) {
            fontSize = 11;
            yOffset = 16.5;
          } else {
            fontSize = 9.5;
            yOffset = 16.5;
          }

          ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
          ctx.shadowBlur = 2.5;
          ctx.shadowOffsetY = 1;

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold ' + fontSize + 'px "Segoe UI", "Segoe UI Variable Display", Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(str, 16, yOffset);

          return canvas.toDataURL('image/png');
        })()
      `);

      const img = nativeImage.createFromDataURL(dataUrl);
      if (!img.isEmpty()) {
        return img;
      }
    } catch (err) {
      console.warn('[TaskbarIcon] executeJavaScript failed, using fallback:', err);
    }
  }

  // Synchronous pure-bitmap fallback
  return createFallbackBitmapReadingIcon(reading);
}

/**
 * Robust pure-bitmap fallback if Chromium canvas is temporarily busy or unavailable.
 */
function createFallbackBitmapReadingIcon(
  reading: TaskbarReadingResult
): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);

  // Parse color hex to RGB
  const hex = reading.color.replace('#', '');
  const cr = parseInt(hex.substring(0, 2), 16) || 16;
  const cg = parseInt(hex.substring(2, 4), 16) || 185;
  const cb = parseInt(hex.substring(4, 6), 16) || 129;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Distance from center 15.5, 15.5
      const dx = x - 15.5;
      const dy = y - 15.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= 14.5) {
        const isBorder = dist >= 12.5;
        if (isBorder) {
          buf[idx] = cb; // B
          buf[idx + 1] = cg; // G
          buf[idx + 2] = cr; // R
          buf[idx + 3] = 255; // A
        } else {
          // Dark background
          buf[idx] = 22; // B
          buf[idx + 1] = 13; // G
          buf[idx + 2] = 9; // R
          buf[idx + 3] = 240; // A
        }
      } else {
        buf[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
