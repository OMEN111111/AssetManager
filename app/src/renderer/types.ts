export interface Library {
  id: number;
  root: string;
  name: string;
  asset_count: number;
  last_scan_at: number | null;
}

export interface Asset {
  id: number;
  library_id: number;
  rel_dir: string;
  name: string;
  type: string;
  ext: string;
  category: string | null;
  size: number;
  rating: number;
  favorite: number;
  preview_rel: string | null;
  material_json?: string | null;
  /** 拖出到外部软件时用的代表文件（服务端算好） */
  drag_rel?: string | null;
}

export interface AssetFile {
  id: number;
  rel_path: string;
  role: string;
  slot: string | null;
  size: number;
}

export interface TagNode {
  id: number;
  parentId: number | null;
  name: string;
  color: string | null;
  depth: number;
  count: number;
}

export interface AssetDetail extends Asset {
  files: AssetFile[];
  root: string;
  /** 插件回写时写的槽位表：baseColor/normal/... → rel_path */
  slotMap?: Record<string, string> | null;
  material_json?: string | null;
  tags?: TagNode[];
}

export interface TreeNode {
  dir: string;
  label: string;
  depth: number;
  count: number;
  kind?: 'asset' | 'files';
}

export interface ScanState {
  running: boolean;
  libraryId: number | null;
  scanned: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}
