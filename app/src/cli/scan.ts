import path from 'node:path';
import { openDb, upsertLibrary } from '../core/db.ts';
import { scanLibrary } from '../core/scan.ts';

const root = process.argv[2] || 'F:\\02AssetLibrary\\Asset';
const dbFile = process.argv[3] || path.join(process.cwd(), 'data', 'library.db');

const db = openDb(dbFile);
const id = upsertLibrary(db, root);
console.log(`library #${id} -> ${path.resolve(root)}`);

const t0 = Date.now();
const r = scanLibrary(db, id, path.resolve(root));
console.log(`scanned ${r.assets} assets / ${r.files} files in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

const byType = db.prepare('SELECT type, COUNT(*) c FROM assets WHERE library_id=? GROUP BY type ORDER BY c DESC').all(id);
console.table(byType);
const withPreview = db.prepare("SELECT COUNT(*) c FROM assets WHERE library_id=? AND preview_rel IS NOT NULL").get(id) as any;
console.log('with preview:', withPreview.c);
