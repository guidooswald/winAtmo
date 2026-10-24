import {
  DashboardReadings,
  MetricType,
  ModuleType,
  UserSettings,
} from '../types';

export interface MetricMeta {
  key: MetricType;
  label: string;
  shortLabel: string;
  defaultColor: string;
  decimals: number;
  isBarPreferred?: boolean;
}

export const METRIC_METADATA: Record<MetricType, MetricMeta> = {
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    shortLabel: 'Temp',
    defaultColor: '#38bdf8',
    decimals: 1,
  },
  humidity: {
    key: 'humidity',
    label: 'Humidity',
    shortLabel: 'Hum',
    defaultColor: '#818cf8',
    decimals: 0,
  },
  co2: {
    key: 'co2',
    label: 'CO₂ Concentration',
    shortLabel: 'CO₂',
    defaultColor: '#10b981',
    decimals: 0,
  },
  pressure: {
    key: 'pressure',
    label: 'Barometric Pressure',
    shortLabel: 'Press',
    defaultColor: '#f59e0b',
    decimals: 1,
  },
  noise: {
    key: 'noise',
    label: 'Acoustic Noise',
    shortLabel: 'Noise',
    defaultColor: '#ec4899',
    decimals: 0,
  },
  rain: {
    key: 'rain',
    label: 'Rainfall',
    shortLabel: 'Rain',
    defaultColor: '#60a5fa',
    decimals: 1,
    isBarPreferred: true,
  },
  sum_rain: {
    key: 'sum_rain',
    label: 'Cumulative Rain',
    shortLabel: 'Rain 24h',
    defaultColor: '#3b82f6',
    decimals: 1,
    isBarPreferred: true,
  },
  windstrength: {
    key: 'windstrength',
    label: 'Wind Speed',
    shortLabel: 'Wind',
    defaultColor: '#2dd4bf',
    decimals: 0,
  },
  guststrength: {
    key: 'guststrength',
    label: 'Wind Gusts',
    shortLabel: 'Gust',
    defaultColor: '#f97316',
    decimals: 0,
  },
  windangle: {
    key: 'windangle',
    label: 'Wind Direction',
    shortLabel: 'Dir',
    defaultColor: '#a78bfa',
    decimals: 0,
  },
  gustangle: {
    key: 'gustangle',
    label: 'Gust Direction',
    shortLabel: 'Gust Dir',
    defaultColor: '#c084fc',
    decimals: 0,
  },
};

export const SERIES_PALETTE = [
  '#38bdf8', // Sky blue
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#a855f7', // Purple
  '#f43f5e', // Rose
  '#2dd4bf', // Teal
  '#60a5fa', // Blue
  '#fb923c', // Orange
  '#eab308', // Yellow
  '#ec4899', // Pink
];

export function getMetricUnit(
  metric: MetricType,
  settings: UserSettings
): string {
  switch (metric) {
    case 'temperature':
      return `°${settings.temperatureUnit}`;
    case 'humidity':
      return '%';
    case 'co2':
      return 'ppm';
    case 'pressure':
      return settings.pressureUnit;
    case 'noise':
      return 'dB';
    case 'rain':
    case 'sum_rain':
      return settings.rainUnit;
    case 'windstrength':
    case 'guststrength':
      return settings.windUnit === 'ms'
        ? 'm/s'
        : settings.windUnit === 'mph'
          ? 'mph'
          : settings.windUnit === 'kn'
            ? 'kn'
            : 'km/h';
    case 'windangle':
    case 'gustangle':
      return '°';
  }
}

export function convertMetricValue(
  value: number,
  metric: MetricType,
  settings: UserSettings
): number {
  switch (metric) {
    case 'temperature':
      return settings.temperatureUnit === 'F'
        ? Number(((value * 9) / 5 + 32).toFixed(1))
        : Number(value.toFixed(1));
    case 'pressure':
      if (settings.pressureUnit === 'inHg') {
        return Number((value * 0.02953).toFixed(2));
      }
      if (settings.pressureUnit === 'mmHg') {
        return Number((value * 0.750062).toFixed(1));
      }
      return Number(value.toFixed(1));
    case 'rain':
    case 'sum_rain':
      return settings.rainUnit === 'in'
        ? Number((value * 0.0393701).toFixed(2))
        : Number(value.toFixed(1));
    case 'windstrength':
    case 'guststrength':
      if (settings.windUnit === 'ms') {
        return Number((value / 3.6).toFixed(1));
      }
      if (settings.windUnit === 'mph') {
        return Number((value * 0.621371).toFixed(1));
      }
      if (settings.windUnit === 'kn') {
        return Number((value * 0.539957).toFixed(1));
      }
      return Math.round(value);
    default:
      return Number(
        value.toFixed(METRIC_METADATA[metric]?.decimals ?? 1)
      );
  }
}

