import {
  ApiRequestLogEntry,
  DebugLogEntry,
  DebugLogLevel,
  DebugSourceDomain,
  DebugStreamEvent,
  DebugTelemetrySnapshot,
  DebugTelemetryStats,
} from '../renderer/types';

const MAX_LOGS = 500;
const MAX_API_REQUESTS = 250;
const MAX_RAW_BODY_CHARS = 60000;

function redactSensitiveText(input: string): string {
  return input
    .replace(/(access_token|refresh_token|client_secret)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9\-_.~+/=]+/gi, '$1[REDACTED]');
}

function formatArgs(args: any[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function inferCategoryFromMessage(msg: string): string {
  const m = msg.match(/^\[([A-Za-z0-9_-]+)\]/);
  if (m) return m[1];
  if (msg.toLowerCase().includes('sqlite') || msg.toLowerCase().includes('database')) {
    return 'SQLite';
  }
  if (msg.toLowerCase().includes('safestorage') || msg.toLowerCase().includes('token')) {
    return 'Auth';
  }
  return 'App';
}

function inferLogSource(category: string, message: string): DebugSourceDomain {
  const cat = category.toLowerCase();
  const msg = message.toLowerCase();
  if (cat.startsWith('security')) return 'security';
  if (cat === 'auth') return 'auth';
  if (
    msg.includes('/homesdata') ||
    msg.includes('/homestatus') ||
    msg.includes('/getevents') ||
    msg.includes('/gethomedata') ||
    msg.includes('hls proxy')
  ) {
    return 'security';
  }
  return 'weather';
}

const SECURITY_ENDPOINTS = new Set([
  'homesdata',
  'homestatus',
  'getevents',
  'geteventsuntil',
  'getnextevents',
  'getlasteventof',
  'gethomedata',
  'getcamerapicture',
  'setpersonshome',
  'setpersonsaway',
]);

function inferApiSource(endpoint: string, note?: string): DebugSourceDomain {
  const ep = endpoint.toLowerCase().replace(/^\/+/, '');
  const n = (note || '').toLowerCase();
  if (
    SECURITY_ENDPOINTS.has(ep) ||
    ep.startsWith('security/') ||
    ep.startsWith('hls/') ||
    ep.startsWith('vod/') ||
    ep === 'command/ping' ||
    n.startsWith('security')
  ) {
    return 'security';
  }
  if (ep.startsWith('oauth2')) return 'auth';
  return 'weather';
}

export class DebugLogger {
  private logs: DebugLogEntry[] = [];
  private apiRequests: ApiRequestLogEntry[] = [];
  private seq = 0;
  private listeners: Array<(event: DebugStreamEvent) => void> = [];
  private consoleAttached = false;
  private isWritingConsole = false;

  private stats: DebugTelemetryStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalBytesReceived: 0,
    totalDurationMs: 0,
    averageLatencyMs: 0,
    averageTransferRateBps: 0,
    lastTransferRateBps: 0,
    rateLimitHits: 0,
    startedAt: Date.now(),
  };

  public subscribe(cb: (event: DebugStreamEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== cb);
    };
  }

  private emit(event: DebugStreamEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  public getStats(): DebugTelemetryStats {
    return { ...this.stats };
  }

  public getSnapshot(): DebugTelemetrySnapshot {
    return {
      logs: [...this.logs],
      apiRequests: [...this.apiRequests],
      stats: { ...this.stats },
    };
  }

  public clear(): void {
    this.logs = [];
    this.apiRequests = [];
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalBytesReceived: 0,
      totalDurationMs: 0,
      averageLatencyMs: 0,
      averageTransferRateBps: 0,
      lastTransferRateBps: 0,
      rateLimitHits: 0,
      startedAt: Date.now(),
    };
    this.emit({
      type: 'clear',
      stats: this.getStats(),
    });
  }

  public log(
    level: DebugLogLevel,
    category: string,
    message: string,
    details?: string,
    source?: DebugSourceDomain
  ): void {
    const entry: DebugLogEntry = {
      id: `log-${++this.seq}`,
      timestamp: Date.now(),
      level,
      category,
      source: source || inferLogSource(category, message),
      message: redactSensitiveText(message),
      details: details ? redactSensitiveText(details) : undefined,
    };

    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.shift();
    }

    this.emit({
      type: 'log',
      logEntry: entry,
      stats: this.getStats(),
    });
  }

  public recordApiRequest(input: {
    method: string;
    endpoint: string;
    baseHost: string;
    url: string;
    source?: DebugSourceDomain;
    status: number | null;
    ok: boolean;
    durationMs: number;
    bytesReceived: number;
    rawBody?: string;
    error?: string;
    note?: string;
  }): ApiRequestLogEntry {
    const safeDuration = Math.max(1, Math.round(input.durationMs));
    const bps =
      input.bytesReceived > 0
        ? Math.round((input.bytesReceived * 1000) / safeDuration)
        : 0;

    let rawBodyPreview = input.rawBody;
    let rawBodyTruncated = false;
    if (rawBodyPreview && rawBodyPreview.length > MAX_RAW_BODY_CHARS) {
      rawBodyPreview = rawBodyPreview.slice(0, MAX_RAW_BODY_CHARS);
      rawBodyTruncated = true;
    }
    if (rawBodyPreview) {
      rawBodyPreview = redactSensitiveText(rawBodyPreview);
    }

    const entry: ApiRequestLogEntry = {
      id: `api-${++this.seq}`,
      timestamp: Date.now(),
      method: input.method,
      endpoint: input.endpoint,
      baseHost: input.baseHost,
      url: redactSensitiveText(input.url),
      source: input.source || inferApiSource(input.endpoint, input.note),
      status: input.status,
      ok: input.ok,
      durationMs: safeDuration,
      bytesReceived: input.bytesReceived,
      transferRateBytesPerSec: bps,
      error: input.error ? redactSensitiveText(input.error) : undefined,
      rawBodyPreview,
      rawBodyTruncated,
      note: input.note,
    };

    this.apiRequests.push(entry);
    if (this.apiRequests.length > MAX_API_REQUESTS) {
      this.apiRequests.shift();
    }

    this.stats.totalRequests += 1;
    if (input.ok) {
      this.stats.successfulRequests += 1;
    } else {
      this.stats.failedRequests += 1;
    }
    if (input.status === 429) {
      this.stats.rateLimitHits += 1;
    }

    this.stats.totalBytesReceived += input.bytesReceived;
    this.stats.totalDurationMs += safeDuration;
    this.stats.averageLatencyMs = Math.round(
      this.stats.totalDurationMs / this.stats.totalRequests
    );
    this.stats.averageTransferRateBps =
      this.stats.totalDurationMs > 0
        ? Math.round(
            (this.stats.totalBytesReceived * 1000) / this.stats.totalDurationMs
          )
        : 0;
    if (bps > 0) {
      this.stats.lastTransferRateBps = bps;
    }

    this.emit({
      type: 'api',
      apiEntry: entry,
      stats: this.getStats(),
    });

    return entry;
  }

  /**
   * Intercepts main-process console output so terminal logs & warnings
   * appear in the Debug Console UI automatically.
   */
  public attachConsoleCapture(): void {
    if (this.consoleAttached) return;
    this.consoleAttached = true;

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: any[]) => {
      origLog(...args);
      if (this.isWritingConsole) return;
      this.isWritingConsole = true;
      try {
        const msg = formatArgs(args);
        this.log('info', inferCategoryFromMessage(msg), msg);
      } finally {
        this.isWritingConsole = false;
      }
    };

    console.warn = (...args: any[]) => {
      origWarn(...args);
      if (this.isWritingConsole) return;
      this.isWritingConsole = true;
      try {
        const msg = formatArgs(args);
        this.log('warn', inferCategoryFromMessage(msg), msg);
      } finally {
        this.isWritingConsole = false;
      }
    };

    console.error = (...args: any[]) => {
      origError(...args);
      if (this.isWritingConsole) return;
      this.isWritingConsole = true;
      try {
        const msg = formatArgs(args);
        this.log('error', inferCategoryFromMessage(msg), msg);
      } finally {
        this.isWritingConsole = false;
      }
    };
  }
}

export const debugLogger = new DebugLogger();
