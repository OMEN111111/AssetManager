import { openDb } from '../core/db.ts';
const db = openDb(process.argv[2] || 'data/library.db');
console.log(db.prepare('SELECT type, COUNT(*) c FROM assets GROUP BY type ORDER BY c DESC').all());
console.log('\nsample texture/scene:');
console.log(db.prepare("SELECT rel_dir,name,type,preview_rel FROM assets WHERE type IN ('texture','scene') LIMIT 15").all());
console.log('\nby top folder:');
console.log(db.prepare("SELECT substr(rel_dir,1,instr(rel_dir||'/', '/')-1) cat, COUNT(*) c FROM assets GROUP BY cat").all());
console.log('\nfiles by role:');
console.log(db.prepare('SELECT role, COUNT(*) c FROM files GROUP BY role').all());
