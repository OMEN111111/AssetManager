import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, AssetDetail, Library, ScanState, TagNode, TreeNode } from './types';
import Viewer from './Viewer';
import Assembler from './Assembler';
import { renderThumb } from './thumbnailer';
import SmartImage, { isSpecialImage } from './SmartImage';
import { history } from './history';

const TYPES = [
  { key: 'all', label: '全部' },
  { key: 'material', label: '材质' },
  { key: 'model', label: '模型' },
  { key: 'texture', label: '贴图' },
  { key: 'drawing', label: '图纸' },
  { key: 'hdri', label: 'HDRI' },
  { key: 'ies', label: 'IES' },
  { key: 'scene', label: '场景' }
];

const THEMES = ['dark', 'light', 'transparent', 'glass', 'image'];

const PLACEHOLDER: Record<string, string> = {
  material: 'linear-gradient(145deg,#8a5c33,#3f2713)',
  model: 'linear-gradient(145deg,#e9e6df,#cfc9bd)',
  texture: 'linear-gradient(145deg,#5f7d8c,#2f4753)',
  drawing: 'linear-gradient(145deg,#f7f4ec,#ddd8cc)',
  hdri: 'linear-gradient(160deg,#9fb6cf,#e8d9c0)',
  ies: 'radial-gradient(circle at 50% 30%,#ffe9a8,#8a6b1f 45%,#2a2418)',
  scene: 'linear-gradient(145deg,#8c8578,#4a463d)',
  other: 'linear-gradient(145deg,#6b7280,#33383f)'
};

const api = (p: string, init?: RequestInit) => fetch(p, init).then(r => r.json());
const fmtSize = (b: number) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B';

function Stars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <div className="stars">
      {[1, 2, 3, 4, 5].map(i => (
        <button key={i} className={'star' + (i <= value ? ' on' : '')}
          onClick={(e) => { e.stopPropagation(); onChange?.(i === value ? 0 : i); }}
          title={`${i} 星`}>★</button>
      ))}
    </div>
  );
}

const isImgPath = (p: string) => /\.(png|jpe?g|webp|gif|bmp|tiff?|tga)$/i.test(p);

function FileCard({ f, onOpen, onCtx, onZoom }: { f: any; onOpen: () => void; onCtx?: (e: any) => void; onZoom?: () => void }) {
  const name = String(f.rel_path).split('/').pop() || '';
  const ext = (name.split('.').pop() || '').toUpperCase();
  return (
    <article className="card filecard" onClick={onOpen} onContextMenu={onCtx} onDoubleClick={onZoom} title={f.rel_path}>
      <div className="thumb" style={{ background: '#1b1f26' }}>
        {isImgPath(f.rel_path)
          ? (isSpecialImage(f.rel_path)
            ? <SmartImage fileId={f.id} path={f.rel_path} />
            : <img src={`/api/file/${f.id}`} loading="lazy" alt="" onError={e => (e.currentTarget.style.display = 'none')} />)
          : <div className="fextbig">{ext}</div>}
        <span className="badge">{ext}</span>
        <div className="meta"><span className="name">{name}</span></div>
      </div>
    </article>
  );
}

function Card({ a, active, onSelect, onOpen, onCtx, onZoom, issue, chips, onPick }: { a: Asset; active: boolean; onSelect: (e: any) => void; onOpen: () => void; onCtx?: (e: any) => void; onZoom?: (src: string) => void; issue?: string; chips?: { id: number; label: string }[]; onPick?: (id: number) => void }) {
  const [broken, setBroken] = useState(false);
  const badge = (a.ext || '').replace('.', '').toUpperCase();
  return (
    <article className={'card' + (active ? ' on' : '')} onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onCtx}>
      <div className="thumb" style={{ background: PLACEHOLDER[a.type] || PLACEHOLDER.other }}>
        {(a as any).img_file_id && isSpecialImage(a.ext || '') ? (
          <SmartImage fileId={(a as any).img_file_id} path={a.ext || ''} />
        ) : ((a as any).has_image || a.preview_rel) && !broken ? (
          <img src={`/api/thumb/${a.id}`} loading="lazy" alt=""
            onDoubleClick={e => { e.stopPropagation(); onZoom?.(`/api/thumb/${a.id}`); }}
            onError={() => setBroken(true)} />
        ) : null}
        <span className="badge">{badge}</span>
        {chips && chips.length > 0 && (
          <div className="reschips">
            {chips.map(c => (
              <span key={c.id} className={'reschip' + (c.id === a.id ? ' on' : '')}
                onClick={e => { e.stopPropagation(); if (c.id !== a.id) onPick?.(c.id); }}>{c.label}</span>
            ))}
          </div>
        )}
        {a.favorite ? <span className="fav">●</span> : null}
        {issue ? <span className="issueflag" title={issue}>!</span> : null}
        <div className="meta"><span className="name">{a.name}</span></div>
      </div>
    </article>
  );
}

