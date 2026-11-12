import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileJson,
  Gauge,
  HardDriveDownload,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  ApiRequestLogEntry,
  DebugLogEntry,
  DebugLogLevel,
  DebugTelemetryStats,
  SyncProgress,
  UserSettings,
} from '../types';
import { WindowTopBar } from './WindowTopBar';
import { applyThemeToDocument } from '../utils/themes';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRate(bps: number): string {
  if (bps <= 0) return '0 B/s';
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function tryPrettyJson(raw?: string): string {
  if (!raw) return '(empty response body)';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

const JSON_TOKEN_REGEX =
  /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}\[\],:])/g;

function renderColorizedJson(raw?: string): React.ReactNode {
  if (!raw) return '(no response body)';

  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }

  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  JSON_TOKEN_REGEX.lastIndex = 0;
  let tokenKey = 0;

  while ((match = JSON_TOKEN_REGEX.exec(pretty)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(pretty.slice(lastIdx, match.index));
    }

    const token = match[0];
    let cls = 'json-punct';

    if (token.startsWith('"')) {
      if (match[2] !== undefined) {
        // Split key string from trailing whitespace + colon so only the key gets key color
        const colonIdx = token.lastIndexOf(':');
        const keyPart = token.slice(0, colonIdx);
        const punctPart = token.slice(colonIdx);
        nodes.push(
          <span key={`k-${tokenKey++}`} className="json-key">
            {keyPart}
          </span>
        );
        nodes.push(
          <span key={`p-${tokenKey++}`} className="json-punct">
            {punctPart}
          </span>
        );
        lastIdx = match.index + token.length;
        continue;
      }
      cls = 'json-string';
    } else if (token === 'true' || token === 'false') {
      cls = 'json-boolean';
    } else if (token === 'null') {
      cls = 'json-null';
    } else if (/^-?\d/.test(token)) {
      cls = 'json-number';
    }

    nodes.push(
      <span key={`t-${tokenKey++}`} className={cls}>
        {token}
      </span>
    );
    lastIdx = match.index + token.length;
  }

  if (lastIdx < pretty.length) {
    nodes.push(pretty.slice(lastIdx));
  }

  return nodes;
}

const ColorizedJsonBody: React.FC<{
  rawBody?: string;
  prettyPrint: boolean;
}> = React.memo(({ rawBody, prettyPrint }) => {
  const rendered = useMemo(() => {
    if (!prettyPrint) {
      return rawBody || '(no response body)';
    }
    return renderColorizedJson(rawBody);
  }, [rawBody, prettyPrint]);

  return <pre className="debug-raw-pre">{rendered}</pre>;
});

