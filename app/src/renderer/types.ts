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