export default function App() {
  const [libs, setLibs] = useState<Library[]>([]);
  const [lib, setLib] = useState<number | null>(null);
  const [libOrder, setLibOrder] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem('am-lib-order') || '[]'); } catch { return []; }
  });
  const [libOpen, setLibOpen] = useState<Set<number>>(new Set());
  const treeInit = useRef(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [tags, setTags] = useState<TagNode[]>([]);
  const [tab, setTab] = useState<'dir' | 'tag'>('dir');
  const [activeTag, setActiveTag] = useState<number | null>(null);
  const [scan, setScan] = useState<ScanState | null>(null);

  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [dir, setDir] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [sort, setSort] = useState('name');

  const [sel, setSel] = useState<AssetDetail | null>(null);
  const [selIssues, setSelIssues] = useState<any[] | null>(null);
  const [rowsPerPage, setRowsPerPage] = useState(() => Number(localStorage.getItem('am-rows') ?? 6));
  const [page, setPage] = useState(1);
  const [cols, setCols] = useState(6);
  const gridRef = useRef<HTMLDivElement>(null);
  const [fileSel, setFileSel] = useState<any | null>(null);
  const [selIds, setSelIds] = useState<number[]>([]);
  const [viewer, setViewer] = useState<AssetDetail | null>(null);
  const [assembler, setAssembler] = useState<AssetDetail | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('am-theme') || 'dark');
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(0);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [ratingFilter, setRatingFilter] = useState(0);
  const [favFilter, setFavFilter] = useState(false);
  const [extFilter, setExtFilter] = useState('');
  const [exts, setExts] = useState<{ ext: string; type: string; c: number }[]>([]);
  const [excludedTypes, setExcludedTypes] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('am-ex-types') || '[]')); } catch { return new Set(); }
  });
  const [hiddenExts, setHiddenExts] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('am-ex-exts') || '[]')); } catch { return new Set(); }
  });
  const [extMenu, setExtMenu] = useState<{ type: string; x: number; y: number } | null>(null);
  const [showMapDirs, setShowMapDirs] = useState(() => localStorage.getItem('am-show-filedirs') === '1');
  const [tempShowDir, setTempShowDir] = useState('');
  const [ignoreNames, setIgnoreNames] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('am-ignore') || '["maps","texture","textures","tex"]'); } catch { return ['maps']; }
  });
  const [ignoreDraft, setIgnoreDraft] = useState('');
  const [viewMode, setViewMode] = useState<'assets' | 'files'>('assets');
  const [fileDir, setFileDir] = useState('');
  const [files, setFiles] = useState<any[]>([]);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [issueList, setIssueList] = useState<any[]>([]);
  const [issueAssets, setIssueAssets] = useState<Asset[]>([]);
  const [issueMap, setIssueMap] = useState<Map<number, string>>(new Map());
  const [ctx, setCtx] = useState<any | null>(null);
  const [tagMgrOpen, setTagMgrOpen] = useState(false);
  const lastIdx = useRef(0);
  const lastMeta = useRef('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tagSel, setTagSel] = useState<Set<number>>(new Set());
  const [tagMulti, setTagMulti] = useState<Set<number>>(new Set());
  const [bulkColor, setBulkColor] = useState('#8b93a1');
  const [mgrParent, setMgrParent] = useState<number | 'none' | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newPrimaryName, setNewPrimaryName] = useState('');
  const [newTagParent, setNewTagParent] = useState<number | ''>('');
  const [mgrMoveTo, setMgrMoveTo] = useState<number | ''>('');
  const [detailTagName, setDetailTagName] = useState('');
  const [detailTagParent, setDetailTagParent] = useState<number | ''>('');
  const [variantGroups, setVariantGroups] = useState<{ key: string; items: any[] }[]>([]);
  const [zoom, setZoom] = useState<{ src?: string; fileId?: number; path?: string; scale: number } | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [ask, setAsk] = useState<{ title: string; value: string; resolve: (v: string | null) => void } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [, forceHistory] = useState(0);
  const [checkOpen, setCheckOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [issues, setIssues] = useState<any[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [fixLog, setFixLog] = useState<string[]>([]);
  const [fixing, setFixing] = useState(false);
  const [orgOpen, setOrgOpen] = useState(false);
  const [orgRows, setOrgRows] = useState<any[]>([]);
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgLog, setOrgLog] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importLog, setImportLog] = useState<string[]>([]);
  const win = (window as any).winApi;
  const isElectron = !!win?.isElectron;
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const askText = (title: string, value = '') => new Promise<string | null>(resolve => setAsk({ title, value, resolve }));
  function submitAsk(v: string | null) {
    ask?.resolve(v);
    setAsk(null);
  }

  const timer = useRef<number | undefined>(undefined);

  async function boot() {
    const s = await api('/api/state');
    setLibs(s.libraries || []);
    setScan(s.scan);
    if (s.libraries?.length) {
      const cur = s.libraries.find((l: Library) => l.id === lib) || s.libraries[0];
      setLib(cur.id);
    } else {
      setLib(null);
      setAssets([]);
      setSel(null);
      setTotal(0);
    }
    setLoading(false);
  }

  async function loadMeta(id: number) {
    const [st, tr, tg, ex] = await Promise.all([
      api(`/api/stats?lib=${id}`), api(`/api/tree?lib=${id}&withFiles=1`), api(`/api/tags?lib=${id}`), api(`/api/exts?lib=${id}`)
    ]);
    setStats(st.stats || {});
    setTotal(st.total || 0);
    setTree(tr.nodes || []);
    if (!treeInit.current) {
      treeInit.current = true;
      const nodes: TreeNode[] = tr.nodes || [];
      const parents = new Set<string>();
      for (const n of nodes) {
        if (nodes.some(m => m.dir !== n.dir && m.dir.startsWith(n.dir + '/'))) parents.add(n.dir);
      }
      setCollapsed(parents);
    }
    setTags(tg.tags || []);
    setExts(ex.exts || []);
    loadMissing(id);
  }

  async function loadMissing(id = lib) {
    if (!id) return;
    const r = await api(`/api/assets?lib=${id}&missingThumb=1&limit=1`);
    setMissing(r.total || 0);
  }

  async function generateThumbs() {
    if (!lib || genBusy) return;
    setGenBusy(true);
    const r = await api(`/api/assets?lib=${lib}&missingThumb=1&limit=16&sort=name`);
    const list = r.assets || [];
    for (let i = 0; i < list.length; i++) {
      setGenMsg(`生成缩略图 ${i + 1}/${list.length}`);
      try {
        const d = await api(`/api/asset/${list[i].id}`);
        const url = await renderThumb(d);
        await fetch(`/api/thumb/${list[i].id}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dataUrl: url })
        });
      } catch { /* skip broken asset */ }
    }
    setGenMsg(null);
    setGenBusy(false);
    await loadAssets(lib);
    await loadMissing(lib);
  }

  async function loadAssets(id = lib) {
    if (!id) return;
    const pageSize = rowsPerPage > 0 ? rowsPerPage * cols : 0;
    const qs = new URLSearchParams({
      lib: String(id), q, dir, recursive: recursive ? '1' : '0', sort,
      limit: String(pageSize || 5000),
      offset: String(pageSize ? (page - 1) * pageSize : 0),
      ...(activeTag ? { tag: String(activeTag) } : {}),
      ...(tagMulti.size ? { tags: [...tagMulti].join(',') } : {}),
      ...(ratingFilter ? { minRating: String(ratingFilter) } : {}),
      ...(favFilter ? { fav: '1' } : {}),
      ...(extFilter ? { ext: extFilter } : {}),
      ...(excludedTypes.size ? { excludeType: [...excludedTypes].join(',') } : {}),
      ...(hiddenExts.size ? { excludeExt: [...hiddenExts].join(',') } : {})
    });
    const r = await api('/api/assets?' + qs.toString());
    setAssets(r.assets || []);
    setTotal(r.total ?? (r.assets || []).length);
    setLoading(false);
    if (!sel && r.assets?.length) select(r.assets[0]);
  }

  useEffect(() => { boot(); }, []);
  useEffect(() => { if (lib) loadMeta(lib); }, [lib]);
  useEffect(() => {
    if (!lib) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => loadAssets(lib), 160);
    return () => window.clearTimeout(timer.current);
  }, [lib, q, dir, recursive, sort, activeTag, tagMulti, ratingFilter, favFilter, extFilter, excludedTypes, hiddenExts, rowsPerPage, cols, page]);

  // 筛选条件变化时回到第一页
  useEffect(() => { setPage(1); }, [q, dir, recursive, sort, activeTag, ratingFilter, favFilter, extFilter, excludedTypes, hiddenExts]);

  // 按容器宽度算列数（卡片 180 + 间距 16）
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const calc = () => setCols(Math.max(1, Math.floor((el.clientWidth + 16) / 196)));
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode, issuesOnly, assets.length]);

  // 选中素材时加载它的问题列表（详情页 / 自动打开都能覆盖）
  useEffect(() => {
    if (!sel) { setSelIssues(null); return; }
    let alive = true;
    setSelIssues(null);
    api(`/api/asset-issues/${sel.id}`)
      .then(r => { if (alive) setSelIssues(r.issues || []); })
      .catch(() => { if (alive) setSelIssues([]); });
    return () => { alive = false; };
  }, [sel?.id]);

  useEffect(() => {
    if (!lib) return;
    let alive = true;
    api(`/api/issues?lib=${lib}`).then(r => {
      if (!alive) return;
      setIssueList(r.issues || []);
      setIssueMap(new Map((r.issues || []).map((i: any) => [i.assetId, i.detail || i.kind])));
    }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [lib]);

  const variantMap = useMemo(() => {
    const m = new Map<number, { key: string; items: any[] }>();
    for (const g of variantGroups) for (const it of g.items) m.set(it.id, g);
    return m;
  }, [variantGroups]);

  useEffect(() => {
    if (!lib) return;
    let alive = true;
    api(`/api/variants?lib=${lib}`).then(r => { if (alive) setVariantGroups(r.groups || []); }).catch(() => {});
    return () => { alive = false; };
  }, [lib]);

  async function openVariant(id: number) {
    const d = await api(`/api/asset/${id}`);
    setSel(d);
    setSelIds([id]);
    if (d.type === 'material') setAssembler(d);
    else if (['model', 'scene', 'hdri', 'ies'].includes(d.type)) setViewer(d);
  }

  function chipsFor(a: Asset): { id: number; label: string }[] {
    const g = variantMap.get(a.id);
    if (g) {
      return g.items.map(it => ({
        id: it.id,
        label: it.lod != null ? `LOD${it.lod}` : it.res ? `${it.res}K` : '·'
      }));
    }
    const m = a.name.match(/(\d+)k/i);
    return m ? [{ id: a.id, label: `${m[1]}K` }] : [];
  }

  const displayAssets = useMemo(() => {
    const seen = new Set<string>();
    return assets.filter(a => {
      const g = variantMap.get(a.id);
      if (!g) return true;
      if (seen.has(g.key)) return false;
      seen.add(g.key);
      return true;
    });
  }, [assets, variantMap]);

  useEffect(() => { localStorage.setItem('am-show-filedirs', showMapDirs ? '1' : '0'); }, [showMapDirs]);
  useEffect(() => { localStorage.setItem('am-ignore', JSON.stringify(ignoreNames)); }, [ignoreNames]);

  function toggleType(key: string) {
    setExcludedTypes(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key); else s.add(key);
      localStorage.setItem('am-ex-types', JSON.stringify([...s]));
      return s;
    });
  }

  function toggleExt(ext: string) {
    setHiddenExts(prev => {
      const s = new Set(prev);
      if (s.has(ext)) s.delete(ext); else s.add(ext);
      localStorage.setItem('am-ex-exts', JSON.stringify([...s]));
      return s;
    });
  }

  function clearTypeFilters() {
    setExcludedTypes(new Set());
    setHiddenExts(new Set());
    localStorage.setItem('am-ex-types', '[]');
    localStorage.setItem('am-ex-exts', '[]');
  }

  useEffect(() => {
    if (!lib) return;
    const t = setInterval(async () => {
      try {
        const s = await api('/api/state');
        setLibs(s.libraries || []);
        setScan(s.scan);
        const cur = (s.libraries || []).find((x: Library) => x.id === lib);
        if (cur) {
          const key = `${cur.asset_count}|${cur.last_scan_at}`;
          if (lastMeta.current && lastMeta.current !== key) {
            lastMeta.current = key;
            loadMeta(lib);
            loadAssets(lib);
          } else if (!lastMeta.current) {
            lastMeta.current = key;
          }
        }
      } catch { /* ignore */ }
    }, 8000);
    return () => clearInterval(t);
  }, [lib, q, dir, recursive, sort, activeTag, ratingFilter, favFilter, extFilter, excludedTypes, hiddenExts]);

  function moveLib(idx: number, delta: number) {
    const ids = orderedLibs.map(l => l.id);
    const j = idx + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    setLibOrder(ids);
  }

  async function removeLibrary(id: number) {
    if (!window.confirm('从软件中移除这个库？不会删除磁盘上的任何文件。')) return;
    await api(`/api/libraries/${id}`, { method: 'DELETE' });
    lastMeta.current = '';
    await boot();
  }

  async function rescanLibrary(l: Library) {
    await api('/api/libraries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: l.root })
    });
    setScan(s => s ? { ...s, running: true } : s);
  }


  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropActive(true);
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDropActive(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropActive(false);
      const files = Array.from(e.dataTransfer?.files || []);
      const am = (window as any).amApi;
      const paths = files.map(f => (am?.getPath ? am.getPath(f) : (f as any).path)).filter(Boolean);
      if (!paths.length) {
        setImportLog(['浏览器环境读不到本地路径，拖入导入需要在桌面版里用']);
        return;
      }
      if (!lib) { setImportLog(['请先在设置里添加一个素材库']); return; }
      setImporting(true);
      const r = await api('/api/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lib, paths })
      });
      setImporting(false);
      setImportLog((r.results || []).map((x: any) =>
        x.ok ? `✔ ${String(x.from).split(/[\\/]/).pop()} → ${x.to}` : `✘ ${String(x.from).split(/[\\/]/).pop()}：${x.error}`));
      loadAssets(lib);
      loadMeta(lib);
      window.setTimeout(() => setImportLog([]), 9000);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [lib]);

  useEffect(() => {
    if (viewMode !== 'files' || !lib) return;
    const qs = new URLSearchParams({ lib: String(lib), dir: fileDir || dir, q, limit: '300' });
    api('/api/files?' + qs.toString()).then(r => setFiles(r.files || []));
  }, [viewMode, lib, fileDir, dir, q]);

  useEffect(() => {
    const openId = new URLSearchParams(location.search).get('open');
    if (!openId) return;
    api(`/api/asset/${openId}`).then(d => {
      if (!d?.id) return;
      setSel(d);
      if (d.type === 'material') setAssembler(d);
      else if (['model', 'scene', 'hdri', 'ies'].includes(d.type)) setViewer(d);
    });
  }, []);

  useEffect(() => {
    if (!scan?.running) return;
    const t = setInterval(async () => {
      const s = await api('/api/scan');
      setScan(s);
      if (!s.running && lib) { loadMeta(lib); loadAssets(lib); }
    }, 1200);
    return () => clearInterval(t);
  }, [scan?.running, lib]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('am-theme', theme);
  }, [theme]);

  useEffect(() => history.subscribe(() => forceHistory(v => v + 1)), []);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) await history.redo(); else await history.undo();
        if (lib) loadAssets(lib);
        refreshDetail();
      } else if (k === 'y') {
        e.preventDefault();
        await history.redo();
        if (lib) loadAssets(lib);
        refreshDetail();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lib, sel]);

  const hiddenByCollapse = (dir: string) => {    if (!dir.includes('/')) return false;
    const segs = dir.split('/');
    let path = '';
    for (let i = 0; i < segs.length - 1; i++) {
      path = path ? `${path}/${segs[i]}` : segs[i];
      if (collapsed.has(path)) return true;
    }
    return false;
  };
  const hasChildren = (dir: string) => tree.some(n => n.dir.startsWith(dir + '/'));
  const toggleCollapse = (dir: string) => setCollapsed(prev => {
    const s = new Set(prev);
    if (s.has(dir)) s.delete(dir); else s.add(dir);
    return s;
  });
  useEffect(() => {
    if (tempShowDir && dir !== tempShowDir) setTempShowDir('');
  }, [dir]);

  const orderedLibs = useMemo(() => {
    const byId = new Map(libs.map(l => [l.id, l]));
    const ordered = libOrder.filter(id => byId.has(id));
    const rest = libs.filter(l => !ordered.includes(l.id)).map(l => l.id);
    return [...ordered, ...rest].map(id => byId.get(id)!).filter(Boolean);
  }, [libs, libOrder]);

  useEffect(() => { localStorage.setItem('am-lib-order', JSON.stringify(libOrder)); }, [libOrder]);

  const doUndo = async () => { await history.undo(); if (lib) loadAssets(lib); refreshDetail(); };
  const doRedo = async () => { await history.redo(); if (lib) loadAssets(lib); refreshDetail(); };

  async function runCheck() {
    if (!lib) return;
    setCheckOpen(true); setChecking(true); setFixLog([]); setIssues([]);
    const r = await api(`/api/check?lib=${lib}`);
    setIssues(r.issues || []);
    setSkipped(r.skipped || 0);
    setChecking(false);
  }

  async function fixOne(it: any) {
    setFixing(true);
    const r = await api('/api/fix', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: it.assetId, fix: it.fix, payload: it.payload })
    });
    setIssues(prev => prev.filter(x => x !== it));
    setFixLog(prev => [...prev, r.ok
      ? `✔ ${it.name}：${Array.isArray(r.detail) ? r.detail.slice(0, 3).join('，') : '已修复'}`
      : `✘ ${it.name}：${r.error}`]);
    setFixing(false);
    if (lib) { loadAssets(lib); loadMeta(lib); }
  }

  async function fixAll() {
    const list = issues.filter(i => i.fix);
    for (const it of list) await fixOne(it);
  }

  async function openOrganize() {
    if (!lib) return;
    setOrgOpen(true); setOrgRows([]); setOrgLog([]); setOrgBusy(true);
    const r = await api(`/api/organize/plan?lib=${lib}`);
    setOrgRows(r.rows || []);
    setOrgBusy(false);
  }

  async function applyOrganize() {
    if (!lib) return;
    setOrgBusy(true);
    const r = await api('/api/organize/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lib, rows: orgRows })
    });
    setOrgLog([
      ...(r.applied || []).map((x: any) => `✔ ${x.from}  →  ${x.to}`),
      ...(r.failed || []).map((x: any) => `✘ ${x.from}：${x.error}`)
    ]);
    setOrgRows([]);
    setOrgBusy(false);
    loadAssets(lib); loadMeta(lib);
  }

  async function undoOrganize() {
    if (!lib) return;
    setOrgBusy(true);
    const r = await api('/api/organize/undo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lib })
    });
    setOrgLog(r.ok
      ? (r.reverted || []).map((x: any) => `↩ ${x.to}  →  ${x.from}`)
      : [`✘ ${r.error}`]);
    setOrgBusy(false);
    loadAssets(lib); loadMeta(lib);
  }

  async function select(a: Asset) {
    const d = await api(`/api/asset/${a.id}`);
    setSel(d);
    setFileSel(null);
  }

  async function openViewer(a: Asset) {
    const d = await api(`/api/asset/${a.id}`);
    setSel(d);
    if (a.type === 'material') setAssembler(d);
    else if (['model', 'scene', 'hdri', 'ies'].includes(a.type)) setViewer(d);
  }

  function applyLocal(id: number, body: any) {
    setAssets(prev => prev.map(x => x.id === id ? { ...x, ...body } : x));
    setSel(prev => prev && prev.id === id ? { ...prev, ...body } : prev);
  }

  async function sendPatch(id: number, body: any) {
    await api(`/api/asset/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    applyLocal(id, body);
  }

  async function patch(a: Asset, body: Record<string, number>) {
    const before: any = {};
    for (const k of Object.keys(body)) before[k] = (a as any)[k];
    await sendPatch(a.id, body);
    const label = 'rating' in body ? '修改评分' : 'favorite' in body ? '切换收藏' : '修改素材';
    history.push({
      label,
      undo: () => sendPatch(a.id, before),
      redo: () => sendPatch(a.id, body)
    });
  }

  async function addLibrary() {
    const root = await askText('输入素材库根目录', 'F:\\02AssetLibrary\\Asset');
    if (!root) return;
    const r = await api('/api/libraries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root }) });
    if (r.id) { setLib(r.id); boot(); }
  }

  const lastTagRef = useRef<number | null>(null);
  function selectTag(id: number, e: any) {
    setActiveTag(null);
    const ids = tags.map(t => t.id);
    const anchor = lastTagRef.current;
    if (e.shiftKey && anchor != null && ids.includes(anchor)) {
      const a = ids.indexOf(anchor), b = ids.indexOf(id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      setTagMulti(prev => (e.ctrlKey || e.metaKey) ? new Set([...prev, ...range]) : new Set(range));
    } else if (e.ctrlKey || e.metaKey) {
      setTagMulti(prev => {
        const s = new Set(prev);
        if (s.has(id)) s.delete(id); else s.add(id);
        return s;
      });
    } else {
      setTagMulti(new Set([id]));
    }
    lastTagRef.current = id;
  }

  function toggleTagMulti(id: number) {
    setActiveTag(null);
    setTagMulti(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }

  async function refreshDetail() {
    if (!sel) return;
    const d = await api(`/api/asset/${sel.id}`);
    setSel(d);
  }

  function handleSelect(a: Asset, e: any) {
    const idx = assets.findIndex(x => x.id === a.id);
    if (e.shiftKey && selIds.length) {
      const from = lastIdx.current;
      const lo = Math.min(from, idx), hi = Math.max(from, idx);
      setSelIds(assets.slice(lo, hi + 1).map(x => x.id));
      select(a);
    } else if (e.ctrlKey || e.metaKey) {
      setSelIds(prev => prev.includes(a.id) ? prev.filter(x => x !== a.id) : [...prev, a.id]);
      select(a);
      lastIdx.current = idx;
    } else {
      setSelIds([a.id]);
      select(a);
      lastIdx.current = idx;
    }
  }

  async function batchPatch(body: any) {
    const ids = [...selIds];
    if (!ids.length) return;
    const olds = assets.filter(a => ids.includes(a.id)).map(a => {
      const o: any = { id: a.id };
      for (const k of Object.keys(body)) o[k] = (a as any)[k];
      return o;
    });
    const apply = async (list: any[]) => {
      for (const o of list) {
        const { id, ...b } = o;
        await api(`/api/asset/${id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b)
        });
      }
      setAssets(prev => prev.map(x => {
        const hit = list.find(o => o.id === x.id);
        if (!hit) return x;
        const { id, ...b } = hit;
        return { ...x, ...b };
      }));
      setSel(prev => {
        if (!prev) return prev;
        const hit = list.find(o => o.id === prev.id);
        if (!hit) return prev;
        const { id, ...b } = hit;
        return { ...prev, ...b };
      });
    };
    const next = ids.map(id => ({ id, ...body }));
    await apply(next);
    history.push({
      label: 'rating' in body ? '批量评分' : '批量收藏',
      undo: () => apply(olds),
      redo: () => apply(next)
    });
  }

  async function batchTag(tagId: number, action: 'add' | 'remove') {
    const ids = [...selIds];
    if (!ids.length) return;
    const apply = async (act: 'add' | 'remove') => {
      await api('/api/tags/assign', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetIds: ids, tagId, action: act })
      });
      if (lib) loadMeta(lib);
      refreshDetail();
    };
    await apply(action);
    history.push({
      label: action === 'add' ? '批量加标签' : '批量移标签',
      undo: () => apply(action === 'add' ? 'remove' : 'add'),
      redo: () => apply(action)
    });
  }

  async function reveal(a: Asset) {
    await api('/api/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: a.id })
    });
  }

  async function revealFile(f: any) {
    await api('/api/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: f.id })
    });
  }

  async function refreshIssues() {
    if (!lib) return;
    const r = await api(`/api/issues?lib=${lib}`);
    setIssueList(r.issues || []);
    setIssueAssets(r.assets || []);
    setIssueMap(new Map((r.issues || []).map((i: any) => [i.assetId, i.detail || i.kind])));
  }

  async function toggleIssues() {
    if (issuesOnly) { setIssuesOnly(false); return; }
    if (!lib) return;
    await refreshIssues();
    setIssuesOnly(true);
  }

  async function ignoreIssues(assetIds: number[], kind?: string) {
    if (!assetIds.length) return;
    await api('/api/issues/ignore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetIds, kinds: kind ? [kind] : [] })
    });
    if (sel && assetIds.includes(sel.id)) {
      const r = await api(`/api/asset-issues/${sel.id}`);
      setSelIssues(r.issues || []);
    }
    if (issuesOnly) await refreshIssues();
  }

  async function openFile(f: any) {
    const d = await api(`/api/asset/${f.aid}`);
    setSel(d);
    setSelIds([f.aid]);
    setFileSel({ id: f.id, rel_path: f.rel_path, size: f.size, role: f.role });
  }

  function addIgnore() {
    const parts = ignoreDraft.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setIgnoreNames(prev => [...new Set([...prev, ...parts])]);
    setIgnoreDraft('');
    setShowMapDirs(false);
  }

  async function copyText(t: string) {
    try { await navigator.clipboard.writeText(t); } catch { /* ignore */ }
  }

  function assetFullPath(a: Asset) {
    const root = libs.find(l => l.id === a.library_id)?.root || '';
    return `${root}\\${a.rel_dir.split('/').join('\\')}`;
  }

  function expandTreeTo(dirPath: string, libId: number) {
    setLib(libId);
    setTab('dir');
    setLibOpen(prev => new Set([...prev, libId]));
    setCollapsed(prev => {
      const s = new Set(prev);
      const segs = dirPath.split('/').filter(Boolean);
      let p = '';
      for (const seg of segs) { p = p ? `${p}/${seg}` : seg; s.delete(p); }
      return s;
    });
    const name = dirPath.split('/').pop() || '';
    setTempShowDir(ignoreNames.includes(name) ? dirPath : '');
    setDir(dirPath);
    setFileSel(null);
    setViewMode('assets');
    setTimeout(() => document.querySelector('.tree .row.on')?.scrollIntoView({ block: 'center' }), 350);
  }

  function locateAsset(a: Asset) { expandTreeTo(a.rel_dir, a.library_id); }
  function locateFile(f: any) {
    const dirPath = String(f.rel_path).split('/').slice(0, -1).join('/');
    if (lib) expandTreeTo(dirPath, lib);
  }

  async function revealDir(dirPath: string) {
    if (!lib) return;
    await api('/api/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lib, dirPath })
    });
  }

  async function assign(tagId: number, action: 'add' | 'remove') {
    if (!sel) return;
    const tagIdFixed = tagId;
    const applyAction = async (act: 'add' | 'remove') => {
      await api('/api/tags/assign', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetIds: [sel.id], tagId: tagIdFixed, action: act })
      });
      await refreshDetail();
      if (lib) loadMeta(lib);
    };
    await applyAction(action);
    const inverse = action === 'add' ? 'remove' : 'add';
    history.push({
      label: action === 'add' ? '添加标签' : '移除标签',
      undo: () => applyAction(inverse as 'add' | 'remove'),
      redo: () => applyAction(action)
    });
  }

  async function updateTag(id: number, patch: any) {
    await api(`/api/tags/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (lib) loadMeta(lib);
  }

  async function deleteTag(id: number) {
    if (!window.confirm('删除该标签？只解除关联，不会删除任何素材。')) return;
    await api(`/api/tags/${id}`, { method: 'DELETE' });
    if (lib) loadMeta(lib);
    refreshDetail();
  }

  async function batchDeleteTags() {
    if (!tagSel.size) return;
    if (!window.confirm(`删除选中的 ${tagSel.size} 个标签？只解除关联，不会删除素材。`)) return;
    for (const id of tagSel) await api(`/api/tags/${id}`, { method: 'DELETE' });
    setTagSel(new Set());
    if (lib) loadMeta(lib);
    refreshDetail();
  }

  async function batchColorTags() {
    if (!tagSel.size) return;
    for (const id of tagSel) await updateTag(id, { color: bulkColor });
  }

  async function createTag() {
    const name = await askText('新标签名称');
    if (!name) return;
    const t = await api('/api/tags', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (t?.id && sel) await assign(t.id, 'add');
    if (lib) loadMeta(lib);
  }

  async function createPrimaryTag() {
    if (!newPrimaryName.trim()) return;
    await api('/api/tags', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newPrimaryName.trim(), parentId: null })
    });
    setNewPrimaryName('');
    if (lib) loadMeta(lib);
  }

  async function createSecondaryTag() {
    if (!newTagName.trim()) return;
    const pid = selParent === 'none' ? null : Number(selParent);
    await api('/api/tags', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newTagName.trim(), parentId: pid })
    });
    setNewTagName('');
    if (lib) loadMeta(lib);
  }

  async function batchMoveTags() {
    if (!tagSel.size) return;
    const pid = mgrMoveTo ? Number(mgrMoveTo) : null;
    for (const id of tagSel) await updateTag(id, { parentId: pid });
    setMgrMoveTo('');
  }

  async function createDetailTag() {
    if (!detailTagName.trim() || !sel) return;
    const t = await api('/api/tags', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: detailTagName.trim(), parentId: detailTagParent ? Number(detailTagParent) : null })
    });
    if (t?.id) await assign(t.id, 'add');
    setDetailTagName('');
    if (lib) loadMeta(lib);
  }

  const counts = useMemo(() => ({ all: total, ...stats }), [total, stats]);
  const primaries = useMemo(() => tags.filter(t => t.depth === 0), [tags]);
  const selParent = mgrParent ?? (primaries[0]?.id ?? 'none');
  const unclassified = useMemo(() => tags.filter(t => t.depth > 0 && !t.parentId), [tags]);
  const secondaries = useMemo(
    () => selParent === 'none' ? unclassified : tags.filter(t => t.parentId === selParent),
    [tags, selParent, unclassified]
  );

  useEffect(() => {
    if (!location.search.includes('debug')) return;
    const t = setTimeout(() => {
      const c = document.querySelector('.card') as HTMLElement | null;
      const g = document.querySelector('.grid') as HTMLElement | null;
      if (!c || !g) return;
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      const gs = getComputedStyle(g);
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;z-index:9999;left:8px;top:56px;background:#000;color:#0f0;font:13px monospace;padding:8px;max-width:1200px';
      el.textContent = `card ${Math.round(r.width)}x${Math.round(r.height)} ar=${cs.aspectRatio} alignSelf=${cs.alignSelf} | rows=${gs.gridTemplateRows.slice(0, 50)} | scrollH=${g.scrollHeight}`;
      document.body.appendChild(el);
    }, 1200);
    return () => clearTimeout(t);
  }, [assets.length]);

  return (
    <div className="app">
      {isElectron && (
        <div className="titlebar">
          <div className="tb-menu">
            {['文件', '视图', '帮助'].map(m => (
              <button key={m} className="tb-item" onClick={() => setMenuOpen(menuOpen === m ? null : m)}>{m}</button>
            ))}
          </div>
          <div className="tb-drag" />
          <div className="tb-win">
            <button title="最小化" onClick={() => win.minimize()}>–</button>
            <button title="最大化" onClick={() => win.maximize()}>□</button>
            <button className="close" title="关闭" onClick={() => win.close()}>×</button>
          </div>
          {menuOpen && (
            <>
              <div className="menu-mask" onMouseDown={() => setMenuOpen(null)} />
              <div className="tb-drop" style={{ left: menuOpen === '文件' ? 8 : menuOpen === '视图' ? 52 : 96 }}>
                {menuOpen === '文件' && (<>
                  <button onClick={() => { setMenuOpen(null); addLibrary(); }}>添加素材库…</button>
                  <button onClick={() => { setMenuOpen(null); setSettingsOpen(true); }}>设置 / 库管理</button>
                  <button onClick={() => { setMenuOpen(null); win.close(); }}>退出</button>
                </>)}
                {menuOpen === '视图' && (<>
                  <button onClick={() => { setMenuOpen(null); win.reload(); }}>重新加载</button>
                  <button onClick={() => { setMenuOpen(null); win.devtools(); }}>开发者工具</button>
                  <button onClick={() => { setMenuOpen(null); win.fullscreen(); }}>全屏</button>
                </>)}
                {menuOpen === '帮助' && (
                  <button onClick={() => { setMenuOpen(null); alert('AssetManager\n本地资产库管理器'); }}>关于</button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <header className="topbar">
        <div className="brand"><span className="mark" />AssetManager</div>
        <button className="libbtn">{libs.find(l => l.id === lib)?.name || '未添加库'}</button>
        <div className="searchbox">
          <svg className="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索素材、文件夹名…" />
          <kbd>Ctrl K</kbd>
        </div>
        <button className="btn pluginbtn" onClick={() => setPluginsOpen(true)} title="插件与桥接管理">插件</button>
        <div className="top-actions">
          <button className="iconbtn" disabled={!history.canUndo} title={`撤销${history.undoLabel ? '：' + history.undoLabel : ''}`} onClick={doUndo}>↶</button>
          <button className="iconbtn" disabled={!history.canRedo} title={`重做${history.redoLabel ? '：' + history.redoLabel : ''}`} onClick={doRedo}>↷</button>
          <button className="iconbtn" title="库体检 / 断链修复" onClick={runCheck}>⚑</button>
          <button className="iconbtn" title="整理：规范化目录" onClick={openOrganize}>⧉</button>
          <button className="iconbtn" title={`补缩略图${missing ? '（' + missing + '）' : ''}`}
            onClick={generateThumbs} disabled={genBusy}>{genBusy ? '…' : '◫'}</button>
          <button className="iconbtn" title="设置 / 库管理" onClick={() => setSettingsOpen(true)}>⚙</button>
          <button className="iconbtn" title="重新扫描" onClick={async () => {
            if (!lib) return;
            const root = libs.find(l => l.id === lib)?.root;
            await api('/api/libraries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root }) });
            setScan(s => s ? { ...s, running: true } : s);
          }}>⟳</button>
          <button className="iconbtn" onClick={addLibrary} title="添加库">＋</button>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="tabs">
            <button className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>目录</button>
            <button className={tab === 'tag' ? 'on' : ''} onClick={() => setTab('tag')}>标签</button>
          </div>
          {tab === 'dir' ? (
            <div className="tree">
              {orderedLibs.map(L => {
                const open = libOpen.has(L.id);
                return (
                  <div key={L.id} className="libblock">
                    <div className={'row librow' + (lib === L.id && dir === '' ? ' on' : '')}
                      onClick={() => {
                        setLib(L.id);
                        setDir('');
                        setViewMode('assets');
                        setFileDir('');
                        if (!open) setLibOpen(new Set([...libOpen, L.id]));
                      }}>
                      <span className="caret" onClick={e => {
                        e.stopPropagation();
                        const s = new Set(libOpen);
                        if (s.has(L.id)) s.delete(L.id); else s.add(L.id);
                        setLibOpen(s);
                        if (!s.has(L.id) && lib !== L.id) setLib(L.id);
                      }}>{open ? '▾' : '▸'}</span>
                      <span className="ic">▣</span>
                      <span className="label">{L.name}</span>
                      <span className="count">{(L as any).asset_count ?? ''}</span>
                    </div>
                    {open && lib === L.id && tree
                      .filter(n => !hiddenByCollapse(n.dir))
                      .filter(n => n.kind !== 'files' || showMapDirs || n.dir === tempShowDir || !ignoreNames.includes(n.label))
                      .map(n => (
                        <div key={n.dir}
                          className={'row' + ((viewMode === 'files' ? fileDir === n.dir : dir === n.dir) ? ' on' : '') + (n.kind === 'files' ? ' filedir' : '')}
                          style={{ paddingLeft: 8 + (n.depth + 1) * 14 }}
                          onClick={() => {
                            if (n.kind === 'files') { setViewMode('files'); setFileDir(n.dir); }
                            else { setViewMode('assets'); setFileDir(''); setDir(n.dir); }
                          }}
                          onContextMenu={e => { e.preventDefault(); setCtx({ kind: 'dir', x: e.clientX, y: e.clientY, node: n }); }}
                          title={n.kind === 'files' ? '贴图目录：点击查看其中的文件' : undefined}>
                          <span className="caret" onClick={e => {
                            e.stopPropagation();
                            if (hasChildren(n.dir)) toggleCollapse(n.dir);
                          }}>{hasChildren(n.dir) ? (collapsed.has(n.dir) ? '▸' : '▾') : ''}</span>
                          <span className="label">{n.label}</span>
                          <span className="count">{n.kind === 'files' ? '·' : n.count}</span>
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="tree" onClick={e => {
              if (e.target === e.currentTarget) { setTagMulti(new Set()); lastTagRef.current = null; }
            }}>
              <div className={'row' + (activeTag === null && tagMulti.size === 0 ? ' on' : '')}
                onClick={() => { setActiveTag(null); setTagMulti(new Set()); lastTagRef.current = null; }}>
                <span className="ic">▣</span>全部素材<span className="count">{counts.all}</span>
              </div>
              {tags.map(t => (
                <div key={t.id}
                  className={'row' + ((activeTag === t.id || tagMulti.has(t.id)) ? ' on' : '')}
                  style={{ paddingLeft: 8 + t.depth * 14 }} onClick={(e) => selectTag(t.id, e)}>
                  <span className="tdot" style={{ background: t.color || '#8b93a1' }} />
                  <span className="label">{t.name}</span>
                  <span className="count">{t.count}</span>
                </div>
              ))}
              {tags.length === 0 && <div className="thint">还没有标签，选中素材后添加</div>}
              <div className="row tnew" onClick={createTag}><span className="ic">＋</span>新建标签</div>
              <div className="row tnew" onClick={() => setTagMgrOpen(true)}><span className="ic">⚙</span>管理标签</div>
            </div>
          )}
          <div className="side-foot">
            <label className="check" onClick={() => setRecursive(v => !v)}>
              <span className={'box' + (recursive ? ' on' : '')}>{recursive ? '✓' : ''}</span>包含子文件夹
            </label>
            <label className="check" onClick={() => setShowMapDirs(v => !v)}>
              <span className={'box' + (showMapDirs ? ' on' : '')}>{showMapDirs ? '✓' : ''}</span>显示贴图目录
            </label>
          </div>
        </aside>

        <main className="content">
          <div className="filterbar">
            {TYPES.filter(t => t.key !== 'all').map(t => (
              <button key={t.key}
                className={'chip' + (excludedTypes.has(t.key) ? ' off' : '')}
                onClick={() => toggleType(t.key)}
                onContextMenu={e => { e.preventDefault(); setExtMenu({ type: t.key, x: e.clientX, y: e.clientY }); }}
                title="左键隐藏/显示该类型，右键选择要隐藏的格式">
                {t.label}<span className="n">{counts[t.key] ?? 0}</span>
              </button>
            ))}
            {(excludedTypes.size > 0 || hiddenExts.size > 0) && (
              <button className="chip" onClick={clearTypeFilters}>恢复全部</button>
            )}
            <div className="sep" />
            <button className={'chip' + (viewMode === 'assets' ? ' on' : '')} onClick={() => setViewMode('assets')}>素材</button>
            <button className={'chip' + (viewMode === 'files' ? ' on' : '')}
              onClick={() => { setViewMode('files'); if (!fileDir) setFileDir(dir); }}>文件</button>
            <button className={'chip' + (issuesOnly ? ' on' : '')} onClick={toggleIssues}>
              问题{issueList.length ? <span className="n">{issueList.length}</span> : null}
            </button>
            <div className="spacer" />
            <div className="sep" />
            <button className={'chip' + (ratingFilter === 4 ? ' on' : '')} onClick={() => setRatingFilter(r => r === 4 ? 0 : 4)}>≥ 4 星</button>
            <button className={'chip' + (favFilter ? ' on' : '')} onClick={() => setFavFilter(v => !v)}>仅收藏</button>
            <select className="sortsel" value={extFilter} onChange={e => setExtFilter(e.target.value)}>
              <option value="">全部格式</option>
              {exts.map(x => <option key={x.ext} value={x.ext}>{x.ext.replace('.', '').toUpperCase()}（{x.c}）</option>)}
            </select>
            {(ratingFilter || favFilter || extFilter || activeTag || tagMulti.size || dir) && (
              <button className="chip" onClick={() => {
                setRatingFilter(0); setFavFilter(false); setExtFilter(''); setActiveTag(null); setTagMulti(new Set()); setDir('');
              }}>清除筛选</button>
            )}
            <select className="sortsel" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="name">按名称</option>
              <option value="rating">按评分</option>
              <option value="size">按大小</option>
              <option value="mtime">按修改时间</option>
            </select>
          </div>

          {scan?.running && <div className="scanning">正在扫描… 已索引 {scan.scanned} 个素材</div>}

          {viewMode === 'files' ? (
            <div className="grid">
              {files.map(f => (
                <FileCard key={f.id} f={f} onOpen={() => openFile(f)}
                  onZoom={() => setZoom(isSpecialImage(f.rel_path)
                    ? { fileId: f.id, path: f.rel_path, scale: 1 }
                    : { src: `/api/file/${f.id}`, scale: 1 })}
                  onCtx={(e) => { e.preventDefault(); setCtx({ kind: 'file', x: e.clientX, y: e.clientY, file: f }); }} />
              ))}
              {files.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>该目录没有文件</div>}
            </div>
          ) : issuesOnly ? (
            <div className="grid">
              {issueAssets.map(a => (
                <Card key={a.id} a={a} active={false}
                  issue={issueMap.get(a.id)}
                  onSelect={() => setSelIds([a.id])} onOpen={() => openViewer(a)}
                  onCtx={(e) => { e.preventDefault(); setCtx({ kind: 'asset', x: e.clientX, y: e.clientY, asset: a }); }} />
              ))}
              {issueAssets.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>没有发现问题的素材</div>}
            </div>
          ) : loading ? <div className="empty">加载中…</div>
            : assets.length === 0 ? <div className="empty">当前条件下没有素材{!libs.length && <button className="btn primary" onClick={addLibrary}>添加素材库</button>}</div>
            : <div className="grid" ref={gridRef} onClick={e => { if (e.target === e.currentTarget) setSelIds([]); }}>
                {displayAssets.map(a => (
                  <Card key={a.id} a={a} active={selIds.includes(a.id)}
                    issue={issueMap.get(a.id)}
                    chips={chipsFor(a)}
                    onPick={openVariant}
                    onSelect={(e) => handleSelect(a, e)} onOpen={() => openViewer(a)}
                    onZoom={(src) => setZoom({ src, scale: 1 })}
                    onCtx={(e) => { e.preventDefault(); setCtx({ kind: 'asset', x: e.clientX, y: e.clientY, asset: a }); }} />
                ))}
              </div>}
          {!issuesOnly && viewMode === 'assets' && rowsPerPage > 0 && total > rowsPerPage * cols && (
            <div className="pager">
              <button className="btn tiny" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>← 上一页</button>
              <span className="pinfo">第 {page} / {Math.max(1, Math.ceil(total / (rowsPerPage * cols)))} 页 · 共 {total}</span>
              <button className="btn tiny" disabled={page >= Math.ceil(total / (rowsPerPage * cols))} onClick={() => setPage(p => p + 1)}>下一页 →</button>
            </div>
          )}
        </main>

        <aside className={'details' + (sel ? ' open' : '')}>
          {sel && selIds.length > 1 ? (
            <>
              <div className="dhead">
                <b>已选 {selIds.length} 项</b>
                <button className="iconbtn" onClick={() => setSelIds([])}>×</button>
              </div>
              <div className="dbody">
                <div>
                  <div className="detail-h">批量评分</div>
                  <div className="stars">
                    {[1, 2, 3, 4, 5].map(i => (
                      <button key={i} className="star" onClick={() => batchPatch({ rating: i })}>★</button>
                    ))}
                  </div>
                  <div className="uvrow" style={{ marginTop: 6 }}>
                    <button className="btn tiny" onClick={() => batchPatch({ rating: 0 })}>清除评分</button>
                  </div>
                </div>
                <div>
                  <div className="detail-h">收藏</div>
                  <div className="uvrow">
                    <button className="btn" onClick={() => batchPatch({ favorite: 1 })}>全部收藏</button>
                    <button className="btn" onClick={() => batchPatch({ favorite: 0 })}>取消收藏</button>
                  </div>
                </div>
                <div>
                  <div className="detail-h">加标签</div>
                  <select className="field" value="" onChange={e => {
                    const v = e.target.value;
                    if (v) { batchTag(Number(v), 'add'); e.currentTarget.value = ''; }
                  }}>
                    <option value="">选择标签…</option>
                    {tags.map(t => <option key={t.id} value={t.id}>{'— '.repeat(t.depth)}{t.name}</option>)}
                  </select>
                  <div className="detail-h" style={{ marginTop: 10 }}>移标签</div>
                  <select className="field" value="" onChange={e => {
                    const v = e.target.value;
                    if (v) { batchTag(Number(v), 'remove'); e.currentTarget.value = ''; }
                  }}>
                    <option value="">选择标签…</option>
                    {tags.map(t => <option key={t.id} value={t.id}>{'— '.repeat(t.depth)}{t.name}</option>)}
                  </select>
                </div>
                <div className="hint">Ctrl / Shift 点击可多选；双击打开预览。</div>
              </div>
            </>
          ) : sel ? <>
            <div className="dhead"><b>详情</b><button className="iconbtn" onClick={() => setSel(null)}>×</button></div>
            <div className="dbody">
              <div className="preview" style={{ background: fileSel ? '#0d0f13' : (PLACEHOLDER[sel.type] || PLACEHOLDER.other) }}>
                {fileSel ? (
                  /\.(png|jpe?g|webp|gif|bmp)$/i.test(fileSel.rel_path)
                    ? <img src={`/api/file/${fileSel.id}`} alt="" />
                    : isSpecialImage(fileSel.rel_path)
                      ? <SmartImage fileId={fileSel.id} path={fileSel.rel_path} max={0} fit="contain" />
                      : <div className="filenopreview">
                        <span className="fext">{(fileSel.rel_path.split('.').pop() || '').toUpperCase()}</span>
                        <small>{fmtSize(fileSel.size)}</small>
                      </div>
                ) : (() => {
                  const img = sel.files.find(f => isImgPath(f.rel_path));
                  return img && isSpecialImage(img.rel_path)
                    ? <SmartImage fileId={img.id} path={img.rel_path} max={0} fit="contain" />
                    : <img src={`/api/thumb/${sel.id}`} alt="" onError={e => (e.currentTarget.style.display = 'none')} />;
                })()}
              </div>
              {fileSel && (
                <div className="previewbar">
                  <span className="pbname" title={fileSel.rel_path}>{fileSel.rel_path.split('/').pop()}</span>
                  <button className="btn tiny" onClick={() => revealFile(fileSel)}>定位</button>
                  <button className="btn tiny" onClick={() => setFileSel(null)}>返回封面</button>
                </div>
              )}
              <div className="title-row">
                <h2>{sel.name}</h2>
                <div className="sub">{(TYPES.find(t => t.key === sel.type)?.label) || sel.type} · {sel.ext.replace('.', '').toUpperCase()} · {fmtSize(sel.size)}</div>
                <Stars value={sel.rating} onChange={v => patch(sel, { rating: v })} />
              </div>

              <div className="tagrow">
                {(sel.tags || []).map(t => (
                  <span className="tag" key={t.id}>
                    <i style={{ background: t.color || '#8b93a1' }} />{t.name}
                    <button className="tagx" onClick={() => assign(t.id, 'remove')} title="移除">×</button>
                  </span>
                ))}
                <select className="tagadd" value="" onChange={e => {
                  const v = e.target.value;
                  if (v === '__new') createTag();
                  else if (v) assign(Number(v), 'add');
                }}>
                  <option value="">＋ 标签</option>
                  {tags.map(t => <option key={t.id} value={t.id}>{'— '.repeat(t.depth)}{t.name}</option>)}
                  <option value="__new">＋ 新建标签…</option>
                </select>
              </div>
              <div className="uvrow" style={{ marginTop: 6 }}>
                <input className="modal-input" style={{ flex: 1 }} placeholder="输入名称新建标签"
                  value={detailTagName} onChange={e => setDetailTagName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') createDetailTag(); }} />
                <select className="sortsel" value={detailTagParent} onChange={e => setDetailTagParent(e.target.value as any)}>
                  <option value="">未分类（二级）</option>
                  {primaries.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn tiny" onClick={createDetailTag}>新建</button>
              </div>
              <div className="btnrow">
                {sel.type !== 'texture' && (
                  <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => openViewer(sel)}>
                    {sel.type === 'material' ? '打开材质组装器' : '打开 3D 预览'}
                  </button>
                )}
                <button className="btn" onClick={() => patch(sel, { favorite: sel.favorite ? 0 : 1 })}>
                  {sel.favorite ? '★ 已收藏' : '☆ 收藏'}
                </button>
                <button className="btn" onClick={() => reveal(sel)}>定位</button>
              </div>
              {selIssues && selIssues.length > 0 && (
                <div className="issuebox">
                  <div className="detail-h">
                    问题 · {selIssues.filter(i => !i.ignored).length}
                    {selIssues.some(i => !i.ignored) && (
                      <button className="btn tiny" style={{ marginLeft: 'auto' }} onClick={() => ignoreIssues([sel.id])}>全部忽略</button>
                    )}
                  </div>
                  {selIssues.map((it, i) => (
                    <div className={'irow' + (it.ignored ? ' ignored' : '')} key={i}>
                      <span className="ikind">{it.detail || it.kind}</span>
                      {it.ignored
                        ? <span className="itag">已忽略</span>
                        : <button className="btn tiny" onClick={() => ignoreIssues([sel.id], it.kind)}>忽略</button>}
                    </div>
                  ))}
                </div>
              )}
              <div>
                <div className="detail-h">文件 · {sel.files.length}</div>
                <div className="filelist">
                  {sel.files.map(f => (
                    <div className={'file' + (fileSel?.id === f.id ? ' on' : '')} key={f.id}
                      onClick={() => setFileSel(f)}
                      onDoubleClick={() => {
                        if (!isImgPath(f.rel_path)) return;
                        setZoom(isSpecialImage(f.rel_path)
                          ? { fileId: f.id, path: f.rel_path, scale: 1 }
                          : { src: `/api/file/${f.id}`, scale: 1 });
                      }}>
                      <span className="role">{f.role}</span>
                      <span className="fname">{f.rel_path.split('/').pop()}</span>
                      <span className="sz">{fmtSize(f.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="detail-h">位置</div>
                <div className="path">{sel.root}\{sel.rel_dir.split('/').join('\\')}\</div>
              </div>
            </div>
          </> : <div className="dempty">选中素材查看详情</div>}
        </aside>
      </div>

      <footer className="statusbar">        <span className="live"><span className="pulse" />{total} 个素材</span>
        <span>{libs.length} 个库</span>
        <span>{scan?.running ? `扫描中 ${scan.scanned}` : '索引就绪'}</span>
        <div className="status-right">
          <span className="cap">主题</span>
          {THEMES.map(t => (
            <button key={t} className={'sw-t ' + t + (theme === t ? ' on' : '')} onClick={() => setTheme(t)} title={t} />
          ))}
        </div>
      </footer>
      {viewer && <Viewer asset={viewer} onClose={() => setViewer(null)}
        variants={variantMap.get(viewer.id)?.items} onVariant={openVariant} />}
      {assembler && <Assembler asset={assembler} onClose={() => setAssembler(null)}
        variants={variantMap.get(assembler.id)?.items} onVariant={openVariant} />}
      {extMenu && (
        <>
          <div className="menu-mask" onMouseDown={() => setExtMenu(null)} />
          <div className="extmenu" style={{ left: Math.min(extMenu.x, window.innerWidth - 220), top: extMenu.y }}
            onMouseDown={e => e.stopPropagation()}>
            <div className="em-t">{TYPES.find(t => t.key === extMenu.type)?.label} · 隐藏格式</div>
            {exts.filter(x => x.type === extMenu.type).map(x => (
              <label key={x.ext} className="em-row">
                <input type="checkbox" checked={hiddenExts.has(x.ext)} onChange={() => toggleExt(x.ext)} />
                <span>{x.ext.replace('.', '').toUpperCase()}</span>
                <span className="em-n">{x.c}</span>
              </label>
            ))}
            {exts.filter(x => x.type === extMenu.type).length === 0 && <div className="em-row">没有可隐藏的格式</div>}
          </div>
        </>
      )}

      {ctx && (
        <>
          <div className="menu-mask" onMouseDown={() => setCtx(null)}
            onContextMenu={e => { e.preventDefault(); setCtx(null); }} />
          <div className="ctxmenu" style={{
            left: Math.min(ctx.x, window.innerWidth - 230),
            top: Math.min(ctx.y, window.innerHeight - 280)
          }}>
            {ctx.kind === 'asset' ? (<>
              <button onClick={() => { setCtx(null); locateAsset(ctx.asset); }}>定位到文件夹</button>
              <button onClick={() => { setCtx(null); openViewer(ctx.asset); }}>打开预览</button>
              <button onClick={() => { setCtx(null); reveal(ctx.asset); }}>在资源管理器中显示</button>
              <button onClick={() => { setCtx(null); copyText(assetFullPath(ctx.asset)); }}>复制路径</button>
              <div className="ctx-sep" />
              <button onClick={() => { setCtx(null); patch(ctx.asset, { favorite: ctx.asset.favorite ? 0 : 1 }); }}>
                {ctx.asset.favorite ? '取消收藏' : '收藏'}
              </button>
              <button onClick={() => { setCtx(null); patch(ctx.asset, { rating: 0 }); }}>清除评分</button>
              <div className="ctx-sep" />
              <button onClick={() => { setCtx(null); ignoreIssues([ctx.asset.id]); }}>忽略此素材的问题</button>
              {selIds.length > 1 && (
                <button onClick={() => { setCtx(null); ignoreIssues(selIds); }}>忽略选中 {selIds.length} 个素材的问题</button>
              )}
            </>) : ctx.kind === 'file' ? (<>
              <button onClick={() => { setCtx(null); locateFile(ctx.file); }}>定位到文件夹</button>
              <button onClick={() => { setCtx(null); revealFile(ctx.file); }}>在资源管理器中显示</button>
              <button onClick={() => {
                setCtx(null);
                const root = libs.find(l => l.id === lib)?.root || '';
                copyText(`${root}\\${String(ctx.file.rel_path).split('/').join('\\')}`);
              }}>复制路径</button>
              <div className="ctx-sep" />
              <button onClick={() => { setCtx(null); openFile(ctx.file); }}>打开预览</button>
            </>) : (<>
              <button onClick={() => { setCtx(null); revealDir(ctx.node.dir); }}>在资源管理器中打开</button>
              <button onClick={() => {
                setCtx(null);
                const root = libs.find(l => l.id === lib)?.root || '';
                copyText(`${root}\\${String(ctx.node.dir).split('/').join('\\')}`);
              }}>复制路径</button>
              <div className="ctx-sep" />
              <button onClick={() => {
                setCtx(null);
                setShowMapDirs(false);
                setIgnoreNames(prev => [...new Set([...prev, ctx.node.label])]);
              }}>忽略「{ctx.node.label}」</button>
              {ignoreNames.includes(ctx.node.label) && (
                <button onClick={() => {
                  setCtx(null);
                  setIgnoreNames(prev => prev.filter(x => x !== ctx.node.label));
                }}>取消忽略「{ctx.node.label}」</button>
              )}
            </>)}
          </div>
        </>
      )}

      {pluginsOpen && (
        <div className="modal-mask" onMouseDown={() => setPluginsOpen(false)}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">插件管理</div>
            <div className="plug-sec">
              <div className="plug-h">内置模块</div>
              {[
                ['缩略图生成', '离屏渲染 512×512 预览图'],
                ['文件监听', '外部改动后自动重扫索引'],
                ['库体检', '缺失贴图 / 断链 / 缺预览检测'],
                ['材质组装器', '通道拼装、UV 调整与贴图导出'],
                ['HDRI / IES 预览', '环境照明与灯具配光预览']
              ].map(([n, d]) => (
                <div className="plug-row" key={n}>
                  <span className="plug-name">{n}</span>
                  <span className="plug-desc">{d}</span>
                  <span className="plug-on">已启用</span>
                </div>
              ))}
            </div>
            <div className="plug-sec">
              <div className="plug-h">DCC 桥接</div>
              {['Blender', 'SketchUp', '3ds Max', 'Houdini', 'Unreal Engine'].map(n => (
                <div className="plug-row" key={n}>
                  <span className="plug-name">{n}</span>
                  <span className="plug-desc">素材直接发送 / 一键替换</span>
                  <span className="plug-off">未安装</span>
                </div>
              ))}
            </div>
            <div className="hint">插件目录：%APPDATA%\assetmanager-app\plugins（桥接插件随后续版本提供）</div>
            <div className="modal-b">
              <button className="btn" onClick={() => setPluginsOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onMouseDown={() => setSettingsOpen(false)}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">设置 · 素材库</div>
            <div className="issues">
              {orderedLibs.map((l, idx) => (
                <div className="issue" key={l.id}>
                  <span className="ibadge">库</span>
                  <span className="iname" title={l.root}>{l.name}</span>
                  <span className="idetail" title={l.root}>{l.root}</span>
                  <span className="inone">{l.asset_count}</span>
                  <button className="btn tiny" disabled={idx === 0} onClick={() => moveLib(idx, -1)} title="上移">↑</button>
                  <button className="btn tiny" disabled={idx === orderedLibs.length - 1} onClick={() => moveLib(idx, 1)} title="下移">↓</button>
                  <button className="btn tiny" onClick={() => rescanLibrary(l)}>重扫</button>
                  <button className="btn tiny" onClick={() => removeLibrary(l.id)}>移除</button>
                </div>
              ))}
              {libs.length === 0 && <div className="hint" style={{ padding: 8 }}>还没有添加素材库。</div>}
            </div>
            <div className="hint">忽略的文件夹名（回车或点添加，立即生效）</div>
            <div className="uvrow">
              <input className="modal-input" style={{ flex: 1 }} value={ignoreDraft} placeholder="例如 maps, textures"
                onChange={e => setIgnoreDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addIgnore(); }} />
              <button className="btn" onClick={addIgnore}>添加</button>
            </div>
            <div className="tagrow" style={{ marginTop: 4 }}>
              {ignoreNames.map(n => (
                <span className="tag" key={n}>
                  {n}
                  <button className="tagx" onClick={() => setIgnoreNames(prev => prev.filter(x => x !== n))}>×</button>
                </span>
              ))}
            </div>
            <div className="hint">实时预览导航方式（模型查看器）</div>
            <select className="sortsel" defaultValue={localStorage.getItem('am-nav') || 'maya'}
              onChange={e => localStorage.setItem('am-nav', e.target.value)}>
              <option value="maya">Maya</option>
              <option value="max">3ds Max</option>
              <option value="blender">Blender</option>
            </select>
            <div className="hint">每页展示行数（0 = 不限制；列数随窗口宽度自动计算）</div>
            <div className="uvrow">
              <input className="modal-input" type="number" min={0} max={50} value={rowsPerPage}
                onChange={e => {
                  const v = Math.max(0, Math.min(50, Number(e.target.value) || 0));
                  setRowsPerPage(v);
                  localStorage.setItem('am-rows', String(v));
                  setPage(1);
                }} />
            </div>
            <div className="hint">
              移除素材库只清理软件索引，不会删除磁盘文件；文件监听会在外部改动后自动重扫。
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setSettingsOpen(false)}>关闭</button>
              <button className="btn primary" onClick={addLibrary}>添加素材库</button>
            </div>
          </div>
        </div>
      )}

      {tagMgrOpen && (
        <div className="modal-mask" onMouseDown={() => setTagMgrOpen(false)}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">标签管理 · {tags.length} 个</div>
            <div className="tagmgr-body">
              <div className="tagmgr-left">
                <div className={'tgm-item' + (selParent === 'none' ? ' on' : '')} onClick={() => setMgrParent('none')}>
                  <span className="label">未分类</span><span className="count">{unclassified.length}</span>
                </div>
                {primaries.map(p => (
                  <div key={p.id} className={'tgm-item' + (selParent === p.id ? ' on' : '')} onClick={() => setMgrParent(p.id)}>
                    <span className="tdot" style={{ background: p.color || '#8b93a1' }} />
                    <span className="label">{p.name}</span>
                    <span className="count">{p.count}</span>
                  </div>
                ))}
                <div className="tagmgr-new">
                  <input className="modal-input" placeholder="新建一级标签" value={newPrimaryName}
                    onChange={e => setNewPrimaryName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') createPrimaryTag(); }} />
                  <button className="btn tiny" onClick={createPrimaryTag}>添加</button>
                </div>
              </div>
              <div className="tagmgr-right">
                <div className="tagbar">
                  <label className="vp-check">
                    <input type="checkbox"
                      checked={secondaries.length > 0 && secondaries.every(t => tagSel.has(t.id))}
                      onChange={e => setTagSel(e.target.checked ? new Set(secondaries.map(t => t.id)) : new Set())} />
                    全选
                  </label>
                  <span className="hint">已选 {tagSel.size}</span>
                  <span style={{ flex: 1 }} />
                  <input type="color" className="colorinput" value={bulkColor} onChange={e => setBulkColor(e.target.value)} />
                  <button className="btn tiny" disabled={!tagSel.size} onClick={batchColorTags}>改色</button>
                  <select className="sortsel" value={mgrMoveTo} onChange={e => setMgrMoveTo(e.target.value)}>
                    <option value="">移到一级…</option>
                    {primaries.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <button className="btn tiny" disabled={!tagSel.size} onClick={batchMoveTags}>移动</button>
                  <button className="btn tiny" disabled={!tagSel.size} onClick={batchDeleteTags}>删除</button>
                </div>
                <div className="issues taglist">
                  {secondaries.map(t => (
                    <div className="issue trow" key={t.id}>
                      <input type="checkbox" checked={tagSel.has(t.id)}
                        onChange={() => setTagSel(prev => {
                          const s = new Set(prev);
                          if (s.has(t.id)) s.delete(t.id); else s.add(t.id);
                          return s;
                        })} />
                      <input type="color" className="colorinput" value={t.color || '#8b93a1'}
                        onChange={e => updateTag(t.id, { color: e.target.value })} />
                      <input className="taginput" defaultValue={t.name}
                        onBlur={e => { if (e.target.value.trim() && e.target.value !== t.name) updateTag(t.id, { name: e.target.value.trim() }); }} />
                      <span className="inone">{t.count}</span>
                      <button className="btn tiny" onClick={() => deleteTag(t.id)}>删除</button>
                    </div>
                  ))}
                  {secondaries.length === 0 && <div className="hint" style={{ padding: 8 }}>该分类下没有二级标签。</div>}
                </div>
                <div className="tagmgr-new">
                  <input className="modal-input"
                    placeholder={selParent === 'none' ? '新建二级标签（未分类）' : '在该一级标签下新建'}
                    value={newTagName} onChange={e => setNewTagName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') createSecondaryTag(); }} />
                  <button className="btn tiny" onClick={createSecondaryTag}>添加</button>
                </div>
              </div>
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setTagMgrOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {orgOpen && (
        <div className="modal-mask" onMouseDown={() => { if (!orgBusy) setOrgOpen(false); }}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">整理计划 {orgBusy ? '· 处理中…' : `· ${orgRows.length} 项`}</div>
            <div className="hint">
              规范为「类型根 / 分类 / 规范名」，只移动整个素材目录；目录内含多个素材、或目标已存在时自动跳过。
            </div>
            <div className="issues">
              {orgRows.map((r, i) => (
                <div className="issue" key={i}>
                  <span className="ibadge">{r.type}</span>
                  <span className="iname" title={r.name}>{r.name}</span>
                  <span className="idetail" title={`${r.from} → ${r.to}`}>{r.from} → {r.to}</span>
                  {r.conflict
                    ? <span className="inone" style={{ color: 'var(--warn)' }}>冲突</span>
                    : r.skip
                      ? <span className="inone" title={r.skip}>跳过</span>
                      : <span className="inone" style={{ color: 'var(--ok)' }}>可整理</span>}
                </div>
              ))}
              {!orgBusy && orgRows.length === 0 && (
                <div className="hint" style={{ padding: 8 }}>目录已经是规范结构，没有需要整理的项。</div>
              )}
            </div>
            {orgLog.length > 0 && <div className="fixlog">{orgLog.map((l, i) => <div key={i}>{l}</div>)}</div>}
            <div className="modal-b">
              <button className="btn" onClick={() => setOrgOpen(false)}>关闭</button>
              <button className="btn" disabled={orgBusy} onClick={undoOrganize}>撤销上次</button>
              <button className="btn primary" disabled={orgBusy || !orgRows.some(r => !r.conflict && !r.skip)} onClick={applyOrganize}>
                执行整理（{orgRows.filter(r => !r.conflict && !r.skip).length}）
              </button>
            </div>
          </div>
        </div>
      )}

      {checkOpen && (
        <div className="modal-mask" onMouseDown={() => { if (!fixing) setCheckOpen(false); }}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">库体检 {checking ? '· 检查中…' : `· ${issues.length} 个问题`}</div>
            {skipped > 0 && <div className="hint">另有 {skipped} 个模型超过 24 MB 未扫描（避免读取过慢）。</div>}
            <div className="issues">
              {issues.map((it, i) => (
                <div className="issue" key={i}>
                  <span className="ibadge">{it.type}</span>
                  <span className="iname" title={it.name}>{it.name}</span>
                  <span className="idetail" title={it.detail}>{it.detail}</span>
                  {it.fix
                    ? <button className="btn tiny" disabled={fixing} onClick={() => fixOne(it)}>
                        {it.fix === 'rewrite-mtlx' ? '重写 .mtlx' : '复制贴图'}
                      </button>
                    : <span className="inone">—</span>}
                </div>
              ))}
              {!checking && issues.length === 0 && <div className="hint" style={{ padding: 8 }}>没有发现问题。</div>}
            </div>
            {fixLog.length > 0 && (
              <div className="fixlog">{fixLog.map((l, i) => <div key={i}>{l}</div>)}</div>
            )}
            <div className="modal-b">
              <button className="btn" onClick={() => setCheckOpen(false)}>关闭</button>
              <button className="btn primary" disabled={fixing || !issues.some(i => i.fix)} onClick={fixAll}>
                全部修复（{issues.filter(i => i.fix).length}）
              </button>
            </div>
          </div>
        </div>
      )}

      {ask && (
        <div className="modal-mask" onMouseDown={() => submitAsk(null)}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">{ask.title}</div>
            <input className="modal-input" autoFocus value={ask.value}
              onChange={e => setAsk({ ...ask, value: e.target.value })}
              onKeyDown={e => {
                if (e.key === 'Enter') submitAsk(ask.value);
                if (e.key === 'Escape') submitAsk(null);
              }} />
            <div className="modal-b">
              <button className="btn" onClick={() => submitAsk(null)}>取消</button>
              <button className="btn primary" onClick={() => submitAsk(ask.value)}>确定</button>
            </div>
          </div>
        </div>
      )}

      {zoom && (
        <div className="zoomov" onMouseDown={() => setZoom(null)}
          onWheel={e => {
            e.preventDefault();
            setZoom(z => z ? { ...z, scale: Math.min(8, Math.max(1, z.scale * (1 - Math.sign(e.deltaY) * 0.12))) } : z);
          }}>
          <div className="zoomwrap" style={{ transform: `scale(${zoom.scale})` }} onMouseDown={e => e.stopPropagation()}>
            {zoom.fileId
              ? <SmartImage fileId={zoom.fileId} path={zoom.path || ''} max={0} fit="contain" />
              : <img src={zoom.src} alt="" />}
          </div>
          <div className="zoomhint">滚轮缩放 · 点击空白关闭 · {Math.round(zoom.scale * 100)}%</div>
        </div>
      )}

      {dropActive && (
        <div className="dropzone">
          <div className="dropbox">
            <div className="droptitle">松开导入到「{libs.find(l => l.id === lib)?.name || '当前库'}」</div>
            <div className="drophint">
              按类型自动归入 02_Materials / 05_Models / 04_HDRI / 01_Texture / 07_CAD，随后可用「整理」规范化命名。
            </div>
          </div>
        </div>
      )}

      {importLog.length > 0 && (
        <div className="importlog">
          <div className="ilog-t">{importing ? '导入中…' : '导入结果'}</div>
          {importLog.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
