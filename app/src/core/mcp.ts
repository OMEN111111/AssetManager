import type { DB } from './db.ts';
import { bridgeStatus, sendJob } from './bridge.ts';
import { scanLibrary } from './scan.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
}

const obj = (props: any, required: string[] = []) => ({ type: 'object', properties: props, required });

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'search_assets',
    description: '按关键词 / 类型筛选素材，返回 id、名称、类型、路径、评分等',
    inputSchema: obj({
      lib: { type: 'integer', description: '素材库 id，默认 1' },
      q: { type: 'string', description: '搜索关键词（名称或目录）' },
      type: { type: 'string', enum: ['all', 'material', 'model', 'texture', 'hdri', 'ies', 'drawing', 'scene'] },
      limit: { type: 'integer', default: 20 },
      offset: { type: 'integer', default: 0 }
    })
  },
  {
    name: 'get_asset',
    description: '读取单个素材详情（文件列表、路径、材质配置、标签）',
    inputSchema: obj({ assetId: { type: 'integer' } }, ['assetId'])
  },
  {
    name: 'list_tags',
    description: '列出所有标签（两级）',
    inputSchema: obj({})
  },
  {
    name: 'assign_tags',
    description: '给素材打标签（写操作）',
    inputSchema: obj({ tagId: { type: 'integer' }, assetIds: { type: 'array', items: { type: 'integer' } } }, ['tagId', 'assetIds'])
  },
  {
    name: 'update_asset',
    description: '修改素材评分 / 收藏（写操作）',
    inputSchema: obj({ assetId: { type: 'integer' }, rating: { type: 'integer' }, favorite: { type: 'integer' } }, ['assetId'])
  },
  {
    name: 'send_to_dcc',
    description: '把素材发送到 DCC（写操作）：max / blender / su，模式 import / material / texture / hdri',
    inputSchema: obj({
      assetId: { type: 'integer' },
      target: { type: 'string', enum: ['max', 'blender', 'su'] },
      mode: { type: 'string', enum: ['import', 'material', 'texture', 'hdri'], default: 'import' }
    }, ['assetId', 'target'])
  },
  {
    name: 'rescan_library',
    description: '重新扫描素材库（写操作）',
    inputSchema: obj({ lib: { type: 'integer' } }, ['lib'])
  },
  {
    name: 'bridge_status',
    description: '查看各 DCC 连接状态与队列',
    inputSchema: obj({})
  }
];

function assetRow(db: DB, id: number) {
  return db.prepare(`SELECT a.*, l.root FROM assets a JOIN libraries l ON l.id=a.library_id WHERE a.id=?`).get(id) as any;
}

export function callTool(db: DB, name: string, args: any, allowWrite: boolean) {
  const deny = () => ({ error: '当前 MCP 为只读模式：请在 AssetManager 设置里开启「允许 AI 修改」' });
  switch (name) {
    case 'search_assets': {
      const lib = Number(args?.lib || 1);
      const where = ['library_id = ?'];
      const params: any[] = [lib];
      if (args?.q) { where.push('(name LIKE ? OR rel_dir LIKE ?)'); params.push(`%${args.q}%`, `%${args.q}%`); }
      if (args?.type && args.type !== 'all') { where.push('type = ?'); params.push(args.type); }
      const limit = Math.min(Number(args?.limit || 20), 200);
      const offset = Math.max(0, Number(args?.offset || 0));
      const rows = db.prepare(`SELECT id,name,type,ext,rel_dir,size,rating,favorite,preview_rel FROM assets
        WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
      const total = (db.prepare(`SELECT COUNT(*) c FROM assets WHERE ${where.join(' AND ')}`).get(...params) as any).c;
      return { total, assets: rows };
    }
    case 'get_asset': {
      const a = assetRow(db, Number(args?.assetId));
      if (!a) return { error: '素材不存在' };
      const files = db.prepare('SELECT id,rel_path,role,slot,size FROM files WHERE asset_id=?').all(a.id);
      const tags = db.prepare(`SELECT t.id,t.name,t.parent_id FROM asset_tags at JOIN tags t ON t.id=at.tag_id WHERE at.asset_id=?`).all(a.id);
      let material: any = null;
      try { material = a.material_json ? JSON.parse(a.material_json) : null; } catch { /* ignore */ }
      return { asset: { ...a, root: undefined, path: `${a.root}\\${String(a.rel_dir).split('/').join('\\')}` }, files, tags, material };
    }
    case 'list_tags': {
      return { tags: db.prepare('SELECT id,parent_id,name,color FROM tags ORDER BY parent_id, name').all() };
    }
    case 'assign_tags': {
      if (!allowWrite) return deny();
      const tagId = Number(args?.tagId);
      const ids: number[] = Array.isArray(args?.assetIds) ? args.assetIds.map(Number) : [];
      if (!tagId || !ids.length) return { error: 'tagId / assetIds 必填' };
      const st = db.prepare('INSERT OR IGNORE INTO asset_tags(asset_id,tag_id) VALUES(?,?)');
      for (const id of ids) st.run(id, tagId);
      return { ok: true, assigned: ids.length };
    }
    case 'update_asset': {
      if (!allowWrite) return deny();
      const id = Number(args?.assetId);
      if (!id) return { error: 'assetId 必填' };
      if (args.rating !== undefined) db.prepare('UPDATE assets SET rating=? WHERE id=?').run(Math.max(0, Math.min(5, Number(args.rating))), id);
      if (args.favorite !== undefined) db.prepare('UPDATE assets SET favorite=? WHERE id=?').run(Number(args.favorite) ? 1 : 0, id);
      return { ok: true };
    }
    case 'send_to_dcc': {
      if (!allowWrite) return deny();
      const id = Number(args?.assetId);
      const target = String(args?.target || '');
      const mode = String(args?.mode || 'import');
      if (!['max', 'blender', 'su'].includes(target)) return { error: 'target 不支持' };
      if (!['import', 'material', 'texture', 'hdri'].includes(mode)) return { error: 'mode 不支持' };
      const r = sendJob(db, id, target, mode);
      return r;
    }
    case 'rescan_library': {
      if (!allowWrite) return deny();
      const lib = Number(args?.lib);
      const row = db.prepare('SELECT root FROM libraries WHERE id=?').get(lib) as any;
      if (!row) return { error: '库不存在' };
      scanLibrary(db, lib, row.root);
      return { ok: true, lib };
    }
    case 'bridge_status':
      return bridgeStatus(db);
    default:
      return { error: `未知工具：${name}` };
  }
}