export function formatMetricValue(
  value: number | undefined,
  metric: MetricType,
  settings: UserSettings,
  includeUnit = true
): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '--';
  }
  const converted = convertMetricValue(value, metric, settings);
  const decimals =
    metric === 'pressure' && settings.pressureUnit === 'inHg'
      ? 2
      : METRIC_METADATA[metric]?.decimals ?? 1;
  const formatted = converted.toFixed(decimals);
  if (!includeUnit) return formatted;
  const unit = getMetricUnit(metric, settings);
  return unit.startsWith('°') ? `${formatted}${unit}` : `${formatted} ${unit}`;
}

export function extractLiveMetricValue(
  dashboard: DashboardReadings | undefined,
  metric: MetricType
): number | undefined {
  if (!dashboard) return undefined;
  switch (metric) {
    case 'temperature':
      return dashboard.Temperature;
    case 'humidity':
      return dashboard.Humidity;
    case 'co2':
      return dashboard.CO2;
    case 'pressure':
      return dashboard.Pressure;
    case 'noise':
      return dashboard.Noise;
    case 'rain':
      return dashboard.Rain;
    case 'sum_rain':
      return dashboard.sum_rain_24 ?? dashboard.Rain;
    case 'windstrength':
      return dashboard.WindStrength;
    case 'guststrength':
      return dashboard.GustStrength;
    case 'windangle':
      return dashboard.WindAngle;
    case 'gustangle':
      return dashboard.GustAngle;
  }
}

export function getCo2QualityBadge(co2?: number): {
  label: string;
  color: string;
  bg: string;
} {
  if (co2 === undefined) {
    return { label: 'N/A', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
  }
  if (co2 < 800) {
    return { label: 'Excellent', color: '#10b981', bg: 'rgba(16,185,129,0.16)' };
  }
  if (co2 < 1150) {
    return { label: 'Good', color: '#84cc16', bg: 'rgba(132,204,22,0.16)' };
  }
  if (co2 < 1600) {
    return { label: 'Ventilate', color: '#f59e0b', bg: 'rgba(245,158,11,0.18)' };
  }
  return { label: 'High CO₂', color: '#f43f5e', bg: 'rgba(244,63,94,0.2)' };
}

export function getCompassDirection(angle?: number): string {
  if (angle === undefined || angle < 0) return '';
  const dirs = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  return dirs[Math.round(angle / 22.5) % 16];
}

export function getModuleTypeLabel(type: ModuleType): string {
  switch (type) {
    case 'NAMain':
      return 'Indoor Base Station';
    case 'NAModule1':
      return 'Outdoor Module';
    case 'NAModule2':
      return 'Smart Anemometer';
    case 'NAModule3':
      return 'Smart Rain Gauge';
    case 'NAModule4':
      return 'Smart Indoor Module';
    case 'NHC':
      return 'Healthy Home Coach';
  }
}

export function getWifiQualityLabel(wifiStatus?: number): {
  label: string;
  color: string;
} {
  if (wifiStatus === undefined) return { label: 'N/A', color: '#94a3b8' };
  // Netatmo official doc: <=56 Good, <=71 Average, >=86 Bad
  if (wifiStatus <= 56) return { label: `Good (${wifiStatus} dB)`, color: '#10b981' };
  if (wifiStatus <= 71) return { label: `Average (${wifiStatus} dB)`, color: '#f59e0b' };
  return { label: `Weak (${wifiStatus} dB)`, color: '#f43f5e' };
}

export function getRfQualityLabel(rfStatus?: number): {
  label: string;
  color: string;
} {
  if (rfStatus === undefined) return { label: 'N/A', color: '#94a3b8' };
  // Netatmo official doc: <=60 Highest, <=70 High, <=80 Medium, >=90 Low
  if (rfStatus <= 65) return { label: `Strong (${rfStatus} dB)`, color: '#10b981' };
  if (rfStatus <= 78) return { label: `Good (${rfStatus} dB)`, color: '#38bdf8' };
  if (rfStatus <= 86) return { label: `Medium (${rfStatus} dB)`, color: '#f59e0b' };
  return { label: `Low (${rfStatus} dB)`, color: '#f43f5e' };
}
