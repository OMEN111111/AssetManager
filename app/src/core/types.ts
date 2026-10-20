export type AssetType =
  | 'material' | 'model' | 'texture' | 'drawing' | 'hdri' | 'ies' | 'scene' | 'decal' | 'other';

export interface Library {
  id: number;
  root: string;
  name: string;
  last_scan_at: number | null;
  asset_count: number;
}

export interface Asset {
  id: number;
  library_id: number;
  rel_dir: string;
  name: string;
  type: AssetType;
  ext: string;
  category: string | null;
  size: number;
  rating: number;
  favorite: number;
  preview_rel: string | null;
  updated_at: number | null;
}

export interface AssetFile {
  id: number;
  rel_path: string;
  role: string;
  slot: string | null;
  size: number;
}

export interface AssetDetail extends Asset {
  files: AssetFile[];
}

export interface TreeNode {
  dir: string;
  label: string;
  depth: number;
  count: number;
}

export interface ScanState {
  running: boolean;
  libraryId: number | null;
  scanned: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}
