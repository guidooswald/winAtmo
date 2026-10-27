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
      skipTaskbar: true,
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
        let color = '#34d399'; // Subtle emerald (<1000 ppm)
        if (co2 >= 1500) color = '#f87171'; // Subtle soft coral (alert)
        else if (co2 >= 1000) color = '#fbbf24'; // Subtle soft amber (warning)

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
          color: '#a78bfa', // Subtle soft lavender
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
            co2 >= 1500 ? '#f87171' : co2 >= 1000 ? '#fbbf24' : '#34d399';
          return {
            text,
            fullLabel: `${mod.moduleName} CO₂: ${co2} ppm`,
            color,
            stationName: st?.stationName || '',
            moduleName: mod.moduleName,
            metric,
          };
        }
        if (metric === 'pressure') {
          const text =
            settings.pressureUnit === 'inHg'
              ? rawVal.toFixed(1)
              : `${Math.round(rawVal)}`;
          return {
            text,
            fullLabel: `${mod.moduleName} Pressure: ${rawVal.toFixed(1)} ${settings.pressureUnit}`,
            color: '#a78bfa',
            stationName: st?.stationName || '',
            moduleName: mod.moduleName,
            metric,
          };
        }
        if (metric === 'noise') {
          const color =
            rawVal >= 65 ? '#f87171' : rawVal >= 50 ? '#fbbf24' : '#34d399';
          return {
            text: `${Math.round(rawVal)}`,
            fullLabel: `${mod.moduleName} Noise: ${Math.round(rawVal)} dB`,
            color,
            stationName: st?.stationName || '',
            moduleName: mod.moduleName,
            metric,
          };
        }
        if (metric === 'rain') {
          const color = rawVal > 0 ? '#38bdf8' : '#cbd5e1';
          return {
            text: `${rawVal.toFixed(1)}`,
            fullLabel: `${mod.moduleName} Rain: ${rawVal.toFixed(1)} mm`,
            color,
            stationName: st?.stationName || '',
            moduleName: mod.moduleName,
            metric,
          };
        }
        if (metric === 'windstrength') {
          const color =
            rawVal >= 35 ? '#f87171' : rawVal >= 15 ? '#38bdf8' : '#2dd4bf';
          return {
            text: `${Math.round(rawVal)}`,
            fullLabel: `${mod.moduleName} Wind: ${Math.round(rawVal)}`,
            color,
            stationName: st?.stationName || '',
            moduleName: mod.moduleName,
            metric,
          };
        }
        return {
          text: `${Math.round(rawVal)}`,
          fullLabel: `${mod.moduleName}: ${rawVal}`,
          color: '#38bdf8',
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

  // Temperature formatted with 1 decimal place (e.g. "14.2", "8.0", "-3.5")
  let text = val.toFixed(1);
  if (val >= 100 || val <= -100) {
    // If extreme 3+ digits, round to integer to maximize font size and avoid clipping
    text = `${Math.round(val)}`;
  }

  // Subtle semantic color based on Celsius temperature:
  let color = '#34d399'; // Comfortable (15 - 23°C / 59 - 73°F) - subtle soft emerald
  if (rawCelsius < 0) {
    color = '#7dd3fc'; // Freezing / Frost - subtle ice cyan
  } else if (rawCelsius < 15) {
    color = '#38bdf8'; // Cool / Chilly - subtle sky blue
  } else if (rawCelsius >= 28) {
    color = '#f87171'; // Hot - subtle soft coral
  } else if (rawCelsius >= 23) {
    color = '#fbbf24'; // Warm - subtle soft amber
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
  let color = '#38bdf8'; // Optimal 30-65% - subtle cyan
  if (rounded < 30) color = '#fbbf24'; // Dry - subtle amber
  else if (rounded > 65) color = '#60a5fa'; // High - subtle cornflower blue

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

          const str = ${JSON.stringify(reading.text)};
          const textColor = ${JSON.stringify(reading.color)};

          // Dynamic font maximizer: calculate largest font size that fits into 27.5px width & 23px height
          let fontSize = 23;
          ctx.font = 'bold ' + fontSize + 'px "Segoe UI Variable Display", "Segoe UI", Arial, sans-serif';
          while ((ctx.measureText(str).width > 27.5 || fontSize > 23) && fontSize > 8) {
            fontSize -= 0.5;
            ctx.font = 'bold ' + fontSize + 'px "Segoe UI Variable Display", "Segoe UI", Arial, sans-serif';
          }

          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const x = 16;
          const y = 16;

          // 1. Dark outline + drop shadow to guarantee readability on white/light backgrounds
          ctx.save();
          ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
          ctx.shadowBlur = 3.5;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 1;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
          ctx.lineWidth = 2.2;
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;
          ctx.strokeText(str, x, y);
          ctx.restore();

          // 2. Secondary soft shadow under fill for depth
          ctx.save();
          ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
          ctx.shadowBlur = 2;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0.5;

          // 3. Fill text with subtle semantic color
          ctx.fillStyle = textColor;
          ctx.fillText(str, x, y);
          ctx.restore();

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
  const cr = parseInt(hex.substring(0, 2), 16) || 52;
  const cg = parseInt(hex.substring(2, 4), 16) || 211;
  const cb = parseInt(hex.substring(4, 6), 16) || 153;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - 15.5;
      const dy = y - 15.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Subtle colored badge with dark shadow ring and transparent background
      if (dist <= 13.5 && dist >= 8.5) {
        buf[idx] = cb; // B
        buf[idx + 1] = cg; // G
        buf[idx + 2] = cr; // R
        buf[idx + 3] = 240; // A
      } else if (dist < 8.5 && dist >= 7.0) {
        // Subtle dark shadow inner rim
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 160;
      } else if (dist > 13.5 && dist <= 15.0) {
        // Subtle dark shadow outer rim
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 160;
      } else {
        buf[idx + 3] = 0; // Transparent
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
