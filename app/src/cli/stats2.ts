import { openDb } from '../core/db.ts';
const db = openDb(process.argv[2] || 'data/library.db');
console.log(db.prepare("SELECT rel_dir,name,type FROM assets WHERE rel_dir LIKE '01_Texture%' LIMIT 20").all());
console.log('count 01_Texture:', db.prepare("SELECT COUNT(*) c FROM assets WHERE rel_dir LIKE '01_Texture%'").get());
console.log('count 06_Scene:', db.prepare("SELECT COUNT(*) c FROM assets WHERE rel_dir LIKE '06_Scene%'").get());
console.log('distinct dirs 01:', db.prepare("SELECT COUNT(DISTINCT rel_dir) c FROM assets WHERE rel_dir LIKE '01_Texture%'").get());
