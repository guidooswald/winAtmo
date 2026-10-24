import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import {
  MeasurePoint,
  MetricType,
  NetatmoScale,
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
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {}

    let fileSizeBytes = 0;
    try {
      if (fs.existsSync(this.dbPath)) {
        fileSizeBytes += fs.statSync(this.dbPath).size;
      }
      if (fs.existsSync(this.dbPath + '-wal')) {
        fileSizeBytes += fs.statSync(this.dbPath + '-wal').size;
      }
    } catch {}

    const summaryStmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_points,
        COUNT(DISTINCT module_id) as module_count,
        MIN(ts) as oldest_ts,
        MAX(ts) as newest_ts
      FROM measurements
    `);
    const summary = summaryStmt.get() as {
      total_points: number;
      module_count: number;
      oldest_ts: number | null;
      newest_ts: number | null;
    };

    const byScaleStmt = this.db.prepare(`
      SELECT
        scale,
        COUNT(*) as cnt,
        MIN(ts) as oldest,
        MAX(ts) as newest
      FROM measurements
      GROUP BY scale
      ORDER BY cnt DESC
    `);
    const byScaleRows = byScaleStmt.all() as Array<{
      scale: string;
      cnt: number;
      oldest: number;
      newest: number;
    }>;

    return {
      dbPath: this.dbPath,
      fileSizeBytes,
      totalPoints: Number(summary?.total_points || 0),
      moduleCount: Number(summary?.module_count || 0),
      oldestTimestamp: summary?.oldest_ts ? Number(summary.oldest_ts) : null,
      newestTimestamp: summary?.newest_ts ? Number(summary.newest_ts) : null,
      byScale: byScaleRows.map((r) => ({
        scale: r.scale,
        count: Number(r.cnt),
        oldest: Number(r.oldest),
        newest: Number(r.newest),
      })),
    };
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
