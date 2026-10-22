import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS libraries(
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_scan_at INTEGER,
  scan_ms INTEGER,
  asset_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assets(
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  rel_dir TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  ext TEXT NOT NULL,
  category TEXT,
  size INTEGER DEFAULT 0,
  rating INTEGER DEFAULT 0,
  favorite INTEGER DEFAULT 0,
  preview_rel TEXT,
  status TEXT DEFAULT 'ok',
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_assets_lib ON assets(library_id);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(library_id, type);
CREATE INDEX IF NOT EXISTS idx_assets_dir ON assets(library_id, rel_dir);

CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  role TEXT NOT NULL,
  slot TEXT,
  size INTEGER DEFAULT 0,
  mtime INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_asset ON files(asset_id);

CREATE TABLE IF NOT EXISTS material_overrides(
  asset_key TEXT NOT NULL,
  material TEXT NOT NULL,
  channel TEXT NOT NULL,
  file_rel TEXT NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY(asset_key, material, channel)
);

CREATE TABLE IF NOT EXISTS tags(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER,
  name TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS asset_tags(
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(asset_id, tag_id)
);

CREATE TABLE IF NOT EXISTS issue_ignores(
  asset_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(asset_id, kind)
);

-- DCC 桥接（3ds Max / SketchUp / ...）：任务队列 + 客户端心跳
CREATE TABLE IF NOT EXISTS bridge_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  asset_id INTEGER,
  mode TEXT NOT NULL,
  title TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bridge_jobs ON bridge_jobs(target, status, id);

CREATE TABLE IF NOT EXISTS bridge_clients(
  target TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  version TEXT,
  host TEXT,
  info TEXT
);
`;

export function openDb(file: string): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // migrations
  const cols = db.prepare("PRAGMA table_info(assets)").all() as any[];
  if (!cols.some(c => c.name === 'material_json')) {
    db.exec('ALTER TABLE assets ADD COLUMN material_json TEXT');
  }
  if (!cols.some(c => c.name === 'thumb_file')) {
    db.exec('ALTER TABLE assets ADD COLUMN thumb_file TEXT');
  }
  try {
    const mc = db.prepare('PRAGMA table_info(material_overrides)').all() as any[];
    if (mc.length && !mc.some(c => c.name === 'swizzle')) {
      db.exec('ALTER TABLE material_overrides ADD COLUMN swizzle TEXT');
    }
  } catch { /* ignore */ }
  try { db.exec("UPDATE assets SET type='model' WHERE type='scene'"); } catch { /* ignore */ }
  try { db.exec("UPDATE material_overrides SET swizzle='rgb' WHERE swizzle IS NULL"); } catch { /* ignore */ }
  return db;
}

export function upsertLibrary(db: DB, root: string): number {
  const abs = path.resolve(root);
  const existing = db.prepare('SELECT id FROM libraries WHERE root = ?').get(abs) as { id: number } | undefined;
  if (existing) return existing.id;
  const name = path.basename(abs);
  const info = db.prepare('INSERT INTO libraries(root,name,created_at) VALUES(?,?,?)')
    .run(abs, name, Date.now());
  return Number(info.lastInsertRowid);
}

export function listLibraries(db: DB) {
  return db.prepare('SELECT * FROM libraries ORDER BY id').all();
}
