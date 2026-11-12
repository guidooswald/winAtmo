import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Camera,
  Car,
  CheckCircle2,
  Clock,
  Film,
  HardDrive,
  Home,
  Image as ImageIcon,
  Lightbulb,
  PawPrint,
  Play,
  PlugZap,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  User,
  Users,
  Video,
  Wifi,
  X,
} from 'lucide-react';
import {
  AccountInfo,
  SecurityCamera,
  SecurityDataPayload,
  SecurityEvent,
  SecurityEventVideoResult,
  SecurityPerson,
} from '../types';
import { useI18n } from '../utils/i18n';
import { HlsVideoPlayer } from './HlsVideoPlayer';

interface SecurityViewProps {
  account: AccountInfo;
  onOpenSettings: () => void;
}

function getCameraModelLabel(type: string): string {
  switch (type) {
    case 'NACamera':
      return 'Smart Indoor Camera (Welcome)';
    case 'NOC':
    case 'NOC2':
      return 'Smart Outdoor Camera (Presence)';
    case 'NDB':
      return 'Smart Video Doorbell';
    case 'NPC':
      return 'Smart Indoor Camera Advance';
    default:
      return type;
  }
}

function formatSdStatus(sd: string | number | undefined): {
  label: string;
  tone: 'ok' | 'warn' | 'err';
} {
  if (sd === undefined || sd === null) return { label: '--', tone: 'warn' };
  const s = String(sd).toLowerCase();
  if (s === '4' || s === 'on' || s === 'ok') return { label: 'SD Card OK', tone: 'ok' };
  if (s === '1') return { label: 'No SD Card', tone: 'err' };
  if (s === '2') return { label: 'SD Unformatted', tone: 'warn' };
  if (s === '3') return { label: 'SD Error', tone: 'err' };
  if (s === '5') return { label: 'SD Full', tone: 'warn' };
  if (s === 'off') return { label: 'SD Off', tone: 'warn' };
  return { label: `SD (${sd})`, tone: 'ok' };
}

function formatPowerStatus(alim: string | number | undefined): {
  label: string;
  ok: boolean;
} {
  if (alim === undefined || alim === null) return { label: '--', ok: true };
  const s = String(alim).toLowerCase();
  if (s === '2' || s === 'on' || s === 'ok') return { label: 'Power OK', ok: true };
  if (s === '1' || s === 'off') return { label: 'Power Disconnected', ok: false };
  return { label: `Power (${alim})`, ok: true };
}

function formatWifiColor(state?: string, strength?: number): string {
  if (state === 'full' || state === 'good' || (strength !== undefined && strength <= 58)) {
    return '#10b981';
  }
  if (state === 'average' || (strength !== undefined && strength <= 72)) {
    return '#f59e0b';
  }
  return '#f43f5e';
}

function formatRelativeTime(tsSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - tsSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function classifyEventFilter(ev: SecurityEvent): string {
  const types = [
    ev.type,
    ev.category,
    ...(ev.subEvents?.map((s) => s.type) || []),
  ]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());

  if (types.some((t) => t.includes('call') || t.includes('doorbell') || t === 'rtc')) {
    return 'doorbell';
  }
  if (types.some((t) => t === 'vehicle' || t === 'car')) return 'vehicle';
  if (types.some((t) => t === 'animal')) return 'animal';
  if (types.some((t) => t === 'human' || t === 'person' || t === 'face')) {
    return 'human';
  }
  if (types.some((t) => t === 'movement' || t === 'outdoor')) return 'movement';
  return 'system';
}

function renderEventTypeIcon(typeStr: string, size = 14) {
  const t = typeStr.toLowerCase();
  if (t.includes('vehicle') || t === 'car') return <Car size={size} />;
  if (t.includes('animal')) return <PawPrint size={size} />;
  if (t.includes('human') || t.includes('person') || t.includes('face')) {
    return <User size={size} />;
  }
  if (t.includes('call') || t.includes('doorbell')) return <BellRing size={size} />;
  if (t.includes('movement') || t.includes('outdoor')) return <Camera size={size} />;
  return <Shield size={size} />;
}