export const DebugConsoleWindow: React.FC = () => {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    active: false,
    phase: 'idle',
    message: 'Idle',
    completedModules: 0,
    totalModules: 0,
    pointsStored: 0,
  });
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [apiRequests, setApiRequests] = useState<ApiRequestLogEntry[]>([]);
  const [stats, setStats] = useState<DebugTelemetryStats>({
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
  });

  const [activeTab, setActiveTab] = useState<'api' | 'logs'>('api');
  const [selectedApiId, setSelectedApiId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState<boolean>(true);
  const followLatestRef = useRef<boolean>(true);
  followLatestRef.current = followLatest;
  const [prettyPrint, setPrettyPrint] = useState<boolean>(true);
  const [levelFilter, setLevelFilter] = useState<'all' | DebugLogLevel>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const [isResizingSplit, setIsResizingSplit] = useState<boolean>(false);
  const [splitLeftPct, setSplitLeftPct] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('winatmo_debug_split_pct'));
      if (Number.isFinite(saved) && saved >= 20 && saved <= 78) {
        return saved;
      }
    } catch {}
    return 42;
  });

  useEffect(() => {
    const init = async () => {
      const [s, prog, snap] = await Promise.all([
        window.winatmo.getSettings(),
        window.winatmo.getSyncProgress(),
        window.winatmo.getDebugSnapshot(),
      ]);
      setSettings(s);
      setSyncProgress(prog);
      setLogs(snap.logs);
      setApiRequests(snap.apiRequests);
      setStats(snap.stats);
      if (snap.apiRequests.length > 0) {
        setSelectedApiId(snap.apiRequests[snap.apiRequests.length - 1].id);
      }
    };
    init();

    const unsubSettings = window.winatmo.onSettingsUpdated((next) => {
      setSettings(next);
    });
    const unsubProgress = window.winatmo.onSyncProgress((prog) => {
      setSyncProgress(prog);
    });
    const unsubDebug = window.winatmo.onDebugStream((event) => {
      setStats(event.stats);
      if (event.type === 'clear') {
        setLogs([]);
        setApiRequests([]);
        setSelectedApiId(null);
      } else if (event.type === 'log' && event.logEntry) {
        const entry = event.logEntry;
        setLogs((prev) => [...prev.slice(-499), entry]);
      } else if (event.type === 'api' && event.apiEntry) {
        const entry = event.apiEntry;
        setApiRequests((prev) => [...prev.slice(-249), entry]);
        setSelectedApiId((prevId) =>
          followLatestRef.current || !prevId ? entry.id : prevId
        );
      }
    });

    return () => {
      unsubSettings();
      unsubProgress();
      unsubDebug();
    };
  }, []);

  useEffect(() => {
    if (settings?.theme) {
      applyThemeToDocument(settings.theme);
    }
  }, [settings?.theme]);

  const orderedApiRequests = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = [...apiRequests].reverse();
    if (!q) return list;
    return list.filter(
      (r) =>
        r.endpoint.toLowerCase().includes(q) ||
        r.baseHost.toLowerCase().includes(q) ||
        (r.note || '').toLowerCase().includes(q) ||
        (r.error || '').toLowerCase().includes(q) ||
        String(r.status || '').includes(q)
    );
  }, [apiRequests, searchQuery]);

  const selectedApi = useMemo(() => {
    return (
      apiRequests.find((r) => r.id === selectedApiId) ||
      orderedApiRequests[0] ||
      null
    );
  }, [apiRequests, orderedApiRequests, selectedApiId]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...logs].reverse().filter((l) => {
      if (levelFilter !== 'all' && l.level !== levelFilter) return false;
      if (!q) return true;
      return (
        l.message.toLowerCase().includes(q) ||
        l.category.toLowerCase().includes(q) ||
        (l.details || '').toLowerCase().includes(q)
      );
    });
  }, [logs, levelFilter, searchQuery]);

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(label);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  };

  const handleCopyDiagnosticsReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      syncProgress,
      stats,
      recentApiRequests: apiRequests.slice(-40).map((r) => ({
        ...r,
        rawBodyPreview:
          r.rawBodyPreview && r.rawBodyPreview.length > 800
            ? r.rawBodyPreview.slice(0, 800) + '... [truncated]'
            : r.rawBodyPreview,
      })),
      recentLogs: logs.slice(-100),
    };
    handleCopy(JSON.stringify(report, null, 2), 'report');
  };

  const handleClear = async () => {
    const snap = await window.winatmo.clearDebugLogs();
    setLogs(snap.logs);
    setApiRequests(snap.apiRequests);
    setStats(snap.stats);
    setSelectedApiId(null);
  };

  const theme = settings?.theme || 'fluent-dark';

  return (
    <div
      className={`app-shell debug-shell theme-${theme} platform-${
        window.winatmo?.platform || 'win32'
      }`}
    >
      <WindowTopBar
        title="winAtmo • API & Sync Debug Console"
        currentTheme={theme}
        onThemeChange={(t) => window.winatmo.updateSettings({ theme: t })}
      />

      <div className="debug-window-body">
        {/* Telemetry Summary Cards */}
        <div className="debug-kpi-grid">
          <div className="debug-kpi-card">
            <div className="debug-kpi-label">
              <Activity size={13} /> API Requests
            </div>
            <div className="debug-kpi-value">
              {stats.totalRequests.toLocaleString()}
            </div>
            <div className="debug-kpi-sub">
              <span className="ok">{stats.successfulRequests} OK</span> •{' '}
              <span className={stats.failedRequests > 0 ? 'err' : ''}>
                {stats.failedRequests} err
              </span>
              {stats.rateLimitHits > 0 && (
                <span className="warn"> • {stats.rateLimitHits}× 429</span>
              )}
            </div>
          </div>

          <div className="debug-kpi-card">
            <div className="debug-kpi-label">
              <HardDriveDownload size={13} /> Transferred
            </div>
            <div className="debug-kpi-value">
              {formatBytes(stats.totalBytesReceived)}
            </div>
            <div className="debug-kpi-sub">
              Total wire payload received
            </div>
          </div>

          <div className="debug-kpi-card">
            <div className="debug-kpi-label">
              <Gauge size={13} /> Transfer Rate
            </div>
            <div className="debug-kpi-value">
              {formatRate(stats.lastTransferRateBps)}
            </div>
            <div className="debug-kpi-sub">
              Avg: {formatRate(stats.averageTransferRateBps)}
            </div>
          </div>

          <div className="debug-kpi-card">
            <div className="debug-kpi-label">
              <RefreshCw size={13} /> Avg Latency
            </div>
            <div className="debug-kpi-value">{stats.averageLatencyMs} ms</div>
            <div className="debug-kpi-sub">
              Total wait: {(stats.totalDurationMs / 1000).toFixed(1)}s
            </div>
          </div>

          <div className="debug-kpi-card wide">
            <div className="debug-kpi-label">
              {syncProgress.active ? (
                <RefreshCw size={13} className="spin" />
              ) : syncProgress.phase === 'error' ? (
                <AlertTriangle size={13} />
              ) : (
                <CheckCircle2 size={13} />
              )}{' '}
              Sync Engine Status
            </div>
            <div className="debug-kpi-status-msg" title={syncProgress.message}>
              {syncProgress.message}
            </div>
            <div className="debug-kpi-sub">
              Phase: <strong>{syncProgress.phase}</strong> •{' '}
              {syncProgress.completedModules}/{syncProgress.totalModules} modules •{' '}
              +{syncProgress.pointsStored.toLocaleString()} pts
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <div className="debug-toolbar">
          <div className="pill-group">
            <button
              className={`pill-btn ${activeTab === 'api' ? 'active' : ''}`}
              onClick={() => setActiveTab('api')}
            >
              <FileJson size={13} /> API Requests & Raw Output ({apiRequests.length})
            </button>
            <button
              className={`pill-btn ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              <Terminal size={13} /> Log Messages ({logs.length})
            </button>
          </div>

          <div className="debug-search-box">
            <Search size={13} />
            <input
              type="text"
              placeholder="Filter endpoint, host, error, or log..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="debug-toolbar-actions">
            <label className="debug-toggle-check" title="Automatically select incoming API request">
              <input
                type="checkbox"
                checked={followLatest}
                onChange={(e) => setFollowLatest(e.target.checked)}
              />
              <span>Follow live</span>
            </label>

            <button
              className="action-btn subtle"
              onClick={() => window.winatmo.syncHistory({ forceFull: false })}
              disabled={syncProgress.active}
              title="Run incremental delta sync"
            >
              <RefreshCw size={13} className={syncProgress.active ? 'spin' : ''} />
              Sync Delta
            </button>

            <button
              className="action-btn subtle"
              onClick={handleCopyDiagnosticsReport}
              title="Copy JSON diagnostics summary to clipboard"
            >
              {copiedId === 'report' ? <Check size={13} /> : <Copy size={13} />}
              {copiedId === 'report' ? 'Copied' : 'Copy Report'}
            </button>

            <button
              className="action-btn danger"
              onClick={handleClear}
              title="Clear recorded API history and logs"
            >
              <Trash2 size={13} /> Clear
            </button>
          </div>
        </div>

        {/* Main Content */}
        {activeTab === 'api' ? (
          <div
            ref={splitPaneRef}
            className={`debug-split-pane ${isResizingSplit ? 'resizing' : ''}`}
          >
            {/* Left: API Request List */}
            <div
              className="debug-api-list"
              style={{ flex: `0 0 calc(${splitLeftPct}% - 6px)` }}
            >
              {orderedApiRequests.length === 0 ? (
                <div className="debug-empty-state">
                  <FileJson size={28} />
                  <p>No API requests recorded yet.</p>
                  <span>Click &quot;Sync Delta&quot; or wait for the next refresh to inspect raw traffic.</span>
                </div>
              ) : (
                orderedApiRequests.map((req) => {
                  const isSelected = selectedApi?.id === req.id;
                  const statusClass =
                    req.status === 429
                      ? 'warn'
                      : req.ok
                        ? 'ok'
                        : 'err';
                  return (
                    <button
                      key={req.id}
                      type="button"
                      className={`debug-api-row ${isSelected ? 'active' : ''}`}
                      onClick={() => {
                        setFollowLatest(false);
                        setSelectedApiId(req.id);
                      }}
                    >
                      <div className="debug-api-row-top">
                        <span className={`debug-status-badge ${statusClass}`}>
                          {req.status ?? 'NET ERR'}
                        </span>
                        <span className="debug-api-endpoint">
                          {req.method} /{req.endpoint}
                        </span>
                        <span className="debug-api-time">
                          {formatTs(req.timestamp)}
                        </span>
                      </div>
                      <div className="debug-api-row-meta">
                        <span>{req.baseHost}</span>
                        <span>{req.durationMs} ms</span>
                        <span>{formatBytes(req.bytesReceived)}</span>
                        <span className="debug-rate-pill">
                          {formatRate(req.transferRateBytesPerSec)}
                        </span>
                      </div>
                      {req.note && (
                        <div className="debug-api-row-note">{req.note}</div>
                      )}
                      {req.error && (
                        <div className="debug-api-row-err">{req.error}</div>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Draggable Vertical Divider */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize API events and raw output panes"
              tabIndex={0}
              className={`debug-split-divider ${isResizingSplit ? 'active' : ''}`}
              title="Drag to resize • Double-click to reset width"
              onDoubleClick={() => {
                setSplitLeftPct(42);
                try {
                  localStorage.setItem('winatmo_debug_split_pct', '42');
                } catch {}
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  const delta = e.key === 'ArrowLeft' ? -2 : 2;
                  setSplitLeftPct((prev) => {
                    const next = Math.max(20, Math.min(78, prev + delta));
                    try {
                      localStorage.setItem('winatmo_debug_split_pct', String(next));
                    } catch {}
                    return next;
                  });
                }
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                const container = splitPaneRef.current;
                if (!container) return;
                setIsResizingSplit(true);
                let latestPct = splitLeftPct;

                const onMove = (ev: MouseEvent) => {
                  const rect = container.getBoundingClientRect();
                  if (rect.width <= 0) return;
                  const pct = ((ev.clientX - rect.left) / rect.width) * 100;
                  latestPct = Math.max(20, Math.min(78, Number(pct.toFixed(2))));
                  setSplitLeftPct(latestPct);
                };

                const onUp = () => {
                  setIsResizingSplit(false);
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                  document.body.style.cursor = '';
                  try {
                    localStorage.setItem('winatmo_debug_split_pct', String(latestPct));
                  } catch {}
                };

                document.body.style.cursor = 'col-resize';
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            >
              <span className="debug-split-handle" />
            </div>

            {/* Right: Selected API Inspector */}
            <div className="debug-api-inspector">
              {selectedApi ? (
                <>
                  <div className="debug-inspector-header">
                    <div className="debug-inspector-title-row">
                      <span
                        className={`debug-status-badge ${
                          selectedApi.status === 429
                            ? 'warn'
                            : selectedApi.ok
                              ? 'ok'
                              : 'err'
                        }`}
                      >
                        {selectedApi.status ?? 'NETWORK ERROR'}
                      </span>
                      <strong>
                        {selectedApi.method} /{selectedApi.endpoint}
                      </strong>
                      <span className="debug-inspector-host">
                        ({selectedApi.baseHost})
                      </span>
                    </div>

                    <div className="debug-inspector-controls">
                      <button
                        className={`pill-btn ${prettyPrint ? 'active' : ''}`}
                        onClick={() => setPrettyPrint((p) => !p)}
                      >
                        {prettyPrint ? 'Pretty JSON' : 'Raw Text'}
                      </button>
                      <button
                        className="action-btn subtle"
                        onClick={() =>
                          handleCopy(
                            prettyPrint
                              ? tryPrettyJson(selectedApi.rawBodyPreview)
                              : selectedApi.rawBodyPreview || '',
                            'raw'
                          )
                        }
                      >
                        {copiedId === 'raw' ? <Check size={13} /> : <Copy size={13} />}
                        {copiedId === 'raw' ? 'Copied' : 'Copy Body'}
                      </button>
                    </div>
                  </div>

                  <div className="debug-inspector-url" title={selectedApi.url}>
                    {selectedApi.url}
                  </div>

                  <div className="debug-inspector-metrics">
                    <span>
                      <strong>Time:</strong> {formatTs(selectedApi.timestamp)}
                    </span>
                    <span>
                      <strong>Latency:</strong> {selectedApi.durationMs} ms
                    </span>
                    <span>
                      <strong>Payload:</strong> {formatBytes(selectedApi.bytesReceived)}
                    </span>
                    <span>
                      <strong>Transfer Rate:</strong>{' '}
                      {formatRate(selectedApi.transferRateBytesPerSec)}
                    </span>
                    {selectedApi.note && (
                      <span>
                        <strong>Context:</strong> {selectedApi.note}
                      </span>
                    )}
                  </div>

                  {selectedApi.error && (
                    <div className="debug-inspector-error">
                      <XCircle size={14} />
                      <span>{selectedApi.error}</span>
                    </div>
                  )}

                  {selectedApi.rawBodyTruncated && (
                    <div className="debug-truncated-note">
                      Response preview truncated at 60,000 characters (total wire size:{' '}
                      {formatBytes(selectedApi.bytesReceived)}).
                    </div>
                  )}

                  <ColorizedJsonBody
                    rawBody={selectedApi.rawBodyPreview}
                    prettyPrint={prettyPrint}
                  />
                </>
              ) : (
                <div className="debug-empty-state">
                  <FileJson size={28} />
                  <p>Select an API request on the left to inspect its raw output.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="debug-logs-panel">
            <div className="debug-logs-filters">
              <div className="pill-group">
                {(['all', 'info', 'warn', 'error', 'debug'] as const).map(
                  (lvl) => (
                    <button
                      key={lvl}
                      className={`pill-btn ${levelFilter === lvl ? 'active' : ''}`}
                      onClick={() => setLevelFilter(lvl)}
                    >
                      {lvl.toUpperCase()}
                    </button>
                  )
                )}
              </div>
            </div>

            <div className="debug-logs-list">
              {filteredLogs.length === 0 ? (
                <div className="debug-empty-state">
                  <Terminal size={28} />
                  <p>No log messages match the current filter.</p>
                </div>
              ) : (
                filteredLogs.map((log) => (
                  <div key={log.id} className={`debug-log-row level-${log.level}`}>
                    <span className="debug-log-ts">{formatTs(log.timestamp)}</span>
                    <span className={`debug-log-lvl level-${log.level}`}>
                      {log.level.toUpperCase()}
                    </span>
                    <span className="debug-log-cat">{log.category}</span>
                    <span className="debug-log-msg">{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
