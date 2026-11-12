import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import {
  MeasurePoint,
  MetricType,
  NetatmoScale,
  SecurityCamera,
  SecurityDataPayload,
  SecurityEvent,
  SecurityHome,
  SecurityPerson,
  SecuritySubEvent,
  SeriesStats,
  StorageStats,
} from '../renderer/types';

export interface BatchMeasurementRow {
  stationId: string;
  moduleId: string;
  metric: MetricType;
  scale: NetatmoScale;
  ts: number;
  value: number;
}

export class TimeSeriesDatabase {
  private db: DatabaseSync;
  private dbPath: string;

  constructor() {
    const userDataDir = app.getPath('userData');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    this.dbPath = path.join(userDataDir, 'winatmo-history.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -16000;

      CREATE TABLE IF NOT EXISTS measurements (
        station_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        scale TEXT NOT NULL,
        ts INTEGER NOT NULL,
        val REAL NOT NULL,
        PRIMARY KEY (module_id, metric, scale, ts)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS sync_log (
        module_id TEXT NOT NULL,
        scale TEXT NOT NULL,
        min_ts INTEGER NOT NULL,
        max_ts INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (module_id, scale)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_measurements_scale ON measurements (scale);

      CREATE TABLE IF NOT EXISTS security_homes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS security_cameras (
        id TEXT PRIMARY KEY,
        home_id TEXT NOT NULL,
        home_name TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        room_name TEXT,
        monitoring TEXT,
        status TEXT,
        sd_status TEXT,
        alim_status TEXT,
        wifi_strength INTEGER,
        wifi_state TEXT,
        firmware_revision TEXT,
        is_local INTEGER,
        floodlight TEXT,
        siren_status TEXT,
        last_setup INTEGER,
        vpn_url TEXT,
        local_url TEXT,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS security_persons (
        id TEXT PRIMARY KEY,
        home_id TEXT NOT NULL,
        pseudo TEXT,
        out_of_sight INTEGER,
        last_seen INTEGER,
        face_url TEXT,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS security_events (
        id TEXT PRIMARY KEY,
        home_id TEXT NOT NULL,
        home_name TEXT NOT NULL,
        camera_id TEXT,
        camera_name TEXT,
        type TEXT NOT NULL,
        sub_type INTEGER,
        time INTEGER NOT NULL,
        category TEXT,
        message TEXT NOT NULL,
        person_id TEXT,
        person_name TEXT,
        snapshot_url TEXT,
        snapshot_expires_at INTEGER,
        vignette_url TEXT,
        video_id TEXT,
        video_status TEXT,
        sub_events_json TEXT,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_security_events_home_time ON security_events (home_id, time DESC);
      CREATE INDEX IF NOT EXISTS idx_security_events_time ON security_events (time DESC);
    `);
  }

  public insertBatch(rows: BatchMeasurementRow[]): number {
    if (rows.length === 0) return 0;

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO measurements (station_id, module_id, metric, scale, ts, val)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        if (
          r.value === null ||
          r.value === undefined ||
          Number.isNaN(r.value)
        ) {
          continue;
        }
        insertStmt.run(
          r.stationId,
          r.moduleId,
          r.metric,
          r.scale,
          Math.floor(r.ts),
          Number(r.value)
        );
        inserted++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return inserted;
  }

  public updateSyncCoverage(
    moduleId: string,
    scale: NetatmoScale,
    minTs: number,
    maxTs: number
  ): void {
    const existing = this.getSyncCoverage(moduleId, scale);
    const newMin = existing ? Math.min(existing.minTs, minTs) : minTs;
    const newMax = existing ? Math.max(existing.maxTs, maxTs) : maxTs;
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sync_log (module_id, scale, min_ts, max_ts, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(moduleId, scale, Math.floor(newMin), Math.floor(newMax), now);
  }

  public getSyncCoverage(
    moduleId: string,
    scale: NetatmoScale
  ): { minTs: number; maxTs: number; updatedAt: number } | null {
    const stmt = this.db.prepare(`
      SELECT min_ts, max_ts, updated_at
      FROM sync_log
      WHERE module_id = ? AND scale = ?
    `);
    const row = stmt.get(moduleId, scale) as
      | { min_ts: number; max_ts: number; updated_at: number }
      | undefined;
    if (!row) {
      // Fallback: check actual table bounds
      const boundStmt = this.db.prepare(`
        SELECT MIN(ts) as min_ts, MAX(ts) as max_ts, COUNT(*) as cnt
        FROM measurements
        WHERE module_id = ? AND scale = ?
      `);
      const b = boundStmt.get(moduleId, scale) as
        | { min_ts: number | null; max_ts: number | null; cnt: number }
        | undefined;
      if (b && b.cnt > 0 && b.min_ts !== null && b.max_ts !== null) {
        return {
          minTs: b.min_ts,
          maxTs: b.max_ts,
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
      return null;
    }
    return {
      minTs: Number(row.min_ts),
      maxTs: Number(row.max_ts),
      updatedAt: Number(row.updated_at),
    };
  }

  public queryPoints(
    moduleId: string,
    metric: MetricType,
    scale: NetatmoScale,
    dateBegin: number,
    dateEnd: number
  ): MeasurePoint[] {
    const stmt = this.db.prepare(`
      SELECT ts, val
      FROM measurements
      WHERE module_id = ?
        AND metric = ?
        AND scale = ?
        AND ts >= ?
        AND ts <= ?
      ORDER BY ts ASC
    `);
    const rows = stmt.all(
      moduleId,
      metric,
      scale,
      Math.floor(dateBegin),
      Math.floor(dateEnd)
    ) as Array<{ ts: number; val: number }>;

    if (rows.length > 0) {
      return rows.map((r) => ({ ts: Number(r.ts), value: Number(r.val) }));
    }

    // Smart local aggregation fallback: if requested scale isn't directly in DB yet,
    // aggregate from '30min' or 'max' if present in DB!
    const bucketSeconds = this.getScaleSeconds(scale);
    const fallbackStmt = this.db.prepare(`
      SELECT
        CAST(ts / ? AS INTEGER) * ? AS bucket_ts,
        AVG(val) AS avg_val,
        SUM(val) AS sum_val
      FROM measurements
      WHERE module_id = ?
        AND metric = ?
        AND scale IN ('30min', 'max', '1hour')
        AND ts >= ?
        AND ts <= ?
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `);
    const aggRows = fallbackStmt.all(
      bucketSeconds,
      bucketSeconds,
      moduleId,
      metric,
      Math.floor(dateBegin),
      Math.floor(dateEnd)
    ) as Array<{ bucket_ts: number; avg_val: number; sum_val: number }>;

    const isCumulativeRain = metric === 'rain' || metric === 'sum_rain';
    return aggRows.map((r) => ({
      ts: Number(r.bucket_ts),
      value: Number(
        (isCumulativeRain ? r.sum_val : r.avg_val).toFixed(2)
      ),
    }));
  }

  public computeStats(points: MeasurePoint[]): SeriesStats {
    if (points.length === 0) {
      return {
        min: 0,
        max: 0,
        avg: 0,
        latest: 0,
        first: 0,
        delta: 0,
        count: 0,
      };
    }
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const p of points) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
      sum += p.value;
    }
    const first = points[0].value;
    const latest = points[points.length - 1].value;
    return {
      min: Number(min.toFixed(2)),
      max: Number(max.toFixed(2)),
      avg: Number((sum / points.length).toFixed(2)),
      latest: Number(latest.toFixed(2)),
      first: Number(first.toFixed(2)),
      delta: Number((latest - first).toFixed(2)),
      count: points.length,
    };
  }

  public getScaleSeconds(scale: NetatmoScale): number {
    switch (scale) {
      case 'max':
        return 300; // 5 min
      case '30min':
        return 1800;
      case '1hour':
        return 3600;
      case '3hours':
        return 10800;
      case '1day':
        return 86400;
      case '1week':
        return 604800;
      case '1month':
        return 2592000;
      default:
        return 1800;
    }
  }

  public getStorageStats(): StorageStats {
    let fileSizeBytes = 0;
    try {
      if (fs.existsSync(this.dbPath)) {
        fileSizeBytes += fs.statSync(this.dbPath).size;
      }
      if (fs.existsSync(this.dbPath + '-wal')) {
        fileSizeBytes += fs.statSync(this.dbPath + '-wal').size;
      }
    } catch {}

    const syncSummaryStmt = this.db.prepare(`
      SELECT
        COUNT(DISTINCT module_id) as module_count,
        MIN(min_ts) as oldest_ts,
        MAX(max_ts) as newest_ts
      FROM sync_log
    `);
    const syncSummary = syncSummaryStmt.get() as
      | {
          module_count: number;
          oldest_ts: number | null;
          newest_ts: number | null;
        }
      | undefined;

    const totalStmt = this.db.prepare(`
      SELECT COUNT(*) as total_points FROM measurements
    `);
    const totalRow = totalStmt.get() as { total_points: number } | undefined;

    const byScaleStmt = this.db.prepare(`
      SELECT
        scale,
        COUNT(*) as cnt
      FROM measurements
      GROUP BY scale
      ORDER BY cnt DESC
    `);
    const byScaleRows = byScaleStmt.all() as Array<{
      scale: string;
      cnt: number;
    }>;

    const scaleRangeStmt = this.db.prepare(`
      SELECT
        scale,
        MIN(min_ts) as oldest,
        MAX(max_ts) as newest
      FROM sync_log
      GROUP BY scale
    `);
    const scaleRangeRows = scaleRangeStmt.all() as Array<{
      scale: string;
      oldest: number;
      newest: number;
    }>;
    const rangeMap = new Map<string, { oldest: number; newest: number }>();
    for (const sr of scaleRangeRows) {
      rangeMap.set(sr.scale, {
        oldest: Number(sr.oldest || 0),
        newest: Number(sr.newest || 0),
      });
    }

    const secEventsRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM security_events')
      .get() as { cnt: number } | undefined;
    const secCamsRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM security_cameras')
      .get() as { cnt: number } | undefined;
    const secPersonsRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM security_persons')
      .get() as { cnt: number } | undefined;

    return {
      dbPath: this.dbPath,
      fileSizeBytes,
      totalPoints: Number(totalRow?.total_points || 0),
      moduleCount: Number(syncSummary?.module_count || 0),
      oldestTimestamp: syncSummary?.oldest_ts
        ? Number(syncSummary.oldest_ts)
        : null,
      newestTimestamp: syncSummary?.newest_ts
        ? Number(syncSummary.newest_ts)
        : null,
      securityEventsCount: Number(secEventsRow?.cnt || 0),
      securityCamerasCount: Number(secCamsRow?.cnt || 0),
      securityPersonsCount: Number(secPersonsRow?.cnt || 0),
      byScale: byScaleRows.map((r) => {
        const rng = rangeMap.get(r.scale);
        return {
          scale: r.scale,
          count: Number(r.cnt),
          oldest: rng?.oldest || 0,
          newest: rng?.newest || 0,
        };
      }),
    };
  }

  public getKnownSecurityEventIds(homeId?: string): Set<string> {
    const rows = homeId
      ? (this.db
          .prepare('SELECT id FROM security_events WHERE home_id = ?')
          .all(homeId) as Array<{ id: string }>)
      : (this.db.prepare('SELECT id FROM security_events').all() as Array<{
          id: string;
        }>);
    return new Set(rows.map((r) => String(r.id)));
  }

  public upsertSecurityData(payload: {
    homes: SecurityHome[];
    events: SecurityEvent[];
  }): number {
    const now = Math.floor(Date.now() / 1000);

    const upsertHomeStmt = this.db.prepare(`
      INSERT OR REPLACE INTO security_homes (id, name, timezone, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const deleteCamsForHomeStmt = this.db.prepare(
      'DELETE FROM security_cameras WHERE home_id = ?'
    );
    const deletePersonsForHomeStmt = this.db.prepare(
      'DELETE FROM security_persons WHERE home_id = ?'
    );
    const upsertCamStmt = this.db.prepare(`
      INSERT OR REPLACE INTO security_cameras (
        id, home_id, home_name, name, type, room_name, monitoring, status,
        sd_status, alim_status, wifi_strength, wifi_state, firmware_revision,
        is_local, floodlight, siren_status, last_setup, vpn_url, local_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertPersonStmt = this.db.prepare(`
      INSERT OR REPLACE INTO security_persons (
        id, home_id, pseudo, out_of_sight, last_seen, face_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const selectExistingImagesStmt = this.db.prepare(`
      SELECT snapshot_url, vignette_url, snapshot_expires_at
      FROM security_events
      WHERE id = ?
    `);
    const upsertEventStmt = this.db.prepare(`
      INSERT OR REPLACE INTO security_events (
        id, home_id, home_name, camera_id, camera_name, type, sub_type, time,
        category, message, person_id, person_name, snapshot_url, snapshot_expires_at,
        vignette_url, video_id, video_status, sub_events_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let upsertedEvents = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const home of payload.homes) {
        upsertHomeStmt.run(home.id, home.name, home.timezone ?? null, now);

        deleteCamsForHomeStmt.run(home.id);
        for (const cam of home.cameras) {
          upsertCamStmt.run(
            cam.id,
            cam.homeId,
            cam.homeName,
            cam.name,
            cam.type,
            cam.roomName ?? null,
            cam.monitoring ?? null,
            cam.status ?? null,
            cam.sdStatus !== undefined ? String(cam.sdStatus) : null,
            cam.alimStatus !== undefined ? String(cam.alimStatus) : null,
            cam.wifiStrength !== undefined ? Number(cam.wifiStrength) : null,
            cam.wifiState ?? null,
            cam.firmwareRevision !== undefined
              ? String(cam.firmwareRevision)
              : null,
            cam.isLocal !== undefined ? (cam.isLocal ? 1 : 0) : null,
            cam.floodlight ?? null,
            cam.sirenStatus ?? null,
            cam.lastSetup !== undefined ? Number(cam.lastSetup) : null,
            cam.vpnUrl ?? null,
            cam.localUrl ?? null,
            now
          );
        }

        deletePersonsForHomeStmt.run(home.id);
        for (const p of home.persons) {
          upsertPersonStmt.run(
            p.id,
            p.homeId,
            p.pseudo ?? null,
            p.outOfSight !== undefined ? (p.outOfSight ? 1 : 0) : null,
            p.lastSeen !== undefined ? Number(p.lastSeen) : null,
            p.faceUrl ?? null,
            now
          );
        }
      }

      for (const ev of payload.events) {
        const existing = selectExistingImagesStmt.get(ev.id) as
          | {
              snapshot_url: string | null;
              vignette_url: string | null;
              snapshot_expires_at: number | null;
            }
          | undefined;

        const hasIncomingDataUri = Boolean(
          ev.snapshotUrl?.startsWith('data:') || ev.vignetteUrl?.startsWith('data:')
        );
        const hasExistingDataUri = Boolean(
          existing?.snapshot_url?.startsWith('data:') ||
            existing?.vignette_url?.startsWith('data:')
        );

        const finalSnapshotUrl =
          hasExistingDataUri && !hasIncomingDataUri
            ? existing?.snapshot_url ?? null
            : ev.snapshotUrl ?? existing?.snapshot_url ?? null;
        const finalVignetteUrl =
          hasExistingDataUri && !hasIncomingDataUri
            ? existing?.vignette_url ?? null
            : ev.vignetteUrl ?? existing?.vignette_url ?? null;
        const finalExpiresAt =
          ev.snapshotExpiresAt !== undefined
            ? Number(ev.snapshotExpiresAt)
            : existing?.snapshot_expires_at ?? null;

        upsertEventStmt.run(
          ev.id,
          ev.homeId,
          ev.homeName,
          ev.cameraId ?? null,
          ev.cameraName ?? null,
          ev.type,
          ev.subType !== undefined ? Number(ev.subType) : null,
          Math.floor(ev.time),
          ev.category ?? null,
          ev.message,
          ev.personId ?? null,
          ev.personName ?? null,
          finalSnapshotUrl,
          finalExpiresAt,
          finalVignetteUrl,
          ev.videoId ?? null,
          ev.videoStatus ?? null,
          ev.subEvents && ev.subEvents.length > 0
            ? JSON.stringify(ev.subEvents)
            : null,
          now
        );
        upsertedEvents++;
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return upsertedEvents;
  }

  public updateSecurityEventImage(
    eventId: string,
    snapshotUrl: string,
    vignetteUrl?: string,
    snapshotExpiresAt?: number,
    refreshedEvent?: SecurityEvent
  ): void {
    const now = Math.floor(Date.now() / 1000);
    if (refreshedEvent) {
      this.upsertSecurityData({
        homes: [],
        events: [
          {
            ...refreshedEvent,
            snapshotUrl,
            vignetteUrl: vignetteUrl ?? refreshedEvent.vignetteUrl ?? snapshotUrl,
            snapshotExpiresAt:
              snapshotExpiresAt ?? refreshedEvent.snapshotExpiresAt,
          },
        ],
      });
      return;
    }

    this.db
      .prepare(
        `UPDATE security_events
         SET snapshot_url = ?,
             vignette_url = COALESCE(?, vignette_url),
             snapshot_expires_at = COALESCE(?, snapshot_expires_at),
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        snapshotUrl,
        vignetteUrl ?? null,
        snapshotExpiresAt !== undefined ? Number(snapshotExpiresAt) : null,
        now,
        eventId
      );
  }

  public getSecurityData(homeId?: string): SecurityDataPayload {
    const homeRows = (
      homeId
        ? this.db
            .prepare(
              'SELECT id, name, timezone, updated_at FROM security_homes WHERE id = ?'
            )
            .all(homeId)
        : this.db
            .prepare('SELECT id, name, timezone, updated_at FROM security_homes')
            .all()
    ) as Array<{
      id: string;
      name: string;
      timezone: string | null;
      updated_at: number;
    }>;

    const camRows = (
      homeId
        ? this.db
            .prepare('SELECT * FROM security_cameras WHERE home_id = ?')
            .all(homeId)
        : this.db.prepare('SELECT * FROM security_cameras').all()
    ) as Array<any>;

    const personRows = (
      homeId
        ? this.db
            .prepare('SELECT * FROM security_persons WHERE home_id = ?')
            .all(homeId)
        : this.db.prepare('SELECT * FROM security_persons').all()
    ) as Array<any>;

    const eventRows = (
      homeId
        ? this.db
            .prepare(
              'SELECT * FROM security_events WHERE home_id = ? ORDER BY time DESC'
            )
            .all(homeId)
        : this.db
            .prepare('SELECT * FROM security_events ORDER BY time DESC')
            .all()
    ) as Array<any>;

    let maxUpdatedAt = 0;

    const camerasByHome = new Map<string, SecurityCamera[]>();
    for (const r of camRows) {
      maxUpdatedAt = Math.max(maxUpdatedAt, Number(r.updated_at || 0));
      const list = camerasByHome.get(String(r.home_id)) || [];
      const parsedSd =
        r.sd_status !== null && !Number.isNaN(Number(r.sd_status))
          ? Number(r.sd_status)
          : r.sd_status ?? undefined;
      const parsedAlim =
        r.alim_status !== null && !Number.isNaN(Number(r.alim_status))
          ? Number(r.alim_status)
          : r.alim_status ?? undefined;
      const parsedFw =
        r.firmware_revision !== null &&
        !Number.isNaN(Number(r.firmware_revision))
          ? Number(r.firmware_revision)
          : r.firmware_revision ?? undefined;

      list.push({
        id: String(r.id),
        homeId: String(r.home_id),
        homeName: String(r.home_name),
        name: String(r.name),
        type: String(r.type),
        roomName: r.room_name ?? undefined,
        monitoring: r.monitoring ?? undefined,
        status: r.status ?? undefined,
        sdStatus: parsedSd,
        alimStatus: parsedAlim,
        wifiStrength:
          r.wifi_strength !== null ? Number(r.wifi_strength) : undefined,
        wifiState: r.wifi_state ?? undefined,
        firmwareRevision: parsedFw,
        isLocal: r.is_local !== null ? Boolean(r.is_local) : undefined,
        floodlight: r.floodlight ?? undefined,
        sirenStatus: r.siren_status ?? undefined,
        lastSetup: r.last_setup !== null ? Number(r.last_setup) : undefined,
        vpnUrl: r.vpn_url ?? undefined,
        localUrl: r.local_url ?? undefined,
      });
      camerasByHome.set(String(r.home_id), list);
    }

    const personsByHome = new Map<string, SecurityPerson[]>();
    for (const r of personRows) {
      maxUpdatedAt = Math.max(maxUpdatedAt, Number(r.updated_at || 0));
      const list = personsByHome.get(String(r.home_id)) || [];
      list.push({
        id: String(r.id),
        homeId: String(r.home_id),
        pseudo: r.pseudo ?? undefined,
        outOfSight: r.out_of_sight !== null ? Boolean(r.out_of_sight) : undefined,
        lastSeen: r.last_seen !== null ? Number(r.last_seen) : undefined,
        faceUrl: r.face_url ?? undefined,
      });
      personsByHome.set(String(r.home_id), list);
    }

    const homes: SecurityHome[] = homeRows.map((h) => {
      maxUpdatedAt = Math.max(maxUpdatedAt, Number(h.updated_at || 0));
      return {
        id: String(h.id),
        name: String(h.name),
        timezone: h.timezone ?? undefined,
        cameras: camerasByHome.get(String(h.id)) || [],
        persons: personsByHome.get(String(h.id)) || [],
      };
    });

    const events: SecurityEvent[] = eventRows.map((r) => {
      maxUpdatedAt = Math.max(maxUpdatedAt, Number(r.updated_at || 0));
      let subEvents: SecuritySubEvent[] | undefined;
      if (r.sub_events_json) {
        try {
          subEvents = JSON.parse(r.sub_events_json);
        } catch {}
      }
      return {
        id: String(r.id),
        homeId: String(r.home_id),
        homeName: String(r.home_name),
        cameraId: r.camera_id ?? undefined,
        cameraName: r.camera_name ?? undefined,
        type: String(r.type),
        subType: r.sub_type !== null ? Number(r.sub_type) : undefined,
        time: Number(r.time),
        category: r.category ?? undefined,
        message: String(r.message),
        personId: r.person_id ?? undefined,
        personName: r.person_name ?? undefined,
        snapshotUrl: r.snapshot_url ?? undefined,
        snapshotExpiresAt:
          r.snapshot_expires_at !== null
            ? Number(r.snapshot_expires_at)
            : undefined,
        vignetteUrl: r.vignette_url ?? undefined,
        videoId: r.video_id ?? undefined,
        videoStatus: r.video_status ?? undefined,
        subEvents,
      };
    });

    return {
      homes,
      events,
      fetchedAt: maxUpdatedAt > 0 ? maxUpdatedAt * 1000 : 0,
    };
  }

  public markHomePersonsAway(homeId: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'UPDATE security_persons SET out_of_sight = 1, updated_at = ? WHERE home_id = ?'
      )
      .run(now, homeId);
  }

  public clearSecurityData(): StorageStats {
    this.db.exec(`
      DELETE FROM security_events;
      DELETE FROM security_cameras;
      DELETE FROM security_persons;
      DELETE FROM security_homes;
      PRAGMA wal_checkpoint(TRUNCATE);
      VACUUM;
    `);
    return this.getStorageStats();
  }

  public clearAllHistory(): StorageStats {
    this.db.exec(`
      DELETE FROM measurements;
      DELETE FROM sync_log;
      PRAGMA wal_checkpoint(TRUNCATE);
      VACUUM;
    `);
    return this.getStorageStats();
  }

  public clearDemoHistory(): void {
    this.db.exec(`
      DELETE FROM measurements WHERE station_id LIKE '70:ee:50:de:m0:%';
      DELETE FROM sync_log WHERE module_id LIKE '70:ee:50:de:m0:%' OR module_id LIKE '02:00:00:de:m0:%' OR module_id LIKE '03:00:00:de:m0:%' OR module_id LIKE '05:00:00:de:m0:%' OR module_id LIKE '06:00:00:de:m0:%';
      DELETE FROM security_events WHERE home_id LIKE 'demo-%' OR id LIKE 'demo-%';
      DELETE FROM security_cameras WHERE home_id LIKE 'demo-%';
      DELETE FROM security_persons WHERE home_id LIKE 'demo-%';
      DELETE FROM security_homes WHERE id LIKE 'demo-%';
    `);
  }

  public optimizeDatabase(): StorageStats {
    this.db.exec(`
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA optimize;
      VACUUM;
    `);
    return this.getStorageStats();
  }
}