export const SecurityView: React.FC<SecurityViewProps> = ({
  account,
  onOpenSettings,
}) => {
  const { formatDate, formatTime } = useI18n();
  const [data, setData] = useState<SecurityDataPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedHomeId, setSelectedHomeId] = useState<string>('all');
  const [selectedCameraId, setSelectedCameraId] = useState<string>('all');
  const [selectedPersonId, setSelectedPersonId] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  useEffect(() => {
    setSelectedPersonId('all');
  }, [selectedHomeId]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  const [reloadingImages, setReloadingImages] = useState<Record<string, boolean>>({});
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const [lightboxEvent, setLightboxEvent] = useState<SecurityEvent | null>(null);
  const [videoEvent, setVideoEvent] = useState<SecurityEvent | null>(null);
  const [videoLoading, setVideoLoading] = useState<boolean>(false);
  const [videoState, setVideoState] = useState<SecurityEventVideoResult | null>(null);

  const handleRefreshEventImage = useCallback(async (ev: SecurityEvent) => {
    if (typeof window.winatmo?.refreshSecurityEventImage !== 'function') {
      setImageErrors((prev) => ({
        ...prev,
        [ev.id]: 'Restart app (npm run dev) to enable image refresh.',
      }));
      return;
    }

    setReloadingImages((prev) => ({ ...prev, [ev.id]: true }));
    setImageErrors((prev) => {
      const next = { ...prev };
      delete next[ev.id];
      return next;
    });

    try {
      const candidateUrls = [
        ev.snapshotUrl,
        ev.vignetteUrl,
        ...(ev.subEvents?.flatMap((se) => [se.snapshotUrl, se.vignetteUrl]) || []),
      ].filter((u): u is string => Boolean(u));

      const res = await window.winatmo.refreshSecurityEventImage({
        homeId: ev.homeId,
        eventId: ev.id,
        cameraId: ev.cameraId,
        videoId: ev.videoId,
        candidateUrls,
      });

      if (res.ok && (res.imageUrl || res.vignetteUrl)) {
        const nextSnap = res.imageUrl || res.vignetteUrl;
        const nextVig = res.vignetteUrl || res.imageUrl;
        const applyUpdate = (target: SecurityEvent): SecurityEvent => ({
          ...(res.event ? { ...target, ...res.event } : target),
          snapshotUrl: nextSnap,
          vignetteUrl: nextVig,
          snapshotExpiresAt: res.snapshotExpiresAt ?? target.snapshotExpiresAt,
        });

        setData((prev) =>
          prev
            ? {
                ...prev,
                events: prev.events.map((item) =>
                  item.id === ev.id ? applyUpdate(item) : item
                ),
              }
            : prev
        );
        setLightboxEvent((prev) => (prev?.id === ev.id ? applyUpdate(prev) : prev));
        setVideoEvent((prev) => (prev?.id === ev.id ? applyUpdate(prev) : prev));
        setFailedImages((prev) => {
          const next = { ...prev };
          delete next[ev.id];
          return next;
        });
      } else {
        if (res.event) {
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  events: prev.events.map((item) =>
                    item.id === ev.id ? { ...item, ...res.event } : item
                  ),
                }
              : prev
          );
        }
        setImageErrors((prev) => ({
          ...prev,
          [ev.id]: res.error || 'No image available for this event.',
        }));
      }
    } catch (err: any) {
      setImageErrors((prev) => ({
        ...prev,
        [ev.id]: err?.message || 'Failed to reload image.',
      }));
    } finally {
      setReloadingImages((prev) => ({ ...prev, [ev.id]: false }));
    }
  }, []);

  const handleOpenVideo = useCallback(async (ev: SecurityEvent) => {
    setVideoEvent(ev);
    setVideoLoading(true);
    setVideoState(null);

    if (typeof window.winatmo?.getSecurityEventVideo !== 'function') {
      setVideoState({
        ok: false,
        error: 'Restart Electron (npm run dev) to load video streaming IPC.',
      });
      setVideoLoading(false);
      return;
    }

    try {
      const res = await window.winatmo.getSecurityEventVideo({
        homeId: ev.homeId,
        cameraId: ev.cameraId,
        eventId: ev.id,
        videoId: ev.videoId,
      });
      setVideoState(res);
    } catch (err: any) {
      setVideoState({
        ok: false,
        error: err?.message || 'Failed to load video stream.',
      });
    } finally {
      setVideoLoading(false);
    }
  }, []);

  const loadSecurity = useCallback(async () => {
    if (typeof window.winatmo?.getSecurityData !== 'function') {
      setError(
        'Preload API does not expose Security endpoints yet. Please restart Electron (npm run dev) to load the updated build.'
      );
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = await window.winatmo.getSecurityData({ size: 40 });
      setData(payload);
      setFailedImages({});
    } catch (err: any) {
      setError(err?.message || 'Failed to load Netatmo Security data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!account.loggedIn) return;
    let cancelled = false;

    const loadInitial = async () => {
      if (typeof window.winatmo?.getCachedSecurityData === 'function') {
        try {
          const cached = await window.winatmo.getCachedSecurityData();
          if (
            !cancelled &&
            (cached.homes.length > 0 || cached.events.length > 0)
          ) {
            setData(cached);
          }
        } catch {}
      }
      if (!cancelled) {
        await loadSecurity();
      }
    };

    loadInitial();

    const unsubCleared =
      typeof window.winatmo?.onSecurityCleared === 'function'
        ? window.winatmo.onSecurityCleared(() => {
            setData({ homes: [], events: [], fetchedAt: 0 });
            setFailedImages({});
            setImageErrors({});
          })
        : undefined;

    return () => {
      cancelled = true;
      unsubCleared?.();
    };
  }, [account.loggedIn, account.authMethod, loadSecurity]);

  const handleLoadOlder = async () => {
    if (!data || data.events.length === 0 || loadingMore) return;
    if (typeof window.winatmo?.getSecurityData !== 'function') return;

    const targetHomeId =
      selectedHomeId !== 'all'
        ? selectedHomeId
        : data.homes.length === 1
          ? data.homes[0].id
          : undefined;
    const scopedEvents = targetHomeId
      ? data.events.filter((e) => e.homeId === targetHomeId)
      : data.events;
    const oldest = scopedEvents[scopedEvents.length - 1];
    if (!oldest) return;

    setLoadingMore(true);
    try {
      const older = await window.winatmo.getSecurityData({
        homeId: targetHomeId,
        size: 40,
        offsetEventId: oldest.id,
      });
      if (older.events.length > 0) {
        setData((prev) => {
          if (!prev) return older;
          const seen = new Set(prev.events.map((e) => e.id));
          const merged = [...prev.events];
          for (const ev of older.events) {
            if (!seen.has(ev.id)) {
              seen.add(ev.id);
              merged.push(ev);
            }
          }
          merged.sort((a, b) => b.time - a.time);
          return {
            ...prev,
            events: merged,
            fetchedAt: older.fetchedAt,
          };
        });
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load older events.');
    } finally {
      setLoadingMore(false);
    }
  };

  const homes = data?.homes || [];
  const allCameras: SecurityCamera[] = useMemo(() => {
    return homes
      .filter((h) => selectedHomeId === 'all' || h.id === selectedHomeId)
      .flatMap((h) => h.cameras);
  }, [homes, selectedHomeId]);

  const allPersons: SecurityPerson[] = useMemo(() => {
    return homes
      .filter((h) => selectedHomeId === 'all' || h.id === selectedHomeId)
      .flatMap((h) => h.persons);
  }, [homes, selectedHomeId]);

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const selectedPerson =
      selectedPersonId !== 'all'
        ? allPersons.find((p) => p.id === selectedPersonId)
        : undefined;
    return (data?.events || []).filter((ev) => {
      if (selectedHomeId !== 'all' && ev.homeId !== selectedHomeId) return false;
      if (selectedCameraId !== 'all' && ev.cameraId !== selectedCameraId) {
        return false;
      }
      if (selectedPersonId !== 'all') {
        const matchesId = ev.personId === selectedPersonId;
        const matchesName =
          Boolean(selectedPerson?.pseudo) &&
          ev.personName === selectedPerson?.pseudo;
        if (!matchesId && !matchesName) return false;
      }
      if (typeFilter !== 'all' && classifyEventFilter(ev) !== typeFilter) {
        return false;
      }
      if (q) {
        const hay = [
          ev.message,
          ev.cameraName,
          ev.personName,
          ev.type,
          ev.category,
          ...(ev.subEvents?.map((s) => `${s.type} ${s.message || ''}`) || []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    data?.events,
    selectedHomeId,
    selectedCameraId,
    selectedPersonId,
    allPersons,
    typeFilter,
    searchQuery,
  ]);

  const onlineCameraCount = allCameras.filter(
    (c) => (c.monitoring || c.status) === 'on'
  ).length;

  return (
    <div className="security-container">
      {/* Top Action & Filter Bar */}
      <div className="security-topbar">
        <div className="security-topbar-left">
          <div className="security-heading-group">
            <Shield size={18} className="accent-icon" />
            <div>
              <h2>Netatmo Security &amp; Cameras</h2>
              <span>
                {allCameras.length} camera{allCameras.length === 1 ? '' : 's'} (
                {onlineCameraCount} monitoring) • {filteredEvents.length} event
                {filteredEvents.length === 1 ? '' : 's'}
                {data?.fetchedAt
                  ? ` • Updated ${formatTime(data.fetchedAt)}`
                  : ''}
              </span>
            </div>
          </div>

          {homes.length > 1 && (
            <select
              className="select-input"
              value={selectedHomeId}
              onChange={(e) => {
                setSelectedHomeId(e.target.value);
                setSelectedCameraId('all');
              }}
            >
              <option value="all">All Homes ({homes.length})</option>
              {homes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="security-topbar-actions">
          <button
            type="button"
            className="action-btn primary"
            onClick={loadSecurity}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            {loading ? 'Refreshing...' : 'Refresh Cameras & Events'}
          </button>
        </div>
      </div>

      {/* Scope Warning Banner if OAuth/Token lacks camera scopes */}
      {data?.scopeError && (
        <div className="security-scope-banner">
          <ShieldAlert size={18} />
          <div className="security-scope-text">
            <strong>Camera Permissions Required</strong>
            <p>
              Netatmo returned: <code>{data.scopeError}</code>. Make sure your
              session includes <code>read_camera</code>, <code>read_presence</code>,
              and <code>read_doorbell</code> scopes. If you use OAuth2 or a Personal
              Token, re-authorize in Settings to grant camera read access.
            </p>
          </div>
          <button
            type="button"
            className="action-btn subtle"
            onClick={onOpenSettings}
          >
            <Settings size={14} /> Open Settings
          </button>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Two-Column Main Layout: Events (left) + Camera Status & Known Persons (right) */}
      <div className="security-main-columns">
        {/* Camera Hardware Status Cards (Right Column) */}
        <section className="security-section security-cameras-col">
          <div className="security-section-header">
            <h3>
              <Video size={16} /> Camera Status ({allCameras.length})
            </h3>
          {selectedCameraId !== 'all' && (
            <button
              type="button"
              className="pill-btn active"
              onClick={() => setSelectedCameraId('all')}
            >
              Showing 1 camera • Clear filter ×
            </button>
          )}
        </div>

        {loading && !data ? (
          <div className="security-empty-card">
            <RefreshCw size={22} className="spin" />
            <span>Loading cameras &amp; live status from Netatmo...</span>
          </div>
        ) : allCameras.length === 0 ? (
          <div className="security-empty-card">
            <Camera size={24} />
            <div>
              <strong>No Netatmo Security Cameras Found</strong>
              <p>
                No Welcome, Presence, or Doorbell cameras were returned for this
                account (or camera read scopes have not been authorized yet).
              </p>
            </div>
          </div>
        ) : (
          <div className="security-cameras-grid">
            {allCameras.map((cam) => {
              const isMonitoring = (cam.monitoring || cam.status) === 'on';
              const isSelected = selectedCameraId === cam.id;
              const sd = formatSdStatus(cam.sdStatus);
              const power = formatPowerStatus(cam.alimStatus);
              const wifiColor = formatWifiColor(cam.wifiState, cam.wifiStrength);

              return (
                <div
                  key={cam.id}
                  className={`security-camera-card ${
                    isSelected ? 'selected' : ''
                  } ${isMonitoring ? 'is-on' : 'is-off'}`}
                  onClick={() =>
                    setSelectedCameraId((prev) =>
                      prev === cam.id ? 'all' : cam.id
                    )
                  }
                  title="Click to filter event timeline by this camera"
                >
                  <div className="camera-card-top">
                    <div className="camera-title-wrap">
                      <div className="camera-name-row">
                        <Camera size={16} />
                        <h4>{cam.name}</h4>
                      </div>
                      <span className="camera-model-sub">
                        {getCameraModelLabel(cam.type)}
                      </span>
                    </div>

                    <span
                      className={`camera-status-pill ${
                        isMonitoring ? 'on' : 'off'
                      }`}
                    >
                      {isMonitoring ? (
                        <>
                          <CheckCircle2 size={12} /> Monitoring ON
                        </>
                      ) : (
                        <>
                          <AlertTriangle size={12} /> Standby / OFF
                        </>
                      )}
                    </span>
                  </div>

                  <div className="camera-meta-tags">
                    <span className="camera-meta-chip">
                      <Home size={11} /> {cam.homeName}
                      {cam.roomName ? ` • ${cam.roomName}` : ''}
                    </span>
                    <span className="code-badge">{cam.type}</span>
                    {cam.isLocal !== undefined && (
                      <span className="camera-meta-chip">
                        {cam.isLocal ? 'Local LAN' : 'Cloud'}
                      </span>
                    )}
                  </div>

                  <div className="camera-health-grid">
                    <div className="camera-health-item">
                      <Wifi size={13} style={{ color: wifiColor }} />
                      <span>
                        {cam.wifiState
                          ? `Wi-Fi: ${cam.wifiState}`
                          : 'Wi-Fi'}
                        {cam.wifiStrength !== undefined
                          ? ` (${cam.wifiStrength} dB)`
                          : ''}
                      </span>
                    </div>

                    <div className={`camera-health-item tone-${sd.tone}`}>
                      <HardDrive size={13} />
                      <span>{sd.label}</span>
                    </div>

                    <div
                      className={`camera-health-item ${
                        power.ok ? 'tone-ok' : 'tone-err'
                      }`}
                    >
                      <PlugZap size={13} />
                      <span>{power.label}</span>
                    </div>

                    {cam.floodlight !== undefined && (
                      <div className="camera-health-item">
                        <Lightbulb size={13} />
                        <span>Floodlight: {cam.floodlight}</span>
                      </div>
                    )}
                  </div>

                  <div className="camera-card-footer">
                    <span>
                      MAC: <code>{cam.id}</code>
                    </span>
                    <span>
                      {cam.firmwareRevision !== undefined
                        ? `FW ${cam.firmwareRevision}`
                        : ''}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Known Persons (Home / Away presence dropdown) */}
        {allPersons.length > 0 && (() => {
          const homeCount = allPersons.filter((p) => !p.outOfSight).length;
          const activePerson =
            selectedPersonId !== 'all'
              ? allPersons.find((p) => p.id === selectedPersonId)
              : undefined;
          return (
            <div className="security-persons-dropdown-card">
              <div className="persons-dropdown-header">
                <label
                  htmlFor="security-persons-select"
                  className="persons-bar-label"
                >
                  <Users size={13} /> Known Persons ({allPersons.length})
                </label>
                <span className="persons-presence-summary">
                  {homeCount} at home • {allPersons.length - homeCount} away
                </span>
              </div>
              <select
                id="security-persons-select"
                className="select-input security-persons-select"
                value={selectedPersonId}
                onChange={(e) => setSelectedPersonId(e.target.value)}
              >
                <option value="all">
                  All Known Persons ({allPersons.length})
                </option>
                {allPersons.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.pseudo || 'Unknown'} —{' '}
                    {p.outOfSight ? 'Away' : 'At Home'}
                  </option>
                ))}
              </select>
              {activePerson && (
                <div className="persons-selected-meta">
                  <span
                    className={`presence-dot ${
                      activePerson.outOfSight ? 'away' : 'home'
                    }`}
                  />
                  <span>
                    {activePerson.pseudo || 'Unknown'} is{' '}
                    <strong>
                      {activePerson.outOfSight ? 'Away' : 'At Home'}
                    </strong>
                    {activePerson.lastSeen
                      ? ` • Last seen ${formatDate(
                          activePerson.lastSeen * 1000
                        )} ${formatTime(activePerson.lastSeen * 1000)}`
                      : ''}
                  </span>
                </div>
              )}
            </div>
          );
        })()}
      </section>

      {/* Event List Section (Left Column) */}
      <section className="security-section security-events-col">
        <div className="security-section-header">
          <h3>
            <Shield size={16} /> Events ({filteredEvents.length})
          </h3>
          {selectedPersonId !== 'all' && (
            <button
              type="button"
              className="pill-btn active"
              onClick={() => setSelectedPersonId('all')}
            >
              Person filter active • Clear ×
            </button>
          )}
        </div>

        <div className="security-events-toolbar">
          <div className="pill-group">
            {(
              [
                ['all', 'All Events'],
                ['human', 'Person / Human'],
                ['vehicle', 'Vehicle'],
                ['animal', 'Animal'],
                ['movement', 'Motion'],
                ['doorbell', 'Doorbell'],
                ['system', 'System'],
              ] as Array<[string, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`pill-btn ${typeFilter === id ? 'active' : ''}`}
                onClick={() => setTypeFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="security-events-filters-right">
            <select
              className="select-input"
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
            >
              <option value="all">All Cameras ({allCameras.length})</option>
              {allCameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="debug-search-box">
              <Search size={13} />
              <input
                type="text"
                placeholder="Search events, person, camera..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="security-events-list">
          {loading && !data ? (
            <div className="security-empty-card">
              <RefreshCw size={20} className="spin" />
              <span>Loading camera event timeline...</span>
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="security-empty-card">
              <ShieldCheck size={24} />
              <div>
                <strong>No Events Found</strong>
                <p>
                  No security events match your current filters, or your cameras
                  have no recent events recorded.
                </p>
              </div>
            </div>
          ) : (
            filteredEvents.map((ev) => {
              const imgUrl = ev.snapshotUrl || ev.vignetteUrl;
              const imgFailed = failedImages[ev.id];
              const isReloadingImg = Boolean(reloadingImages[ev.id]);
              const imgErrorMsg = imageErrors[ev.id];
              const hasVideo =
                Boolean(ev.videoId || ev.videoStatus === 'available') &&
                ev.videoStatus !== 'deleted';
              const filterKind = classifyEventFilter(ev);
              const subTypes = ev.subEvents?.map((s) => s.type) || [];

              return (
                <div key={ev.id} className="security-event-row">
                  <div
                    className={`event-thumb-box clickable ${
                      !imgUrl || imgFailed ? 'missing' : ''
                    }`}
                    onClick={() => {
                      if (imgUrl && !imgFailed) {
                        setLightboxEvent(ev);
                      } else if (!isReloadingImg) {
                        handleRefreshEventImage(ev);
                      }
                    }}
                    title={
                      imgUrl && !imgFailed
                        ? 'Click to enlarge snapshot'
                        : 'Click to reload or fetch snapshot from Netatmo'
                    }
                  >
                    {imgUrl && !imgFailed ? (
                      <img
                        src={imgUrl}
                        alt={ev.message}
                        loading="lazy"
                        onError={() =>
                          setFailedImages((prev) => ({
                            ...prev,
                            [ev.id]: true,
                          }))
                        }
                      />
                    ) : (
                      <div className={`event-thumb-fallback kind-${filterKind}`}>
                        {isReloadingImg ? (
                          <RefreshCw size={20} className="spin" />
                        ) : (
                          renderEventTypeIcon(ev.category || ev.type, 22)
                        )}
                      </div>
                    )}
                  </div>

                  <div className="event-main-info">
                    <div className="event-badges-row">
                      <span className={`event-type-pill kind-${filterKind}`}>
                        {renderEventTypeIcon(ev.category || ev.type, 12)}
                        <span>{ev.category || ev.type}</span>
                      </span>

                      {subTypes.map((st, i) => (
                        <span
                          key={`${ev.id}-sub-${i}`}
                          className="event-sub-pill"
                        >
                          {st}
                        </span>
                      ))}

                      {ev.personName && (
                        <span className="event-person-pill">
                          <User size={11} /> {ev.personName}
                        </span>
                      )}

                      {hasVideo && (
                        <span className="event-video-pill">
                          <Film size={11} /> Clip recorded
                        </span>
                      )}
                    </div>

                    <div className="event-message-text">{ev.message}</div>

                    <div className="event-meta-footer">
                      {ev.cameraName && (
                        <span>
                          <Camera size={12} /> {ev.cameraName}
                        </span>
                      )}
                      <span>
                        <Home size={12} /> {ev.homeName}
                      </span>
                      {imgUrl && !imgFailed && (
                        <button
                          type="button"
                          className="event-snapshot-link"
                          onClick={() => setLightboxEvent(ev)}
                        >
                          <ImageIcon size={12} /> View Snapshot
                        </button>
                      )}
                      <button
                        type="button"
                        className={`event-media-btn ${
                          !imgUrl || imgFailed ? 'reload' : 'subtle'
                        }`}
                        onClick={() => handleRefreshEventImage(ev)}
                        disabled={isReloadingImg}
                        title={
                          imgUrl && !imgFailed
                            ? 'Refresh / update snapshot from Netatmo'
                            : 'Try to load snapshot from Netatmo'
                        }
                      >
                        <RefreshCw
                          size={11}
                          className={isReloadingImg ? 'spin' : ''}
                        />
                        {isReloadingImg
                          ? 'Loading...'
                          : imgUrl && !imgFailed
                            ? 'Update Image'
                            : imgFailed
                              ? 'Retry Image'
                              : 'Load Image'}
                      </button>
                      {hasVideo && (
                        <button
                          type="button"
                          className="event-media-btn video"
                          onClick={() => handleOpenVideo(ev)}
                        >
                          <Play size={11} /> View Video
                        </button>
                      )}
                    </div>
                    {imgErrorMsg && (
                      <div className="event-media-note">{imgErrorMsg}</div>
                    )}
                  </div>

                  <div className="event-time-col">
                    <span className="event-rel-time">
                      <Clock size={12} /> {formatRelativeTime(ev.time)}
                    </span>
                    <span className="event-abs-time">
                      {formatDate(ev.time * 1000)} •{' '}
                      {formatTime(ev.time * 1000)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {(data?.events.length || 0) > 0 && account.authMethod !== 'demo' && (
          <div className="security-load-more-row">
            <button
              type="button"
              className="action-btn subtle"
              onClick={handleLoadOlder}
              disabled={loadingMore}
            >
              <RefreshCw size={13} className={loadingMore ? 'spin' : ''} />
              {loadingMore ? 'Loading older events...' : 'Load Older Events'}
            </button>
          </div>
        )}
      </section>
      </div>

      {/* Snapshot Lightbox Modal */}
      {lightboxEvent && (
        <div
          className="modal-backdrop"
          onClick={() => setLightboxEvent(null)}
        >
          <div
            className="security-lightbox-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="security-lightbox-header">
              <div>
                <h4>{lightboxEvent.message}</h4>
                <span>
                  {lightboxEvent.cameraName} •{' '}
                  {formatDate(lightboxEvent.time * 1000)}{' '}
                  {formatTime(lightboxEvent.time * 1000)}
                </span>
              </div>
              <div className="security-lightbox-actions">
                <button
                  type="button"
                  className="action-btn subtle"
                  disabled={Boolean(reloadingImages[lightboxEvent.id])}
                  onClick={() => handleRefreshEventImage(lightboxEvent)}
                >
                  <RefreshCw
                    size={13}
                    className={reloadingImages[lightboxEvent.id] ? 'spin' : ''}
                  />
                  {reloadingImages[lightboxEvent.id]
                    ? 'Updating...'
                    : 'Update Image'}
                </button>
                {(lightboxEvent.videoId ||
                  lightboxEvent.videoStatus === 'available') &&
                  lightboxEvent.videoStatus !== 'deleted' && (
                    <button
                      type="button"
                      className="action-btn primary"
                      onClick={() => {
                        const target = lightboxEvent;
                        setLightboxEvent(null);
                        handleOpenVideo(target);
                      }}
                    >
                      <Play size={13} /> View Video
                    </button>
                  )}
                <button
                  type="button"
                  className="sync-overlay-close-btn"
                  onClick={() => setLightboxEvent(null)}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="security-lightbox-img-wrap">
              <img
                src={lightboxEvent.snapshotUrl || lightboxEvent.vignetteUrl}
                alt={lightboxEvent.message}
              />
            </div>
            {lightboxEvent.subEvents && lightboxEvent.subEvents.length > 0 && (
              <div className="security-lightbox-subevents">
                {lightboxEvent.subEvents.map((se, i) => (
                  <div key={i} className="lightbox-sub-item">
                    <strong>{se.type}</strong>
                    <span>{se.message || formatTime(se.time * 1000)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recorded Event Video Player Modal */}
      {videoEvent && (
        <div
          className="modal-backdrop"
          onClick={() => setVideoEvent(null)}
        >
          <div
            className="security-lightbox-card security-video-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="security-lightbox-header">
              <div>
                <h4>{videoEvent.message}</h4>
                <span>
                  {videoEvent.cameraName} •{' '}
                  {formatDate(videoEvent.time * 1000)}{' '}
                  {formatTime(videoEvent.time * 1000)}
                  {videoState?.ok && (
                    <>
                      {' • '}
                      {videoState.isDemo
                        ? 'Demo Preview'
                        : videoState.hlsUrl &&
                            videoState.localHlsUrl === videoState.hlsUrl
                          ? 'Local Camera Stream'
                          : 'Netatmo Cloud VPN Stream'}
                    </>
                  )}
                </span>
              </div>
              <div className="security-lightbox-actions">
                <button
                  type="button"
                  className="action-btn subtle"
                  disabled={videoLoading}
                  onClick={() => handleOpenVideo(videoEvent)}
                >
                  <RefreshCw
                    size={13}
                    className={videoLoading ? 'spin' : ''}
                  />
                  Reload Stream
                </button>
                {(videoEvent.snapshotUrl || videoEvent.vignetteUrl) &&
                  !failedImages[videoEvent.id] && (
                    <button
                      type="button"
                      className="action-btn subtle"
                      onClick={() => {
                        const target = videoEvent;
                        setVideoEvent(null);
                        setLightboxEvent(target);
                      }}
                    >
                      <ImageIcon size={13} /> View Snapshot
                    </button>
                  )}
                <button
                  type="button"
                  className="sync-overlay-close-btn"
                  onClick={() => setVideoEvent(null)}
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {videoLoading ? (
              <div className="security-video-status-card">
                <RefreshCw size={22} className="spin" />
                <span>Resolving camera stream from Netatmo...</span>
              </div>
            ) : !videoState?.ok ? (
              <div className="security-video-status-card error">
                <AlertTriangle size={22} />
                <div>
                  <strong>Video Unavailable</strong>
                  <p>{videoState?.error || 'Could not load video clip.'}</p>
                </div>
                <button
                  type="button"
                  className="action-btn subtle"
                  onClick={() => handleOpenVideo(videoEvent)}
                >
                  <RefreshCw size={13} /> Retry
                </button>
              </div>
            ) : (
              <HlsVideoPlayer
                hlsUrl={videoState.hlsUrl}
                fallbackUrls={videoState.fallbackHlsUrls}
                posterUrl={videoEvent.snapshotUrl || videoEvent.vignetteUrl}
                isDemo={videoState.isDemo}
                onRetryResolve={() => handleOpenVideo(videoEvent)}
              />
            )}

            {videoEvent.subEvents && videoEvent.subEvents.length > 0 && (
              <div className="security-lightbox-subevents">
                {videoEvent.subEvents.map((se, i) => (
                  <div key={i} className="lightbox-sub-item">
                    <strong>{se.type}</strong>
                    <span>{se.message || formatTime(se.time * 1000)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
