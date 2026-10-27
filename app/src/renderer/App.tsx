import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Asset, AssetDetail, Library, ScanState, TagNode, TreeNode } from './types';
import Viewer from './Viewer';
import Assembler from './Assembler';
import { renderThumb } from './thumbnailer';
import { exportGlbForSketchUp } from './glbconvert';
import SmartImage, { isSpecialImage } from './SmartImage';
import { history } from './history';

const TYPES = [
  { key: 'all', label: '全部' },
  { key: 'material', label: '材质' },
  { key: 'model', label: '模型' },
  { key: 'texture', label: '贴图' },
  { key: 'drawing', label: '图纸' },
  { key: 'hdri', label: 'HDRI' },
  { key: 'ies', label: 'IES' }
];

const THEMES = ['dark', 'light'];

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

function FileCard({ f, active, onOpen, onCtx, onZoom, onDragStart }: { f: any; active?: boolean; onOpen: () => void; onCtx?: (e: any) => void; onZoom?: () => void; onDragStart?: (e: any) => void }) {
  const name = String(f.rel_path).split('/').pop() || '';
  const ext = (name.split('.').pop() || '').toUpperCase();
  return (
    <article className={'card filecard' + (active ? ' on' : '')} onClick={onOpen} onContextMenu={onCtx} onDoubleClick={onZoom}
      draggable={!!onDragStart} onDragStart={onDragStart} title={f.rel_path}>
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

function Card({ a, active, thumbVer, onSelect, onOpen, onCtx, onZoom, issue, chips, onPick, onDrag, onPress }: { a: Asset; active: boolean; thumbVer?: number; onSelect: (e: any) => void; onOpen: () => void; onCtx?: (e: any) => void; onZoom?: (src: string) => void; issue?: string; chips?: { id: number; label: string }[]; onPick?: (id: number) => void; onDrag?: (e: any) => void; onPress?: () => void }) {
  const [broken, setBroken] = useState(false);
  const badge = (a.ext || '').replace('.', '').toUpperCase();
  return (
    <article className={'card' + (active ? ' on' : '')} data-asset={a.id} onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onCtx}
      onMouseDown={onPress} draggable={!!onDrag} onDragStart={onDrag}>
      <div className="thumb" style={{ background: PLACEHOLDER[a.type] || PLACEHOLDER.other }}>
        {(a as any).img_file_id && isSpecialImage(a.ext || '') ? (
          <SmartImage fileId={(a as any).img_file_id} path={a.ext || ''} />
        ) : ((a as any).has_image || a.preview_rel) && !broken ? (
          <img src={`/api/thumb/${a.id}?v=${encodeURIComponent((a as any).preview_rel || (a as any).thumb_file || '')}&r=${thumbVer || 0}`} loading="lazy" alt=""
            onDoubleClick={e => { e.stopPropagation(); onZoom?.(`/api/thumb/${a.id}?v=${encodeURIComponent((a as any).preview_rel || (a as any).thumb_file || '')}&r=${thumbVer || 0}`); }}
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
  const [pageDraft, setPageDraft] = useState('1');
  const [cols, setCols] = useState(6);
  const gridRef = useRef<HTMLDivElement>(null);
  const [fileSel, setFileSel] = useState<any | null>(null);
  const [thumbVer, setThumbVer] = useState(0);
  const [selIds, setSelIds] = useState<number[]>([]);
  const [viewer, setViewer] = useState<AssetDetail | null>(null);
  const [assembler, setAssembler] = useState<AssetDetail | null>(null);
  const [assemblerFolder, setAssemblerFolder] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('am-theme') || 'dark');
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(0);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [ratingFilter, setRatingFilter] = useState(0);
  const [ratingOp, setRatingOp] = useState<'gte' | 'lte' | 'eq'>('gte');
  const [ratingInc, setRatingInc] = useState(true);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [ratingPos, setRatingPos] = useState({ x: 0, y: 0 });
  const ratingBtnRef = useRef<HTMLButtonElement>(null);
  function openRatingPop() {
    const el = ratingBtnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRatingPos({ x: Math.min(r.left, window.innerWidth - 270), y: r.bottom + 6 });
    }
    setRatingOpen(v => !v);
  }
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
  const ctxRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const [tagMgrOpen, setTagMgrOpen] = useState(false);
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; ids: number[]; kind: 'primary' | 'secondary' | 'empty-primary' | 'empty-secondary' } | null>(null);
  // 菜单完全落在窗口内：放不下时向上顶，不出现滚动条
  useLayoutEffect(() => {
    for (const ref of [ctxRef, tagMenuRef]) {
      const el = ref.current;
      if (!el) continue;
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
      const h = el.offsetHeight;
      const wantTop = Number(el.dataset.wantTop || 0);
      const top = Math.max(8, Math.min(wantTop, window.innerHeight - h - 8));
      el.style.top = top + 'px';
    }
  }, [ctx, tagMenu]);
  const [tagColorEdit, setTagColorEdit] = useState<{ ids: number[]; value: string } | null>(null);
  const lastIdx = useRef(0);
  const lastMeta = useRef('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpInfo, setMcpInfo] = useState<any>(null);
  const [wsInfo, setWsInfo] = useState<any>(null);
  const [hdriAsk, setHdriAsk] = useState<{ asset: Asset } | null>(null);
  const [hdriEnv, setHdriEnv] = useState(true);
  const [hdriVp, setHdriVp] = useState(true);
  /** UE 导入模型：先问要导什么（默认只静态网格体） */
  const [ueImportAsk, setUeImportAsk] = useState<{ asset: Asset } | null>(null);
  const [ueImpStatic, setUeImpStatic] = useState(true);
  const [ueImpSkeletal, setUeImpSkeletal] = useState(false);
  const [ueImpPhysics, setUeImpPhysics] = useState(false);
  const [ueImpPlace, setUeImpPlace] = useState(false);
  const [wsPrompt, setWsPrompt] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [closeAction, setCloseAction] = useState<'ask' | 'tray' | 'quit'>('ask');
  useEffect(() => {
    (window as any).amApi?.getCloseAction?.().then((v: any) => setCloseAction(v === 'tray' || v === 'quit' ? v : 'ask')).catch(() => {});
  }, []);
  async function changeCloseAction(v: 'ask' | 'tray' | 'quit') {
    setCloseAction(v);
    await (window as any).amApi?.setCloseAction?.(v);
  }
  const [ghTokenDraft, setGhTokenDraft] = useState('');
  const [tagSel, setTagSel] = useState<Set<number>>(new Set());
  const [tagMulti, setTagMulti] = useState<Set<number>>(new Set());
  const [bulkColor, setBulkColor] = useState('#8b93a1');
  const [mgrParent, setMgrParent] = useState<number | 'none' | null>(null);
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem('am-side-open') !== '0');
  const [detailW, setDetailW] = useState(() => Number(localStorage.getItem('am-detail-w')) || 340);
  useEffect(() => { localStorage.setItem('am-side-open', sideOpen ? '1' : '0'); }, [sideOpen]);
  useEffect(() => { localStorage.setItem('am-detail-w', String(detailW)); }, [detailW]);
  function startDetailResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = detailW;
    const move = (ev: PointerEvent) => {
      const max = Math.min(760, window.innerWidth * 0.62);
      setDetailW(Math.min(max, Math.max(260, startW - (ev.clientX - startX))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  const [newTagName, setNewTagName] = useState('');
  const [newPrimaryName, setNewPrimaryName] = useState('');
  const [newTagParent, setNewTagParent] = useState<number | ''>('');
  const [mgrMoveTo, setMgrMoveTo] = useState<number | ''>('');
  const [detailTagName, setDetailTagName] = useState('');
  const [detailTagParent, setDetailTagParent] = useState<number | ''>('');
  const [tagPickOpen, setTagPickOpen] = useState(false);
  const [tagPickQ, setTagPickQ] = useState('');
  const [tagPickParent, setTagPickParent] = useState<number | null>(null);
  const [pickAssign, setPickAssign] = useState<{ all: number[]; any: number[] }>({ all: [], any: [] });
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
  const [orgShrinkBusy, setOrgShrinkBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importLog, setImportLog] = useState<string[]>([]);
  const win = (window as any).winApi;
  const isElectron = !!win?.isElectron;
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  // DCC 桥接（3ds Max / Blender）
  const [bridge, setBridge] = useState<any>(null);
  const [bridgeInfo, setBridgeInfo] = useState<any>(null);
  const [bridgeJobs, setBridgeJobs] = useState<any[]>([]);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  // 「发送到…」菜单：点一个按钮列出可发送的软件，不再一个软件一个按钮
  const [sendMenu, setSendMenu] = useState<{ asset: Asset; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<{ id: number; kind: 'ok' | 'err' | 'info'; msg: string } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // 选中请求序号：防止慢响应把后来点的素材覆盖掉
  const selSeq = useRef(0);
  const loadSeq = useRef(0);
  const pageRef = useRef(page);
  useEffect(() => { pageRef.current = page; }, [page]);
  // 拖到 3ds Max 的「描述文件」缓存（.ms，Max 拖入即执行）
  const dropFileCache = useRef<Map<number, string>>(new Map());

  const askRef = useRef<HTMLInputElement>(null);
  const askText = (title: string, value = '', browse = false) => new Promise<string | null>(resolve => setAsk({ title, value, browse, resolve }));
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
        await fetch('/api/preview/write', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assetId: list[i].id, dataUrl: url })
        });
      } catch { /* skip broken asset */ }
    }
    setGenMsg(null);
    setGenBusy(false);
    await loadAssets(lib);
    await loadMissing(lib);
  }

  // ---------------------------------------------------------- F-003 预览图维护
  async function rematchPreviews(ids: number[]) {
    if (!ids.length || genBusy) return;
    setGenBusy(true);
    setGenMsg(`重新匹配预览图 0/${ids.length}`);
    try {
      const r = await api('/api/preview/rematch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetIds: ids })
      });
      const failed = (r.results || []).filter((x: any) => !x.ok);
      showToast(`重新匹配完成：成功 ${r.ok}/${r.total}${failed.length ? `，失败 ${failed.length}` : ''}`,
        failed.length ? 'info' : 'ok');
      if (lib) {
        await loadAssets(lib);
        await loadMissing(lib);
        setThumbVer(v => v + 1);
        if (sel && ids.includes(sel.id)) await refreshDetail();
      }
    } catch (e: any) {
      showToast('重新匹配失败：' + (e?.message || e), 'err');
    } finally {
      setGenMsg(null);
      setGenBusy(false);
    }
  }

  async function renderPreviews(ids: number[]) {
    if (!ids.length || genBusy) return;
    setGenBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      setGenMsg(`重新渲染预览图 ${i + 1}/${ids.length}`);
      try {
        const d = await api(`/api/asset/${ids[i]}`);
        const url = await renderThumb(d);
        await fetch('/api/preview/write', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assetId: ids[i], dataUrl: url })
        });
        ok++;
      } catch (e: any) {
        failed.push(`${ids[i]}: ${e?.message || e}`);
      }
    }
    setGenMsg(null);
    setGenBusy(false);
    setThumbVer(v => v + 1);
    if (lib) await loadAssets(lib);
    showToast(`重新渲染完成：成功 ${ok}/${ids.length}${failed.length ? `，失败 ${failed.length}` : ''}`,
      failed.length ? 'info' : 'ok');
    if (lib) {
      await loadAssets(lib);
      await loadMissing(lib);
      if (sel && ids.includes(sel.id)) await refreshDetail();
    }
  }

  async function refreshLibrary() {
    if (!lib) return;
    const root = libs.find(l => l.id === lib)?.root;
    if (!root) return;
    showToast('正在刷新素材库…', 'info');
    await api('/api/libraries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root })
    });
    setScan(s => s ? { ...s, running: true } : s);
    // 等扫描真正结束再刷新界面，避免中途拿到半份数据导致页码/内容错位（B-007）
    window.setTimeout(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const st = await api('/api/scan').catch(() => null);
        if (st && !st.running) break;
        await new Promise(r => window.setTimeout(r, 700));
      }
      if (!lib) return;
      await loadAssets(lib);
      await loadMeta(lib);
      await refreshIssues();
      await refreshDetail();
    }, 600);
  }

  async function loadAssets(id = lib) {
    if (!id) return;
    const curPage = pageRef.current;
    const pageSize = rowsPerPage > 0 ? rowsPerPage * cols : 0;
    const seq = ++loadSeq.current;
    const qs = new URLSearchParams({
      lib: String(id), q, dir, recursive: recursive ? '1' : '0', sort,
      limit: String(pageSize || 5000),
      offset: String(pageSize ? (curPage - 1) * pageSize : 0),
      ...(activeTag ? { tag: String(activeTag) } : {}),
      ...(tagMulti.size ? { tags: [...tagMulti].join(',') } : {}),
      ...((ratingFilter ? { ratingOp, ratingValue: String(ratingFilter), ratingInclusive: ratingInc ? '1' : '0' } : {}) as any),
      ...(favFilter ? { fav: '1' } : {}),
      ...(extFilter ? { ext: extFilter } : {}),
      ...(excludedTypes.size ? { excludeType: [...excludedTypes].join(',') } : {}),
      ...(hiddenExts.size ? { excludeExt: [...hiddenExts].join(',') } : {})
    });
    const r = await api('/api/assets?' + qs.toString());
    if (seq !== loadSeq.current) return;
    const t = Number(r.total ?? (r.assets || []).length);
    if (pageSize > 0 && curPage > Math.max(1, Math.ceil(t / pageSize))) {
      setPage(Math.max(1, Math.ceil(t / pageSize)));
      return;
    }
    setAssets(r.assets || []);
    setTotal(t);
    setLoading(false);
    if (!sel && r.assets?.length) select(r.assets[0]);
  }

  useEffect(() => { boot(); }, []);
  // 桥接状态：面板打开时 2s 刷新，平时 8s
  useEffect(() => {
    loadBridge();
    const t = window.setInterval(() => { loadBridge(); }, pluginsOpen ? 2000 : 8000);
    return () => window.clearInterval(t);
  }, [pluginsOpen]);
  useEffect(() => { if (lib) loadMeta(lib); }, [lib]);
  useEffect(() => {
    if (settingsOpen) api('/api/mcp/status').then(setMcpInfo).catch(() => {});
  }, [settingsOpen]);

  useEffect(() => {
    api('/api/workspace').then(r => { setWsInfo(r); if (!r.isSet) setWsPrompt(true); }).catch(() => {});
  }, []);

  async function chooseWorkspace() {
    const wapi = (window as any).amApi;
    const dir = wapi?.pickFolder ? await wapi.pickFolder() : '';
    if (!dir) return;
    const r = await api('/api/workspace', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir })
    });
    if (r?.error) { showToast('设置工作区失败：' + r.error, 'err'); return; }
    setWsInfo({ ...r, isSet: true });
    setWsPrompt(false);
    showToast('工作区已设为 ' + r.path + '（旧文件已迁移）', 'ok');
  }

  async function setMcp(patch: any) {
    const r = await api('/api/mcp/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    });
    setMcpInfo(r);
  }

  useEffect(() => {
    if (!lib) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => loadAssets(lib), 160);
    return () => window.clearTimeout(timer.current);
  }, [lib, q, dir, recursive, sort, activeTag, tagMulti, ratingFilter, ratingOp, ratingInc, favFilter, extFilter, excludedTypes, hiddenExts, rowsPerPage, cols, page]);

  // 筛选条件变化时回到第一页
  useEffect(() => { setPage(1); }, [q, dir, recursive, sort, activeTag, ratingFilter, ratingOp, ratingInc, favFilter, extFilter, excludedTypes, hiddenExts]);
  useEffect(() => { setPageDraft(String(page)); }, [page]);

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

  const filterQs = useMemo(() => {
    const p = new URLSearchParams({
      q, dir, recursive: recursive ? '1' : '0',
      ...(activeTag ? { tag: String(activeTag) } : {}),
      ...(tagMulti.size ? { tags: [...tagMulti].join(',') } : {}),
      ...((ratingFilter ? { ratingOp, ratingValue: String(ratingFilter), ratingInclusive: ratingInc ? '1' : '0' } : {}) as any),
      ...(favFilter ? { fav: '1' } : {}),
      ...(extFilter ? { ext: extFilter } : {}),
      ...(excludedTypes.size ? { excludeType: [...excludedTypes].join(',') } : {}),
      ...(hiddenExts.size ? { excludeExt: [...hiddenExts].join(',') } : {})
    });
    return p.toString();
  }, [q, dir, recursive, activeTag, tagMulti, ratingFilter, ratingOp, ratingInc, favFilter, extFilter, excludedTypes, hiddenExts]);

  useEffect(() => {
    if (!lib) return;
    let alive = true;
    const url = issuesOnly
      ? `/api/issues?lib=${lib}&filter=1&${filterQs}`
      : `/api/issues?lib=${lib}`;
    api(url).then(r => {
      if (!alive) return;
      setIssueList(r.issues || []);
      setIssueAssets(r.assets || []);
      setIssueMap(new Map((r.issues || []).map((i: any) => [i.assetId, i.detail || i.kind])));
    }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [lib, issuesOnly, filterQs]);

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
    if (d.type === 'material') { setAssemblerFolder(''); setAssembler(d); }
    else if (['model', 'scene', 'hdri', 'ies'].includes(d.type)) setViewer(d);
  }

  async function openStandaloneAssembler() {
    let dir = '';
    const wapi = (window as any).amApi;
    if (wapi?.pickFolder) dir = await wapi.pickFolder();
    else dir = (await askText('输入贴图文件夹路径', '')) || '';
    if (!dir) return;
    try {
      const r = await api(`/api/folder/textures?path=${encodeURIComponent(dir)}`);
      if (!r.files?.length) { showToast('该文件夹里没有可用的贴图', 'err'); return; }
      const name = dir.split(/[\\/]/).filter(Boolean).pop() || 'Material';
      const files = r.files.map((f: any, i: number) => ({
        id: -(i + 1), rel_path: f.path, role: 'map', slot: null, size: f.size || 0
      }));
      const pseudo: AssetDetail = {
        id: 0, library_id: 0, rel_dir: '', name, type: 'material', ext: '.png',
        category: null, size: 0, rating: 0, favorite: 0, preview_rel: null,
        root: dir, files
      } as any;
      setAssemblerFolder(dir);
      setAssembler(pseudo);
    } catch (e: any) {
      showToast('读取文件夹失败：' + (e?.message || e), 'err');
    }
  }

  function chipsFor(a: Asset): { id: number; label: string }[] {
    // 多尺寸作为独立素材显示，每张卡只显示自己的分辨率角标
    const m = a.name.match(/(\d+)k/i);
    return m ? [{ id: a.id, label: `${m[1]}K` }] : [];
  }

  const displayAssets = useMemo(() => assets, [assets]);

  useEffect(() => { localStorage.setItem('am-show-filedirs', showMapDirs ? '1' : '0'); }, [showMapDirs]);
  useEffect(() => { localStorage.setItem('am-ignore', JSON.stringify(ignoreNames)); }, [ignoreNames]);

  function toggleType(key: string, only = false) {
    setExcludedTypes(prev => {
      const s = only
        ? new Set(TYPES.filter(t => t.key !== 'all' && t.key !== key).map(t => t.key))
        : new Set(prev);
      if (!only) {
        if (s.has(key)) s.delete(key); else s.add(key);
      }
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
    const block = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);


  const exFileKinds = useMemo(() => {
    const map: Record<string, string> = {
      model: 'model', scene: 'model', material: 'texture', texture: 'texture',
      hdri: 'hdri', ies: 'ies', drawing: 'drawing'
    };
    return [...new Set([...excludedTypes].map(t => map[t]).filter(Boolean))].join(',');
  }, [excludedTypes]);

  useEffect(() => {
    if (viewMode !== 'files' || !lib) return;
    const qs = new URLSearchParams({
      lib: String(lib), dir: fileDir || dir, q, limit: '500', filter: '1',
      ...(exFileKinds ? { excludeFileKind: exFileKinds } : {})
    });
    api('/api/files?' + qs.toString() + '&' + filterQs).then(r => setFiles(r.files || []));
  }, [viewMode, lib, fileDir, dir, q, filterQs, exFileKinds]);

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
    const r = await api(`/api/organize/plan?lib=${lib}&dir=${encodeURIComponent(dir)}`);
    setOrgRows(r.rows || []);
    setOrgBusy(false);
  }

  function loadImg(src: string) {
    return new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
  }

  /** 压缩当前目录（含子目录）的过大预览图（≤1024），并生成 512 网格缩略图（解决 HDRI 列表卡顿） */
  async function shrinkPreviews() {
    if (!lib) return [] as string[];
    setOrgShrinkBusy(true);
    try {
      const r = await api(`/api/previews?lib=${lib}&dir=${encodeURIComponent(dir)}`).catch(() => ({ previews: [] }));
      const list: any[] = r.previews || [];
      const logs: string[] = [];
      const toPng = (cv: HTMLCanvasElement) => new Promise<Blob>(res => cv.toBlob(b => res(b!), 'image/png', 0.92));
      for (const p of list) {
        try {
          const im = await loadImg(`/api/file/${p.fid}?v=${Date.now()}`);
          const mx = Math.max(im.naturalWidth, im.naturalHeight);
          let base: HTMLCanvasElement | null = null;
          let sized = `${im.naturalWidth}×${im.naturalHeight}`;
          if (mx > 1024) {
            const k = 1024 / mx;
            base = document.createElement('canvas');
            base.width = Math.max(1, Math.round(im.naturalWidth * k));
            base.height = Math.max(1, Math.round(im.naturalHeight * k));
            base.getContext('2d')!.drawImage(im, 0, 0, base.width, base.height);
            const isPng = /\.png$/i.test(String(p.preview_rel));
            const blob: Blob = await new Promise(r2 => base!.toBlob(b => r2(b!), isPng ? 'image/png' : 'image/jpeg', 0.9));
            const w = await fetch(`/api/preview/write/${p.fid}`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
            if (!w.ok) throw new Error('写入失败');
            sized += ` → ${base.width}×${base.height}`;
          }
          // 512 网格缩略图（懒加载用，避免 8K/1024 图逐张解码卡顿）
          if (mx > 512) {
            const src = base || im;
            const sw = base ? base.width : im.naturalWidth;
            const sh = base ? base.height : im.naturalHeight;
            const k2 = 512 / Math.max(sw, sh);
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(sw * k2));
            cv.height = Math.max(1, Math.round(sh * k2));
            cv.getContext('2d')!.drawImage(src as any, 0, 0, cv.width, cv.height);
            const blob = await toPng(cv);
            const dataUrl = await new Promise<string>(res => {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result));
              fr.readAsDataURL(blob);
            });
            await fetch(`/api/thumb/${p.aid}`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dataUrl })
            });
            sized += '（已生成 512 缩略图）';
          }
          logs.push(`✔ ${p.name}：${sized}`);
        } catch (e: any) {
          logs.push(`✘ ${p.name}：${String(e?.message || e)}`);
        }
      }
      if (!logs.length) logs.push('当前目录没有预览图。');
      return logs;
    } finally {
      setOrgShrinkBusy(false);
    }
  }

  async function applyOrganize() {
    if (!lib) return;
    setOrgBusy(true);
    const r = await api('/api/organize/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lib, rows: orgRows })
    });
    const moveLogs = [
      ...(r.applied || []).map((x: any) => `✔ ${x.from}  →  ${x.to}`),
      ...(r.failed || []).map((x: any) => `✘ ${x.from}：${x.error}`)
    ];
    setOrgLog(moveLogs);
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

  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, rowsPerPage * cols)));

  function jumpPage() {
    const n = Math.max(1, Math.min(pageCount, Number(pageDraft) || 1));
    setPage(n);
    setPageDraft(String(n));
  }

  async function select(a: Asset) {
    const seq = ++selSeq.current;
    // 先把详情切到被点的这张卡，别等接口回来（否则会短暂显示上一个素材，定位/导出也跟着错）
    setSel(prev => (prev && prev.id === a.id
      ? prev
      : ({ ...(a as any), files: [], tags: [] } as any)));
    setFileSel(null);
    const d = await api(`/api/asset/${a.id}`).catch(() => ({ error: 'not found' }));
    if (seq !== selSeq.current) return;   // 丢弃过期响应
    if (!d || (d as any).error) { setSel(null); setSelIds([]); return; }
    setSel(d);
  }

  async function openViewer(a: Asset) {
    const seq = ++selSeq.current;
    const d = await api(`/api/asset/${a.id}`);
    if (seq !== selSeq.current) return;
    setSel(d);
    if (a.type === 'material') { setAssemblerFolder(''); setAssembler(d); }
    else if (['model', 'scene', 'hdri', 'ies'].includes(a.type)) setViewer(d);
  }

  // ---------------------------------------------------------- DCC 桥接

  function showToast(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), kind, msg });
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'err' ? 8000 : 4500);
  }

  async function loadBridge() {
    try {
      const [st, info, maxJobs, blJobs, suJobs, ueJobs, mayaJobs] = await Promise.all([
        api('/api/bridge/status'), api('/api/bridge/info'),
        api('/api/bridge/jobs?target=max&limit=8'), api('/api/bridge/jobs?target=blender&limit=8'),
        api('/api/bridge/jobs?target=su&limit=8'), api('/api/bridge/jobs?target=ue&limit=8'),
        api('/api/bridge/jobs?target=maya&limit=8')
      ]);
      setBridge(st);
      setBridgeInfo(info);
      // Max / Blender / SketchUp / UE / Maya 的任务合并显示，新的在前
      const merged = [...(maxJobs?.jobs || []), ...(blJobs?.jobs || []), ...(suJobs?.jobs || []),
        ...(ueJobs?.jobs || []), ...(mayaJobs?.jobs || [])]
        .sort((a: any, b: any) => (b.id || 0) - (a.id || 0))
        .slice(0, 8);
      setBridgeJobs(merged);
    } catch { /* 服务端未就绪时忽略 */ }
  }

  /** 素材适合哪种发送方式 */
  function sendModeFor(a: Asset): 'import' | 'material' | 'texture' | 'hdri' | 'ies' | null {
    if (a.type === 'model') return 'import';
    if (a.type === 'material') return 'material';
    if (a.type === 'texture') return 'texture';
    if (a.type === 'hdri') return 'hdri';
    if (a.type === 'ies') return 'ies';
    return null;
  }

  /** 可发送的软件（顺序=菜单顺序） */
  const SEND_TARGETS: { key: 'max' | 'blender' | 'su' | 'ue' | 'maya'; label: string }[] = [
    { key: 'max', label: '3ds Max' },
    { key: 'blender', label: 'Blender' },
    { key: 'su', label: 'SketchUp' },
    { key: 'ue', label: 'Unreal Engine' },
    { key: 'maya', label: 'Maya' }
  ];

  /** 某个模式能发给哪些软件（IES 需要原生支持配光文件的引擎：UE / Maya+Arnold） */
  const MODE_TARGETS: Record<string, string[]> = {
    import: ['max', 'blender', 'su', 'ue', 'maya'],
    material: ['max', 'blender', 'su', 'ue', 'maya'],
    texture: ['max', 'blender', 'su', 'ue', 'maya'],
    hdri: ['max', 'blender', 'su', 'ue', 'maya'],
    ies: ['ue', 'maya']
  };

  /** 当前素材可选的发送目标 */
  function targetsFor(a: Asset) {
    const m = sendModeFor(a);
    const allow = m ? (MODE_TARGETS[m] || []) : [];
    return SEND_TARGETS.filter(t => allow.includes(t.key));
  }

  const maxConnected = !!bridge?.targets?.max?.connected;
  const blenderTarget = bridge?.targets?.blender;
  const blenderConnected = !!blenderTarget?.connected;
  const suTarget = bridge?.targets?.su;
  const suConnected = !!suTarget?.connected;
  const ueTarget = bridge?.targets?.ue;
  const ueConnected = !!ueTarget?.connected;
  const mayaTarget = bridge?.targets?.maya;
  const mayaConnected = !!mayaTarget?.connected;

  /** 打开「发送到…」菜单（锚在按钮下方或右键位置） */
  function openSendMenu(a: Asset, at: { x: number; y: number }) {
    if (!sendModeFor(a)) { showToast('这类素材不支持发送到 DCC（模型/材质/贴图/HDRI/IES 才有）', 'err'); return; }
    const w = 236, h = 40 + targetsFor(a).length * 34;
    setSendMenu({
      asset: a,
      x: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - h - 8))
    });
  }

  /** 按钮点击时用按钮位置当锚点 */
  function openSendMenuFromEvent(a: Asset, e: React.MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openSendMenu(a, { x: r.left, y: r.bottom + 4 });
  }

  async function sendToTarget(a: Asset, target: 'max' | 'blender' | 'su' | 'ue' | 'maya', mode?: 'import' | 'material' | 'texture' | 'hdri' | 'ies', opts?: { options?: any }) {
    const tName = target === 'blender' ? 'Blender' : target === 'su' ? 'SketchUp'
      : target === 'ue' ? 'Unreal Engine' : target === 'maya' ? 'Maya' : '3ds Max';
    const online = !!bridge?.targets?.[target]?.connected;
    const m = mode || sendModeFor(a);
    if (!m) { showToast(`这类素材不支持发送到 ${tName}`, 'err'); return; }
    const label = m === 'import' ? '导入模型' : m === 'material' ? '创建材质'
      : m === 'hdri' ? '应用 HDRI' : m === 'ies' ? '发送 IES' : '发送贴图';
    setBridgeBusy(true);
    try {
      const send = (extra: Record<string, unknown> = {}) => api('/api/bridge/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: a.id, mode: m, target, ...(opts?.options ? { options: opts.options } : {}), ...extra })
      });
      let r = await send();

      // SketchUp 读不了这个模型格式（FBX/OBJ/PLY）：软件先临时导出一份 GLB，再让插件导入它
      if (r?.needsConvert) {
        showToast(`SketchUp 读不了 ${r.ext}：正在临时导出 GLB…（素材文件不改）`);
        const detail = await api(`/api/asset/${a.id}`);
        const { blob, stats } = await exportGlbForSketchUp(detail);
        const upRes = await fetch(
          `/api/bridge/convert?assetId=${a.id}&name=${encodeURIComponent(a.name)}`,
          { method: 'POST', body: blob }
        );
        const up = await upRes.json().catch(() => null);
        if (!up?.ok) { showToast(`导出 GLB 失败：${up?.error || upRes.status}`, 'err'); return; }
        const mb = (stats.glbBytes / 1048576).toFixed(1);
        const dim = stats.sizeM.map(v => v.toFixed(2)).join(' × ');
        showToast(`已导出 GLB（${mb}MB · ${dim} m${stats.note ? ' · ' + stats.note : ''}），正在发送…`);
        r = await send({ modelPath: up.path, convertedFrom: stats.ext });
      }

      if (!r?.id) { showToast(`发送失败：${r?.error || '服务端未响应'}`, 'err'); return; }
      showToast(online
        ? `已发给 ${tName}（${label}），等待处理…`
        : `已排队（${label}）：未检测到 ${tName}，启动后会自动执行`);

      const started = Date.now();
      let job: any = null;
      while (Date.now() - started < 60000) {
        await new Promise(res => window.setTimeout(res, 700));
        job = await api(`/api/bridge/job/${r.id}`);
        if (!job?.status || job.status === 'done' || job.status === 'failed') break;
        if (Date.now() - started > 8000 && !online) break;
      }
      if (job?.status === 'done') showToast(job.message || `${label}完成`, 'ok');
      else if (job?.status === 'failed') showToast(`${tName} 执行失败：${job.message || '未知原因'}`, 'err');
      else if (job?.status === 'pending' || job?.status === 'running') {
        showToast(`任务仍在队列中（${label}）：确认 ${tName} 已启动并安装了插件`, 'err');
      }
      await loadBridge();
    } catch (e: any) {
      showToast('发送失败：' + String(e?.message || e), 'err');
    } finally {
      setBridgeBusy(false);
    }
  }

  /** 悬停提示：各软件的连接状态 */
  function onlineSummary() {
    const parts = SEND_TARGETS.map(t => {
      const st = bridge?.targets?.[t.key];
      return `${t.label} ${st?.connected ? '已连接' : '未检测到'}`;
    });
    return `发送到…（${parts.join(' · ')}）`;
  }

  /** 一键装 Blender 插件：后端按各 Blender 版本挑对应系列，写进它的用户插件目录 */
  async function installBlenderPlugin() {
    setBridgeBusy(true);
    try {
      const r = await api('/api/bridge/install-blender', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      if (!r?.ok) { showToast('安装失败：' + (r?.error || '未知原因'), 'err'); return; }
      const list = (r.installed || []).map((x: any) => `Blender ${x.blender} → v${x.version}（${x.series} 系列）`);
      showToast(`已装到 ${list.length} 个 Blender：${list.join('；')}。到「偏好设置 → 插件」勾选一次即可`, 'ok');
      await loadBridge();
    } catch (e: any) {
      showToast('安装失败：' + String(e?.message || e), 'err');
    } finally { setBridgeBusy(false); }
  }

  /** UE 插件安装：走统一的「按工程勾选」弹窗（勾选=装、取消=卸），见 openPlugins('ue') */

  /** 一键装 SketchUp 插件：后端按各 SketchUp 版本挑对应系列，写进它的 Plugins 目录 */
  async function installSuPlugin() {
    setBridgeBusy(true);
    try {
      const r = await api('/api/bridge/install-su', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      if (!r?.ok) { showToast('安装失败：' + (r?.error || '未知原因'), 'err'); return; }
      const list = (r.installed || []).map((x: any) => `SketchUp ${x.sketchup} → v${x.version}（${x.series} 系列）`);
      showToast(`已装到 ${list.length} 个 SketchUp：${list.join('；')}。重启 SketchUp 生效`, 'ok');
      await loadBridge();
    } catch (e: any) {
      showToast('安装失败：' + String(e?.message || e), 'err');
    } finally { setBridgeBusy(false); }
  }

  /** 一键装 Maya 插件：写 .mod + scripts 到 %USERPROFILE%\Documents\maya\<年份>\modules */
  async function installMayaPlugin() {
    setBridgeBusy(true);
    try {
      const r = await api('/api/bridge/install-maya', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      if (!r?.ok) { showToast('安装失败：' + (r?.error || r?.failed?.[0]?.error || '未知原因'), 'err'); return; }
      const list = (r.installed || []).map((x: any) => `Maya ${x.maya} → v${x.version}（${x.series} 系列）`);
      showToast(`已装到 ${list.length} 个 Maya：${list.join('；')}。重启 Maya 生效`, 'ok');
      await loadBridge();
    } catch (e: any) {
      showToast('安装失败：' + String(e?.message || e), 'err');
    } finally { setBridgeBusy(false); }
  }

  async function clearBridgeJobs() {
    if (!window.confirm('清除最近任务记录？\n同时会删除队列产生的本地临时文件（拖放描述 .ms）。')) return;
    setBridgeBusy(true);
    try {
      const r = await api('/api/bridge/clear', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      if (!r?.ok) { showToast('清除失败：' + (r?.error || '未知原因'), 'err'); return; }
      showToast(`已清除 ${r.deleted} 条任务记录、${r.removedFiles} 个临时文件`, 'ok');
      await loadBridge();
    } catch (e: any) {
      showToast('清除失败：' + String(e?.message || e), 'err');
    } finally {
      setBridgeBusy(false);
    }
  }

  // ---- 统一插件安装/卸载（按 DCC 版本勾选；UE 按工程勾选） ----
  const [plugTargets, setPlugTargets] = useState<any[]>([]);
  const [plugBusy, setPlugBusy] = useState('');
  const [plugFilter, setPlugFilter] = useState<'' | 'max' | 'blender' | 'su' | 'maya' | 'ue'>('');
  const [plugPick, setPlugPick] = useState(false);       // 安装/卸载插件弹窗

  async function openPlugins(dccRaw?: any) {
    // 每个软件的按钮只看自己：弹窗只列这个 DCC 的版本（UE 只列工程）
    const dcc = (['max', 'blender', 'su', 'maya', 'ue'] as const).includes(dccRaw)
      ? dccRaw as 'max' | 'blender' | 'su' | 'maya' | 'ue' : 'max';
    setPlugPick(true);
    setPlugFilter(dcc);
    setPlugBusy('scan');
    try {
      const r = await api('/api/bridge/plugin-targets');
      const list = r?.targets || [];
      setPlugTargets(list);
      const mine = list.filter((t: any) => t.dcc === dcc);
      const name = ({ max: '3ds Max', blender: 'Blender', su: 'SketchUp', maya: 'Maya', ue: 'Unreal Engine' } as any)[dcc];
      if (!mine.length) showToast(dcc === 'ue'
        ? 'UE：没找到工程（先在 UE 里打开一次工程，或用「＋ 手动选择 .uproject…」）'
        : `${name}：没检测到可安装的版本（先启动一次该软件，让它生成用户配置目录）`, 'err');
      else showToast(`${name}：检测到 ${mine.length} 个${dcc === 'ue' ? '工程' : '版本'}` +
        (mine.some((t: any) => !t.installed) ? `（未安装 ${mine.filter((t: any) => !t.installed).length} 个）` : '') +
        (mine.some((t: any) => t.installed && !t.upToDate) ? '，其中 ' + mine.filter((t: any) => t.installed && !t.upToDate).length + ' 个需更新' : '') +
        '；勾选=安装，取消勾选=卸载', 'ok');
      setTimeout(() => {
        const el = document.querySelector('.plg-list');
        if (el && (el as any).scrollIntoView) (el as any).scrollIntoView({ block: 'nearest' });
      }, 120);
    } catch (e: any) {
      showToast('检测可安装版本失败：' + (e?.message || e), 'err');
    } finally { setPlugBusy(''); }
  }

  async function toggleTarget(t: any) {
    setPlugBusy(t.key);
    try {
      const r = await api('/api/bridge/plugin-target', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: t.key, install: !t.installed })
      });
      if (!r?.ok) showToast((t.installed ? '卸载失败：' : '安装失败：') + (r?.error || '未知原因'), 'err');
      else showToast(`${t.installed ? '已卸载' : '已安装'}：${t.label}${t.dcc === 'ue' ? '（重启 UE 编辑器生效）' : ''}`, 'ok');
      const r2 = await api('/api/bridge/plugin-targets');
      setPlugTargets(r2?.targets || []);
      await loadBridge();
    } finally { setPlugBusy(''); }
  }

  /** UE：手动挑 .uproject，记下来后它就出现在勾选列表里 */
  async function addUeProjectTargets() {
    const am = (window as any).amApi;
    if (!am?.pickFiles) { showToast('当前环境不支持文件选择（浏览器里打开时）', 'err'); return; }
    const files: string[] = await am.pickFiles([{ name: 'UE 工程', extensions: ['uproject'] }]) || [];
    if (!files.length) return;
    setPlugBusy('scan');
    try {
      const r = await api('/api/bridge/ue-add-project', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files })
      });
      if (!r?.ok) { showToast('加入列表失败：' + (r?.error || '未知原因'), 'err'); return; }
      setPlugTargets(r?.targets || []);
      showToast(`已加入 ${files.length} 个工程，勾选即安装`, 'ok');
    } catch (e: any) {
      showToast('加入列表失败：' + (e?.message || e), 'err');
    } finally { setPlugBusy(''); }
  }

  async function installMaxPlugin() {
    setBridgeBusy(true);
    try {
      const r = await api('/api/bridge/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!r?.ok) showToast('安装失败：' + (r?.error || '未知原因'), 'err');
      else showToast(`已安装到 ${r.installed.length} 个 3ds Max 配置，重启 Max 后生效`, 'ok');
      await loadBridge();
    } finally { setBridgeBusy(false); }
  }

  async function openMaxFolder(which: 'startup' | 'script' | 'copy') {
    const r = await api('/api/bridge/open-folder', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which })
    });
    if (!r?.ok) showToast(r?.error || '没有找到目录', 'err');
  }

  async function testBridge() {
    setBridgeBusy(true);
    try {
      const r = await api('/api/bridge/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (r?.connected) showToast(`3ds Max 已连接（${bridge?.targets?.max?.version ? 'Max ' + bridge.targets.max.version : '未知版本'}）`, 'ok');
      else if (bridgeInfo && !bridgeInfo.installed) showToast('未连接：插件还没安装到 3ds Max（点「安装到 3ds Max」）', 'err');
      else showToast('未连接：请启动 3ds Max，插件会随 Max 自动加载（约 5 秒内显示在线）', 'err');
      await loadBridge();
    } finally { setBridgeBusy(false); }
  }

  /** 预先准备好拖到 Max 的 .ms 描述文件（按下卡片时就开始，拖起来时已经有路径） */
  async function ensureDropFile(a: Asset) {
    const cache = dropFileCache.current;
    if (cache.has(a.id)) return cache.get(a.id)!;
    try {
      const r = await api('/api/bridge/dropfile', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: a.id })
      });
      if (r?.path) { cache.set(a.id, r.path); return r.path; }
    } catch { /* 服务端没起来就退回拖原文件 */ }
    return '';
  }

  /** 把素材拖出应用（拖到 3ds Max 视口 / 材质编辑器 / 资源管理器） */
  function startAssetDrag(a: Asset, e: any) {
    const am = (window as any).amApi;
    if (!am?.startDrag) return;              // 浏览器里没有原生拖拽，保持默认行为
    const rel = (a as any).drag_rel as string | null;
    if (!rel) return;
    const root = libs.find(l => l.id === a.library_id)?.root || '';
    if (!root) return;
    // Electron 官方模式：必须先掐掉 Chromium 自己的拖拽，否则会跟原生拖拽打架（Windows 上会让应用退出）
    e.preventDefault();
    const absPath = root + '\\' + String(rel).split('/').join('\\');
    const isImage = /\.(png|jpe?g|webp|bmp|tga|tiff?)$/i.test(rel);
    // 任何图片都直接拖真实文件（PS / 聊天框 / 浏览器上传区都能接）；模型仍走 .ms；按 Alt 强制 .ms
    if (isImage && a.type !== 'model' && !e.altKey) {
      const picks = selIds.includes(a.id) && selIds.length > 1 ? selIds : [a.id];
      const files = picks
        .map(id => (id === a.id ? a : assets.find(x => x.id === id)))
        .filter(Boolean)
        .map(x => String((x as any).drag_rel || ''))
        .filter(p => /\.(png|jpe?g|webp|bmp|tga|tiff?)$/i.test(p))
        .map(p => root + '\\' + p.split('/').join('\\'));
      am.startDrag({ files: files.length ? files : [absPath], assetId: a.id });
      return;
    }
    // 模型/材质：优先拖「描述文件」，Max 会执行 .ms（材质母版菜单 / 摆放 / 环境贴图）
    const script = dropFileCache.current.get(a.id) || '';
    try {
      const payload = JSON.stringify({ assetId: a.id, target: 'max' });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/bridge/dragging', new Blob([payload], { type: 'application/json' }));
      else fetch('/api/bridge/dragging', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    } catch { /* ignore */ }
    am.startDrag({ files: [script || absPath], assetId: a.id });
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
    const root = await askText('输入素材库根目录', 'F:\\02AssetLibrary\\Asset', true);
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
    const d = await api(`/api/asset/${sel.id}`).catch(() => ({ error: 'not found' }));
    if (!d || (d as any).error) { setSel(null); setSelIds([]); setFileSel(null); return; }
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
    const r = await api(`/api/issues?lib=${lib}${issuesOnly ? `&filter=1&${filterQs}` : ''}`);
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

  async function selectAssetById(id: number) {
    const d = await api(`/api/asset/${id}`);
    setSel(d);
    setSelIds([id]);
    setFileSel(null);
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

  function toggleTagSel(id: number) {
    setTagSel(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }

  // 资源管理器式选择：单击单选，Ctrl 切换，Shift 连选，空白处清空
  const tagLastRef = useRef<number | null>(null);
  function selectTagRow(id: number, e: React.MouseEvent, list: number[]) {
    if (e.shiftKey && tagLastRef.current != null) {
      const a = list.indexOf(tagLastRef.current);
      const b = list.indexOf(id);
      if (a >= 0 && b >= 0) {
        setTagSel(new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setTagSel(prev => {
        const s = new Set(prev);
        if (s.has(id)) s.delete(id); else s.add(id);
        return s;
      });
      tagLastRef.current = id;
      return;
    }
    setTagSel(new Set([id]));
    tagLastRef.current = id;
  }

  // Eagle 式右键标签操作
  async function tagRename(ids: number[]) {
    const t = tags.find(x => x.id === ids[0]);
    const v = await askText('重命名标签', t?.name || '');
    if (v?.trim()) await updateTag(ids[0], { name: v.trim() });
  }

  async function tagNew(parentId: number | null) {
    const v = await askText(parentId ? '新建二级标签' : '新建一级标签');
    if (!v?.trim()) return;
    await api('/api/tags', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: v.trim(), parentId })
    });
    if (lib) loadMeta(lib);
  }

  async function tagSetColor(ids: number[], color: string) {
    for (const id of ids) await updateTag(id, { color });
  }

  // 右键菜单点空白处关闭
  useEffect(() => {
    if (!tagMenu) return;
    const close = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('.ctxmenu')) setTagMenu(null);
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, [tagMenu]);

  async function tagDelete(ids: number[]) {
    if (!ids.length) return;
    if (!window.confirm(`删除选中的 ${ids.length} 个标签？只解除关联，不会删除素材。`)) return;
    for (const id of ids) await api(`/api/tags/${id}`, { method: 'DELETE' });
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

  // 拖标签到素材 / 批量添加
  async function assignTagTo(tagId: number, ids: number[]) {
    await api('/api/tags/assign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tagId, assetIds: ids })
    });
    if (lib) loadMeta(lib);
    if (sel && ids.includes(sel.id)) await refreshDetail();
    showToast(`已添加标签到 ${ids.length} 个素材`, 'ok');
  }

  // 详情页标签选择器（单选/多选一致）：默认一级，点箭头展开二级
  function tagTargetIds(): number[] {
    return selIds.length > 1 ? selIds : (sel ? [sel.id] : []);
  }

  async function refreshPickAssign() {
    const ids = tagTargetIds();
    if (!ids.length) { setPickAssign({ all: [], any: [] }); return; }
    try {
      const sets = await Promise.all(ids.map(async id => {
        const d = await api(`/api/asset/${id}`);
        return new Set<number>((d.tags || []).map((t: any) => t.id));
      }));
      const all = [...sets[0]].filter(id => sets.every(s => s.has(id)));
      const any = [...new Set(sets.flatMap(s => [...s]))];
      setPickAssign({ all, any });
    } catch {
      setPickAssign({ all: [], any: [] });
    }
  }

  async function openTagPicker() {
    await refreshPickAssign();
    setTagPickQ('');
    setTagPickParent(null);
    setTagPickOpen(true);
  }

  async function toggleTagOnTargets(tagId: number) {
    const ids = tagTargetIds();
    if (!ids.length) return;
    const remove = pickAssign.all.includes(tagId);
    await api('/api/tags/assign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tagId, assetIds: ids, action: remove ? 'remove' : 'add' })
    });
    if (lib) loadMeta(lib);
    if (sel) await refreshDetail();
    await refreshPickAssign();
    showToast(remove ? '已移除标签' : '已添加标签', 'ok');
  }

  async function checkUpdate() {
    setUpdateBusy(true);
    setUpdateStatus('检查中…');
    setUpdateInfo(null);
    try {
      const r = await api('/api/update/check');
      setUpdateInfo(r);
      setUpdateStatus(r.error ? '检查失败：' + r.error : r.newer ? `发现新版本 ${r.latest}` : `已是最新版本（${r.current}）`);
    } catch (e: any) {
      setUpdateStatus('检查失败：' + (e?.message || e));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function installUpdate() {
    const info = updateInfo;
    if (!info?.newer) return;
    const assets = (info.assets || []).filter((a: any) => /\.exe$/i.test(a.name));
    const pick = assets.find((a: any) => /portable/i.test(a.name)) || assets.find((a: any) => /setup/i.test(a.name)) || assets[0];
    if (!pick) { setUpdateStatus('该版本没有可用的安装包'); return; }
    setUpdateBusy(true);
    setUpdateStatus(`下载中…（${Math.round(pick.size / 1048576)} MB）`);
    try {
      const r = await api('/api/update/download', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: pick.id, name: pick.name, tag: info.tag })
      });
      if (!r.path) throw new Error(r.error || '下载失败');
      const wapi = (window as any).winApi;
      if (wapi?.applyUpdate) {
        setUpdateStatus('下载完成，正在安装并重启…');
        const res = await wapi.applyUpdate(r.path);
        if (!res?.ok) setUpdateStatus('安装失败：' + (res?.error || '未知错误'));
      } else {
        setUpdateStatus('已下载到：' + r.path);
      }
    } catch (e: any) {
      setUpdateStatus('更新失败：' + (e?.message || e));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function saveGhToken() {
    await api('/api/update/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ghTokenDraft.trim() })
    });
    setGhTokenDraft('');
    setUpdateStatus('令牌已保存（留空保存即清除）');
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
          <button className="iconbtn" title="材质组装器（选择文件夹，独立打开）" onClick={openStandaloneAssembler}>◍</button>
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

      <div className="body" style={{ gridTemplateColumns: `${sideOpen ? 260 : 48}px 1fr auto` }}>
        {!sideOpen && (
          <aside className="sidebar collapsed">
            <button className="iconbtn" title="展开侧栏" onClick={() => setSideOpen(true)}>›</button>
            <div className="side-mini" onClick={() => setSideOpen(true)}>{tab === 'dir' ? '目录' : '标签'}</div>
          </aside>
        )}
        <aside className="sidebar" style={sideOpen ? undefined : { display: 'none' }}>
          <div className="tabs">
            <button className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>目录</button>
            <button className={tab === 'tag' ? 'on' : ''} onClick={() => setTab('tag')}>标签</button>
            <span className="side-collapse" title="收起侧栏" onClick={() => setSideOpen(false)}>‹</span>
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
                  style={{ paddingLeft: 8 + t.depth * 14 }} onClick={(e) => selectTag(t.id, e)}
                  draggable
                  onDragStart={e => { e.dataTransfer.setData('application/x-am-tag', String(t.id)); e.dataTransfer.effectAllowed = 'copy'; }}>
                  <span className="tdot" style={{ background: t.color || '#8b93a1' }} />
                  <span className="label">{t.name}</span>
                  <span className="count">{t.count}</span>
                </div>
              ))}
              {tags.length === 0 && <div className="thint">还没有标签，选中素材后添加</div>}
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
                onClick={(e) => toggleType(t.key, e.altKey)}
                title="左键隐藏/显示该类型；Alt+左键只显示该类型；右键选择要隐藏的格式"
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
            <button ref={ratingBtnRef} className={'chip' + (ratingFilter ? ' on' : '')} onClick={openRatingPop}>
              评分 {ratingOp === 'gte' ? '≥' : ratingOp === 'lte' ? '≤' : '='}{ratingFilter || 0}{ratingInc ? '' : '（不含）'}
            </button>
            {ratingOpen && (
              <div className="rating-pop" style={{ left: ratingPos.x, top: ratingPos.y }}>
                <div className="rp-row">
                  <select className="sortsel" value={ratingOp} onChange={e => setRatingOp(e.target.value as any)}>
                    <option value="gte">大于（≥）</option>
                    <option value="lte">小于（≤）</option>
                    <option value="eq">等于（=）</option>
                  </select>
                  <label className="vp-check">
                    <input type="checkbox" checked={ratingInc} onChange={e => setRatingInc(e.target.checked)} />
                    包含当前星级
                  </label>
                </div>
                <div className="rp-row star-set">
                  {[1, 2, 3, 4, 5].map(v => (
                    <button key={v} className={ratingFilter >= v ? 'on' : ''}
                      onClick={() => { setRatingFilter(v); setRatingOpen(false); }}>{'★'}</button>
                  ))}
                  <span className="hint" style={{ marginLeft: 6 }}>{ratingFilter || 0} 星</span>
                </div>
                <div className="rp-row">
                  <button className="btn tiny" onClick={() => { setRatingFilter(0); setRatingOpen(false); }}>清除评分筛选</button>
                  <span style={{ flex: 1 }} />
                  <button className="btn tiny" onClick={() => setRatingOpen(false)}>关闭</button>
                </div>
              </div>
            )}
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
                <FileCard key={f.id} f={f} active={fileSel?.id === f.id} onOpen={() => openFile(f)}
                  onZoom={() => setZoom(isSpecialImage(f.rel_path)
                    ? { fileId: f.id, path: f.rel_path, scale: 1 }
                    : { src: `/api/file/${f.id}`, scale: 1 })}
                  onDragStart={(e) => {
                    const am = (window as any).amApi;
                    if (!am?.startDrag) return;
                    if (!/\.(png|jpe?g|webp|bmp|tga|tiff?)$/i.test(f.rel_path)) return;
                    e.preventDefault();
                    const root = libs.find(l => l.id === lib)?.root || '';
                    if (!root) return;
                    am.startDrag({ files: [root + '\\' + String(f.rel_path).split('/').join('\\')] });
                  }}
                  onCtx={(e) => { e.preventDefault(); setCtx({ kind: 'file', x: e.clientX, y: e.clientY, file: f }); }} />
              ))}
              {files.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>该目录没有文件</div>}
            </div>
          ) : issuesOnly ? (
            <div className="grid">
              {issueAssets.map(a => (
                <Card key={a.id} a={a} active={false}
                  issue={issueMap.get(a.id)}
                  active={selIds.includes(a.id)}
                  onSelect={() => void selectAssetById(a.id)} onOpen={() => openViewer(a)}
                  onCtx={(e) => { e.preventDefault(); setCtx({ kind: 'asset', x: e.clientX, y: e.clientY, asset: a }); }} />
              ))}
              {issueAssets.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>没有发现问题的素材</div>}
            </div>
          ) : loading ? <div className="empty">加载中…</div>
            : assets.length === 0 ? <div className="empty">当前条件下没有素材{!libs.length && <button className="btn primary" onClick={addLibrary}>添加素材库</button>}</div>
            : <div className="grid" ref={gridRef} onClick={e => { if (e.target === e.currentTarget) setSelIds([]); }}
                onDragOver={e => {
                  if (e.dataTransfer.types.includes('application/x-am-tag')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={async e => {
                  const tid = Number(e.dataTransfer.getData('application/x-am-tag'));
                  if (!tid) return;
                  e.preventDefault();
                  const el = (e.target as HTMLElement).closest('[data-asset]');
                  const aid = Number(el?.getAttribute('data-asset'));
                  if (aid) await assignTagTo(tid, [aid]);
                }}>
                {displayAssets.map(a => (
                  <Card key={a.id} a={a} active={selIds.includes(a.id)} thumbVer={thumbVer}
                    issue={issueMap.get(a.id)}
                    chips={chipsFor(a)}
                    onPick={openVariant}
                    onSelect={(e) => handleSelect(a, e)} onOpen={() => openViewer(a)}
                    onZoom={(src) => setZoom({ src, scale: 1 })}
                    onDrag={(e) => startAssetDrag(a, e)}
                    onPress={() => { ensureDropFile(a); }}
                    onCtx={(e) => { e.preventDefault(); setCtx({ kind: 'asset', x: e.clientX, y: e.clientY, asset: a }); }} />
                ))}
              </div>}
          {!issuesOnly && viewMode === 'assets' && rowsPerPage > 0 && total > rowsPerPage * cols && (
            <div className="pager">
              <button className="btn tiny" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>← 上一页</button>
              <span className="pinfo">
                第 <input className="numin" style={{ width: 52, height: 24, textAlign: 'center' }}
                  value={pageDraft}
                  onChange={e => setPageDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') jumpPage(); }}
                  onBlur={jumpPage} /> / {pageCount} 页 · 共 {total}
              </span>
              <button className="btn tiny" onClick={jumpPage}>跳转</button>
              <button className="btn tiny" disabled={page >= pageCount} onClick={() => setPage(p => p + 1)}>下一页 →</button>
            </div>
          )}
        </main>

        <aside className={'details' + (sel ? ' open' : '')} style={sel ? { width: detailW } : undefined}>
          {sel && (
            <div className="detail-resizer" title="拖动调整详情宽度，双击恢复默认"
              onPointerDown={startDetailResize} onDoubleClick={() => setDetailW(340)} />
          )}
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
                  <div className="detail-h">标签</div>
                  <button className="btn" onClick={openTagPicker}>＋ 标签（添加 / 移除）</button>
                  <div className="hint" style={{ marginTop: 6 }}>对选中的 {selIds.length} 个素材统一操作</div>
                </div>
                <div className="hint">Ctrl / Shift 点击可多选；双击打开预览。</div>
              </div>
            </>
          ) : sel ? <>
            <div className="dhead"><b>详情</b><button className="iconbtn" onClick={() => setSel(null)}>×</button></div>
            <div className="dbody">
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
                <button className="tagadd btn tiny" onClick={openTagPicker}>＋ 标签</button>
              </div>
              <div className="btnrow">
                {sel.type !== 'texture' && (
                  <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => openViewer(sel)}>
                    {sel.type === 'material' ? '打开材质组装器' : '打开 3D 预览'}
                  </button>
                )}
                {sendModeFor(sel) && (
                  <button className="btn" disabled={bridgeBusy} onClick={e => openSendMenuFromEvent(sel, e)}
                    title={onlineSummary()}>
                    → 发送到…
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
        <button className={'bridgechip' + (maxConnected ? ' on' : '')} onClick={() => setPluginsOpen(true)}
          title={maxConnected ? '3ds Max 已连接' : '3ds Max 未连接（点开插件面板）'}>
          <span className={'mxdot' + (maxConnected ? ' on' : '')} />3ds Max
        </button>
        <button className={'bridgechip' + (blenderConnected ? ' on' : '')} onClick={() => setPluginsOpen(true)}
          title={blenderConnected
            ? `Blender 已连接${bridge?.targets?.blender?.version ? ' · 插件 v' + bridge.targets.blender.version : ''}`
            : 'Blender 未连接（点开插件面板）'}>
          <span className={'mxdot' + (blenderConnected ? ' on' : '')} />Blender
        </button>
        <button className={'bridgechip' + (suConnected ? ' on' : '')} onClick={() => setPluginsOpen(true)}
          title={suConnected
            ? `SketchUp 已连接${bridge?.targets?.su?.version ? ' · 插件 v' + bridge.targets.su.version : ''}`
            : 'SketchUp 未连接（点开插件面板）'}>
          <span className={'mxdot' + (suConnected ? ' on' : '')} />SketchUp
        </button>
        <button className={'bridgechip' + (ueConnected ? ' on' : '')} onClick={() => setPluginsOpen(true)}
          title={ueConnected
            ? `Unreal Engine 已连接${bridge?.targets?.ue?.version ? ' · 插件 v' + bridge.targets.ue.version : ''}`
            : 'Unreal Engine 未连接（点开插件面板）'}>
          <span className={'mxdot' + (ueConnected ? ' on' : '')} />Unreal
        </button>
        <button className={'bridgechip' + (mayaConnected ? ' on' : '')} onClick={() => setPluginsOpen(true)}
          title={mayaConnected
            ? `Maya 已连接${bridge?.targets?.maya?.version ? ' · 插件 v' + bridge.targets.maya.version : ''}`
            : 'Maya 未连接（点开插件面板）'}>
          <span className={'mxdot' + (mayaConnected ? ' on' : '')} />Maya
        </button>
        <div className="status-right">
          <span className="cap">主题</span>
          {THEMES.map(t => (
            <button key={t} className={'sw-t ' + t + (theme === t ? ' on' : '')} onClick={() => setTheme(t)} title={t} />
          ))}
        </div>
      </footer>
      {viewer && <Viewer asset={viewer} onClose={() => setViewer(null)}
        variants={variantMap.get(viewer.id)?.items} onVariant={openVariant} />}
      {assembler && <Assembler asset={assembler} onClose={() => { setAssembler(null); setAssemblerFolder(''); }}
        folderPath={assemblerFolder || undefined} />}
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

      {sendMenu && (() => {
        const m = sendModeFor(sendMenu.asset);
        const mLabel = m === 'import' ? '导入模型' : m === 'material' ? '创建材质'
          : m === 'hdri' ? '应用 HDRI' : m === 'ies' ? '发送 IES' : '发送贴图';
        return (
          <>
            <div className="menu-mask" onMouseDown={() => setSendMenu(null)} />
            <div className="ctxmenu sendsel" style={{ left: sendMenu.x, top: sendMenu.y }}>
              <div className="send-h">发送到… · {mLabel}</div>
              {targetsFor(sendMenu.asset).map(t => {
                const st = bridge?.targets?.[t.key];
                const online = !!st?.connected;
                return (
                  <button key={t.key} disabled={bridgeBusy}
                    onClick={() => {
                      const a = sendMenu.asset;
                      setSendMenu(null);
                      if (sendModeFor(a) === 'hdri' && t.key === 'max') { setHdriAsk({ asset: a }); return; }
                      if (sendModeFor(a) === 'import' && t.key === 'ue') {
                        // 每次重新给默认值：只勾静态网格体
                        setUeImpStatic(true); setUeImpSkeletal(false); setUeImpPhysics(false); setUeImpPlace(false);
                        setUeImportAsk({ asset: a });
                        return;
                      }
                      if (sendModeFor(a) === 'material' && t.key === 'ue') {
                        // UE 端不在模态框里选父材质（点不了内容浏览器），改成发送前问一句
                        (async () => {
                          const last = localStorage.getItem('am-ue-parent-mat') || '';
                          const inp = await askText('发送材质到 Unreal：填父材质路径（如 /Game/Materials/M_Base）= 建材质实例；留空 = 独立材质', last, false);
                          if (inp === null) return;            // 取消发送
                          const parent = String(inp).trim();
                          if (parent) localStorage.setItem('am-ue-parent-mat', parent);
                          sendToTarget(a, 'ue', 'material', parent ? { options: { parentMaterial: parent } } : undefined);
                        })();
                        return;
                      }
                      sendToTarget(a, t.key);
                    }}
                    title={online
                      ? `${t.label} 已连接${st?.version ? `（插件 v${st.version}）` : ''}`
                      : `${t.label} 未检测到：任务会排队，软件启动后自动执行`}>
                    <span className="send-name">
                      <span className={'mxdot' + (online ? ' on' : '')} />
                      {t.label}
                    </span>
                    <span className={'send-sub' + (online ? ' on' : '')}>
                      {online ? `已连接${st?.version ? ` · v${st.version}` : ''}` : '未检测到'}
                    </span>
                  </button>
                );
              })}
              <div className="ctx-sep" />
              <div className="send-h">未连接的软件也能发：任务先排队，软件启动后自动执行</div>
            </div>
          </>
        );
      })()}

      {ctx && (
        <>
          <div className="menu-mask" onMouseDown={() => setCtx(null)}
            onContextMenu={e => { e.preventDefault(); setCtx(null); }} />
          <div ref={ctxRef} className="ctxmenu" data-want-top={ctx.y} style={{
            left: Math.min(ctx.x, window.innerWidth - 230),
            top: ctx.y
          }}>
            {ctx.kind === 'asset' ? (<>
              <button onClick={() => { setCtx(null); refreshLibrary(); }}>刷新</button>
              <button onClick={() => { setCtx(null); locateAsset(ctx.asset); }}>定位到文件夹</button>
              <button onClick={() => { setCtx(null); openViewer(ctx.asset); }}>打开预览</button>
              {sendModeFor(ctx.asset) && (
                <button onClick={() => { const a = ctx.asset; setCtx(null); openSendMenu(a, { x: ctx.x, y: ctx.y }); }} disabled={bridgeBusy}>
                  发送到…（3ds Max / Blender / SketchUp / Unreal）
                </button>
              )}
              <button onClick={() => { setCtx(null); reveal(ctx.asset); }}>在资源管理器中显示</button>
              <button onClick={() => { setCtx(null); copyText(assetFullPath(ctx.asset)); }}>复制路径</button>
              <div className="ctx-sep" />
              <button onClick={() => { setCtx(null); patch(ctx.asset, { favorite: ctx.asset.favorite ? 0 : 1 }); }}>
                {ctx.asset.favorite ? '取消收藏' : '收藏'}
              </button>
              <button onClick={() => { setCtx(null); patch(ctx.asset, { rating: 0 }); }}>清除评分</button>
              <div className="ctx-sep" />
              <button onClick={() => {
                const ids = selIds.includes(ctx.asset.id) && selIds.length > 1 ? selIds : [ctx.asset.id];
                setCtx(null); rematchPreviews(ids);
              }}>重新匹配预览图{selIds.includes(ctx.asset.id) && selIds.length > 1 ? `（选中 ${selIds.length} 个）` : ''}</button>
              <button onClick={() => {
                const ids = selIds.includes(ctx.asset.id) && selIds.length > 1 ? selIds : [ctx.asset.id];
                setCtx(null); renderPreviews(ids);
              }}>重新渲染预览图{selIds.includes(ctx.asset.id) && selIds.length > 1 ? `（选中 ${selIds.length} 个）` : ''}</button>
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
              <button onClick={() => { setCtx(null); refreshLibrary(); }}>刷新</button>
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
              <div className={'maxcard' + (maxConnected ? ' on' : '')}>
                <div className="mxhead">
                  <span className="mxname">3ds Max</span>
                  <span className={'mxdot' + (maxConnected ? ' on' : '')} />
                  <span className={maxConnected ? 'plug-on' : 'plug-off'}>{maxConnected ? '已连接' : '未连接'}</span>
                  {!!bridge?.targets?.max?.version && <span className="mxver">Max {bridge.targets.max.version}</span>}
                  <span className="mxver">插件 v{bridge?.scriptVersion || bridgeInfo?.scriptVersion || '—'}</span>
                </div>
                <div className="mxmeta">
                  服务端口 {bridge?.port || '—'} · 队列 {bridge?.targets?.max?.queued ?? 0}
                  {' · '}运行 {bridge?.targets?.max?.running ?? 0}
                  {bridgeInfo?.installed
                    ? ` · 已安装到 ${bridgeInfo.installedAt?.length || 0} 个 Max 配置`
                    : ' · 插件未安装'}
                </div>
                {bridge?.targets?.max?.lastJob && (
                  <div className="mxmeta mxlast" title={`${bridge.targets.max.lastJob.title} — ${bridge.targets.max.lastJob.message || ''}`}>
                    最近任务：{bridge.targets.max.lastJob.status === 'done' ? '✔' : bridge.targets.max.lastJob.status === 'failed' ? '✘' : '…'}
                    {' '}{bridge.targets.max.lastJob.title}
                    {bridge.targets.max.lastJob.message ? ` — ${bridge.targets.max.lastJob.message}` : ''}
                  </div>
                )}
                <div className="uvrow" style={{ marginTop: 8 }}>
                  <button className="btn primary" disabled={bridgeBusy} onClick={() => openPlugins('max')}>安装 / 卸载插件（3ds Max）</button>
                  <button className="btn" onClick={() => openMaxFolder('startup')}>打开 startup 目录</button>
                  <button className="btn" onClick={() => openMaxFolder('copy')} title="复制插件文件到数据目录并打开，便于手动安装">打开插件文件夹</button>
                  <button className="btn" disabled={bridgeBusy} onClick={testBridge}>测试连接</button>
                </div>
                {!maxConnected && (
                  <div className="hint">
                    安装后需要重启 3ds Max；插件随 Max 启动自动轮询，5 秒内这里会显示「已连接」。
                    右键素材可以发送；也可以直接把素材卡片拖进 Max 视口。
                  </div>
                )}
                {maxConnected && (
                  <div className="hint">
                    拖模型进 Max 视口=选择摆放位置后导入；拖材质进视口=选母版并重建到精简材质编辑器。打包在 Max 侧工具栏操作。
                  </div>
                )}
              </div>
              <div className={'maxcard' + (blenderConnected ? ' on' : '')}>
                <div className="mxhead">
                  <span className="mxname">Blender</span>
                  <span className={'mxdot' + (blenderConnected ? ' on' : '')} />
                  <span className={blenderConnected ? 'plug-on' : 'plug-off'}>{blenderConnected ? '已连接' : '未连接'}</span>
                  {!!blenderTarget?.version && <span className="mxver">插件 v{blenderTarget.version}</span>}
                </div>
                <div className="mxmeta">
                  队列 {blenderTarget?.queued ?? 0} · 运行 {blenderTarget?.running ?? 0}
                  {blenderTarget?.lastSeen ? ` · 最近心跳 ${new Date(blenderTarget.lastSeen).toLocaleTimeString()}` : ''}
                </div>
                {blenderTarget?.lastJob && (
                  <div className="mxmeta mxlast" title={`${blenderTarget.lastJob.title} — ${blenderTarget.lastJob.message || ''}`}>
                    最近任务：{blenderTarget.lastJob.status === 'done' ? '✔' : blenderTarget.lastJob.status === 'failed' ? '✘' : '…'}
                    {' '}{blenderTarget.lastJob.title}
                    {blenderTarget.lastJob.message ? ` — ${blenderTarget.lastJob.message}` : ''}
                  </div>
                )}
                <div className="uvrow" style={{ marginTop: 8 }}>
                  <button className="btn primary" disabled={bridgeBusy} onClick={() => openPlugins('blender')}>
                    安装/更新插件到 Blender
                  </button>
                  <button className="btn" onClick={async () => {
                    const r = await api('/api/bridge/open-folder', {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ which: 'blender' })
                    });
                    if (!r?.ok) showToast(r?.error || '打开失败', 'err');
                  }}>打开 Blender 插件文件夹</button>
                </div>
                <div className="hint">
                  插件按 Blender 版本分目录：Blender 5.2+ 用 <b>5.2/</b>，4.x 用 <b>4.0/</b>，3.3–3.6 LTS 用 <b>3.6/</b>，
                  文件名都是 assetmanager_blender.py；插件版本号独立于软件版本（见上方「插件 v…」）。
                  「安装/更新插件到 Blender」会按各 Blender 版本自动挑对应系列写进它的用户插件目录，
                  装完到 偏好设置 → 插件 里勾选一次即可。
                </div>
              </div>
              <div className={'maxcard' + (suConnected ? ' on' : '')}>
                <div className="mxhead">
                  <span className="mxname">SketchUp</span>
                  <span className={'mxdot' + (suConnected ? ' on' : '')} />
                  <span className={suConnected ? 'plug-on' : 'plug-off'}>{suConnected ? '已连接' : '未连接'}</span>
                  {!!suTarget?.version && <span className="mxver">插件 v{suTarget.version}</span>}
                </div>
                <div className="mxmeta">
                  队列 {suTarget?.queued ?? 0} · 运行 {suTarget?.running ?? 0}
                  {suTarget?.lastSeen ? ` · 最近心跳 ${new Date(suTarget.lastSeen).toLocaleTimeString()}` : ''}
                </div>
                {suTarget?.lastJob && (
                  <div className="mxmeta mxlast" title={`${suTarget.lastJob.title} — ${suTarget.lastJob.message || ''}`}>
                    最近任务：{suTarget.lastJob.status === 'done' ? '✔' : suTarget.lastJob.status === 'failed' ? '✘' : '…'}
                    {' '}{suTarget.lastJob.title}
                    {suTarget.lastJob.message ? ` — ${suTarget.lastJob.message}` : ''}
                  </div>
                )}
                <div className="uvrow" style={{ marginTop: 8 }}>
                  <button className="btn primary" disabled={bridgeBusy} onClick={() => openPlugins('su')}>
                    安装/更新插件到 SketchUp
                  </button>
                  <button className="btn" onClick={async () => {
                    const r = await api('/api/bridge/open-folder', {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ which: 'su' })
                    });
                    if (!r?.ok) showToast(r?.error || '打开失败', 'err');
                  }}>打开 SketchUp 插件文件夹</button>
                </div>
                <div className="hint">
                  插件按 SketchUp 版本分目录：SketchUp 2026 用 <b>2026/</b>（assetmanager_su.rb + assetmanager_su/main.rb）。
                  「安装/更新插件到 SketchUp」会按各版本自动挑系列写进它的 Plugins 目录，<b>重启 SketchUp 生效</b>，
                  之后在 扩展程序 → AssetManager 打开状态面板。
                  模型导入支持 SketchUp 自带格式（SKP/DAE/GLB/STL/3DS/DWG/IFC…）；
                  <b>FBX/OBJ/PLY 会先由软件临时导出成 GLB 再发</b>（素材文件不改，临时文件在数据目录 converted\，
                  清除任务记录时一并删除）。
                </div>
              </div>
              <div className={'maxcard' + (ueConnected ? ' on' : '')}>
                <div className="mxhead">
                  <span className="mxname">Unreal Engine</span>
                  <span className={'mxdot' + (ueConnected ? ' on' : '')} />
                  <span className={ueConnected ? 'plug-on' : 'plug-off'}>{ueConnected ? '已连接' : '未连接'}</span>
                  {!!ueTarget?.version && <span className="mxver">插件 v{ueTarget.version}</span>}
                </div>
                <div className="mxmeta">
                  队列 {ueTarget?.queued ?? 0} · 运行 {ueTarget?.running ?? 0}
                  {ueTarget?.lastSeen ? ` · 最近心跳 ${new Date(ueTarget.lastSeen).toLocaleTimeString()}` : ''}
                </div>
                {ueTarget?.lastJob && (
                  <div className="mxmeta mxlast" title={`${ueTarget.lastJob.title} — ${ueTarget.lastJob.message || ''}`}>
                    最近任务：{ueTarget.lastJob.status === 'done' ? '✔' : ueTarget.lastJob.status === 'failed' ? '✘' : '…'}
                    {' '}{ueTarget.lastJob.title}
                    {ueTarget.lastJob.message ? ` — ${ueTarget.lastJob.message}` : ''}
                  </div>
                )}
                <div className="uvrow" style={{ marginTop: 8 }}>
                  <button className="btn primary" disabled={bridgeBusy} onClick={() => openPlugins('ue')}>
                    安装 / 卸载插件（UE 工程）
                  </button>
                  <button className="btn" onClick={async () => {
                    const r = await api('/api/bridge/open-folder', {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ which: 'ue' })
                    });
                    if (!r?.ok) showToast(r?.error || '打开失败', 'err');
                  }}>打开 UE 插件文件夹</button>
                </div>
                <div className="hint">
                  插件是纯 Python 编辑器插件（<b>bridge/ue/5.7/AssetManagerBridge</b>），不用编译。
                  点「安装 / 卸载插件（UE 工程）」后按工程<b>勾选=装、取消勾选=卸</b>（工程不在列表里就手动选 .uproject）：
                  写进工程 <b>Plugins\AssetManagerBridge</b> 并在 .uproject 里启用它和 PythonScriptPlugin，
                  <b>重启 UE 编辑器生效</b>。装好后菜单 <b>工具 → AssetManager</b> 看连接状态。
                  支持：模型导入（FBX/GLB/OBJ…）、PBR 材质重建、贴图、HDRI（天空球 + SkyLight 反射）、
                  <b>IES 配光文件</b>（UE 原生 TextureLightProfile，直接生成带配光曲线的灯光）。
                </div>
              </div>
              <div className={'maxcard' + (mayaConnected ? ' on' : '')}>
                <div className="mxhead">
                  <span className="mxname">Maya</span>
                  <span className={'mxdot' + (mayaConnected ? ' on' : '')} />
                  <span className={mayaConnected ? 'plug-on' : 'plug-off'}>{mayaConnected ? '已连接' : '未连接'}</span>
                  {!!mayaTarget?.version && <span className="mxver">插件 v{mayaTarget.version}</span>}
                </div>
                <div className="mxmeta">
                  队列 {mayaTarget?.queued ?? 0} · 运行 {mayaTarget?.running ?? 0}
                  {mayaTarget?.lastSeen ? ` · 最近心跳 ${new Date(mayaTarget.lastSeen).toLocaleTimeString()}` : ''}
                </div>
                {mayaTarget?.lastJob && (
                  <div className="mxmeta mxlast" title={`${mayaTarget.lastJob.title} — ${mayaTarget.lastJob.message || ''}`}>
                    最近任务：{mayaTarget.lastJob.status === 'done' ? '✔' : mayaTarget.lastJob.status === 'failed' ? '✘' : '…'}
                    {' '}{mayaTarget.lastJob.title}
                    {mayaTarget.lastJob.message ? ` — ${mayaTarget.lastJob.message}` : ''}
                  </div>
                )}
                <div className="uvrow" style={{ marginTop: 8 }}>
                  <button className="btn primary" disabled={bridgeBusy} onClick={() => openPlugins('maya')}>
                    安装/更新插件到 Maya
                  </button>
                  <button className="btn" onClick={async () => {
                    const r = await api('/api/bridge/open-folder', {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ which: 'maya' })
                    });
                    if (!r?.ok) showToast(r?.error || '打开失败', 'err');
                  }}>打开 Maya 插件文件夹</button>
                </div>
                <div className="hint">
                  插件按 Maya 年份分目录（<b>bridge/maya/2025/</b>：AssetManagerBridge.mod + scripts/），纯 Python，不用编译。
                  「安装/更新插件到 Maya」写进 <b>Documents\maya\&lt;年份&gt;\modules</b>（只动用户目录，不碰 Maya 安装目录、不改 Maya.env），
                  <b>重启 Maya 生效</b>，之后主菜单栏出现 <b>AssetManager</b>。
                  支持：模型导入（FBX/OBJ/MA/MB/ABC/USD）、PBR 材质重建（<b>standardSurface</b>，不依赖 Arnold 也能用）、
                  贴图、HDRI（装了 Arnold 走天空穹灯，否则退化成环境球）、<b>IES</b>（Arnold aiPhotometricLight）。
                </div>
              </div>
              {['Houdini'].map(n => (
                <div className="plug-row" key={n}>
                  <span className="plug-name">{n}</span>
                  <span className="plug-desc">素材直接发送 / 一键替换</span>
                  <span className="plug-off">未开放</span>
                </div>
              ))}
            </div>
            {bridgeJobs.length > 0 && (
              <div className="plug-sec">
                <div className="plug-h" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>最近任务</span>
                  <button className="btn tiny" disabled={bridgeBusy} onClick={clearBridgeJobs}
                    title="清除最近任务记录，并删除队列临时文件">清除</button>
                </div>
                <div className="mxjobs">
                  {bridgeJobs.map(j => (
                    <div className="mxjob" key={j.id}>
                      <span className={'mxst ' + j.status}>{j.status === 'done' ? '✔' : j.status === 'failed' ? '✘' : '…'}</span>
                      <span className="mxtitle" title={j.message || ''}>
                        {j.target === 'blender' ? 'Blender · ' : j.target === 'su' ? 'SketchUp · ' : j.target === 'ue' ? 'Unreal · ' : j.target === 'maya' ? 'Maya · ' : ''}{j.title}
                      </span>
                      <span className="mxmsg" title={j.message || ''}>{j.message || (j.status === 'pending' ? '排队中' : j.status)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="hint">插件来源：应用目录下的 bridge/max/&lt;3ds Max 版本&gt;/AssetManagerBridge.ms（安装时按各 Max 版本挑对应系列，复制到 scripts\startup）；Blender 插件在 bridge/blender/&lt;Blender 版本&gt;/ 下；SketchUp 插件在 bridge/su/&lt;SketchUp 版本&gt;/ 下；UE 插件在 bridge/ue/&lt;引擎版本&gt;/AssetManagerBridge/ 下（装进工程的 Plugins）；Maya 插件在 bridge/maya/&lt;Maya 年份&gt;/ 下（装进 Documents\maya\&lt;年份&gt;\modules）。</div>
            <div className="modal-b">
              <button className="btn" onClick={() => setPluginsOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {plugPick && (
        <div className="modal-mask" onMouseDown={() => setPlugPick(false)}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">
              安装 / 卸载插件 · {({ max: '3ds Max', blender: 'Blender', su: 'SketchUp', maya: 'Maya', ue: 'Unreal Engine' } as any)[plugFilter || 'max']}
              <span className="hint" style={{ marginLeft: 8, fontWeight: 400 }}>
                勾选=安装，取消勾选=卸载；装完需重启该软件
              </span>
            </div>
            <div className="plg-list">
              {plugBusy === 'scan' && <div className="hint">正在检测可安装的{plugFilter === 'ue' ? '工程' : '版本'}…</div>}
              {plugBusy !== 'scan' && plugTargets.filter((t: any) => t.dcc === plugFilter).length === 0 && (
                <div className="hint">
                  {plugFilter === 'ue'
                    ? '没找到 UE 工程（先在 UE 里打开一次工程，或点下面的「＋ 手动选择 .uproject…」）'
                    : '没有检测到这个软件的可用版本（先启动一次该软件，让它生成用户配置目录）'}
                </div>
              )}
              {[plugFilter].filter(Boolean).map(dcc => {
                const rows = plugTargets.filter((t: any) => t.dcc === dcc);
                if (!rows.length) return null;
                const title = ({ max: '3ds Max', blender: 'Blender', su: 'SketchUp', maya: 'Maya', ue: 'Unreal Engine' } as any)[dcc as string];
                return (
                  <div className="plg-grp" key={dcc}>
                    <div className="plg-grp-t">{title}（{rows.length} 个{String(dcc) === 'ue' ? '工程' : '版本'}）</div>
                    {rows.map((t: any) => (
                      <label className={'plg-row' + (t.installed ? ' on' : '')} key={t.key} title={t.dir}>
                        <input type="checkbox" checked={!!t.installed}
                          disabled={plugBusy === t.key || (!t.series && (t.dcc === 'max' || t.dcc === 'ue'))}
                          onChange={() => toggleTarget(t)} />
                        <span className="plg-name">{t.label}</span>
                        <span className="plg-meta">
                          {t.dcc === 'max' || t.dcc === 'ue'
                            ? (t.series ? `将安装：系列 ${t.series} · v${t.pluginVersion}` : '没有适用于该版本的插件系列')
                            : (t.series ? `系列 ${t.series}` : '无可用系列')}
                          {t.dcc !== 'max' && t.dcc !== 'ue' && t.pluginVersion ? ` · v${t.pluginVersion}` : ''}
                          {t.installed ? (t.upToDate ? ' · 已安装' : ' · 需更新') : ((t.dcc === 'max' || t.dcc === 'ue') && !t.series ? '' : ' · 未安装')}
                        </span>
                      </label>
                    ))}
                    {String(dcc) === 'ue' && (
                      <div className="uvrow" style={{ marginTop: 6 }}>
                        <button className="btn" disabled={plugBusy === 'scan'} onClick={addUeProjectTargets}>
                          ＋ 手动选择 .uproject…
                        </button>
                        <span className="hint">装进 工程\Plugins\AssetManagerBridge，并在 .uproject 里启用它和 PythonScriptPlugin</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setPlugPick(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onMouseDown={() => setSettingsOpen(false)}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">设置 · 素材库</div>
            <div className="uvrow" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="hint">素材库目录（顺序影响侧栏）</span>
              <button className="btn primary" onClick={addLibrary}>＋ 添加素材库</button>
            </div>
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
            <div className="hint">材质组装器基本体</div>
            <div className="uvrow">
              <button className="btn" onClick={async () => {
                const r = await api('/api/bridge/open-folder', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ which: 'geometry' })
                });
                if (!r?.ok) showToast(r?.error || '打开失败', 'err');
              }}>打开基本体文件夹</button>
              <span className="hint">放入 sphere / box / cylinder / plane 命名的 .glb/.gltf/.obj/.fbx 可替换默认基本体；放好后切回软件会自动重载（也可点组装器里的 ↻）</span>
            </div>
            <div className="hint">工作区（软件产生的文件都放这里）</div>
            <div className="uvrow">
              <span className="hint" style={{ flex: 1, fontSize: 11, wordBreak: 'break-all' }}>
                {wsInfo?.isSet ? wsInfo.path : '未设置（暂用数据目录）'}
              </span>
              <button className="btn" onClick={chooseWorkspace}>选择 / 更改…</button>
            </div>
            <div className="hint">MCP（AI 客户端接入）</div>
            {mcpInfo ? (
              <>
                <div className="uvrow">
                  <label className="vp-check" onClick={() => setMcp({ enabled: !mcpInfo.enabled })}>
                    <span className={'box' + (mcpInfo.enabled ? ' on' : '')}>{mcpInfo.enabled ? '✓' : ''}</span>启用 MCP
                  </label>
                  <label className="vp-check" onClick={() => setMcp({ allowWrite: !mcpInfo.allowWrite })}>
                    <span className={'box' + (mcpInfo.allowWrite ? ' on' : '')}>{mcpInfo.allowWrite ? '✓' : ''}</span>允许 AI 修改
                  </label>
                </div>
                <div className="hint" style={{ fontSize: 11 }}>
                  HTTP：{mcpInfo.url}　stdio：{mcpInfo.stdio}
                </div>
                <div className="uvrow">
                  <button className="btn" onClick={() => copyText(JSON.stringify({ mcpServers: { assetmanager: { command: 'node', args: [mcpInfo.stdio] } } }, null, 2))}>复制 Claude 配置</button>
                  <button className="btn" onClick={() => copyText(JSON.stringify({ mcpServers: { assetmanager: { url: mcpInfo.url } } }, null, 2))}>复制 Cursor 配置</button>
                </div>
              </>
            ) : <div className="hint">读取 MCP 状态…</div>}
            <div className="hint">关闭按钮行为</div>
            <div className="uvrow">
              <select className="sortsel" value={closeAction}
                onChange={e => changeCloseAction(e.target.value as 'ask' | 'tray' | 'quit')}
                disabled={!(window as any).amApi?.setCloseAction}>
                <option value="ask">每次询问</option>
                <option value="tray">最小化到托盘（后台运行）</option>
                <option value="quit">直接关闭</option>
              </select>
              <span className="hint">托盘后台运行会暂停渲染与扫描，占用更低</span>
            </div>
            <div className="hint">版本与更新</div>
            <div className="uvrow">
              <button className="btn" onClick={checkUpdate} disabled={updateBusy}>
                {updateBusy ? '处理中…' : '检查更新'}
              </button>
              <span className="hint" style={{ flex: 1 }}>
                {updateStatus || (updateInfo ? `当前 ${updateInfo.current}` : '从 GitHub Releases 检查新版本')}
              </span>
            </div>
            {updateInfo?.newer && (
              <div className="updbox">
                <div className="updhead">新版本 {updateInfo.latest}</div>
                {updateInfo.notes && (
                  <pre className="updnotes">{String(updateInfo.notes).split('\n').slice(0, 12).join('\n')}</pre>
                )}
                <button className="btn primary" onClick={installUpdate} disabled={updateBusy}>下载并安装</button>
              </div>
            )}
            <div className="uvrow">
              <input className="modal-input" style={{ flex: 1 }} type="password"
                placeholder="GitHub 令牌（仅私有仓库需要，公开仓库留空）"
                value={ghTokenDraft} onChange={e => setGhTokenDraft(e.target.value)} />
              <button className="btn tiny" onClick={saveGhToken}>保存令牌</button>
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
            </div>
          </div>
        </div>
      )}

      {tagPickOpen && sel && (
        <div className="modal-mask" onMouseDown={() => setTagPickOpen(false)}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">标签 · {tagTargetIds().length > 1 ? `已选 ${tagTargetIds().length} 项` : sel.name}</div>
            <input className="modal-input" autoFocus placeholder="搜索标签；回车匹配或新建"
              value={tagPickQ} onChange={e => setTagPickQ(e.target.value)}
              onKeyDown={async e => {
                if (e.key !== 'Enter') return;
                const q = tagPickQ.trim();
                if (!q) return;
                const hit = tags.find(t => t.name.toLowerCase() === q.toLowerCase());
                if (hit) { await toggleTagOnTargets(hit.id); setTagPickQ(''); return; }
                const t = await api('/api/tags', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name: q })
                });
                if (t?.id) {
                  const ids = tagTargetIds();
                  await api('/api/tags/assign', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ tagId: t.id, assetIds: ids })
                  });
                  if (lib) loadMeta(lib);
                  if (sel) await refreshDetail();
                  await refreshPickAssign();
                }
                setTagPickQ('');
              }} />
            <div className="tagpick-list">
              {tagPickQ.trim() ? (
                tags.filter(t => t.name.toLowerCase().includes(tagPickQ.trim().toLowerCase())).map(t => {
                  const has = pickAssign.all.includes(t.id);
                  const some = pickAssign.any.includes(t.id);
                  return (
                    <div key={t.id} className={'row' + (has ? ' on' : '')} onClick={() => toggleTagOnTargets(t.id)}>
                      <span className="tdot" style={{ background: t.color || '#8b93a1' }} />
                      <span className="label">{'— '.repeat(t.depth)}{t.name}</span>
                      <span className="count">{has ? '已添加' : some ? '部分' : ''}</span>
                    </div>
                  );
                })
              ) : (
                primaries.map(p => (
                  <div key={p.id}>
                    <div className={'row' + (pickAssign.all.includes(p.id) ? ' on' : '')}>
                      <span className="tdot" style={{ background: p.color || '#8b93a1' }} />
                      <span className="label" style={{ flex: 1, cursor: 'pointer' }}
                        onClick={() => toggleTagOnTargets(p.id)}>{p.name}</span>
                      <span className="count">{pickAssign.all.includes(p.id) ? '已添加' : pickAssign.any.includes(p.id) ? '部分' : ''}</span>
                      <button className="btn tiny"
                        onClick={e => { e.stopPropagation(); setTagPickParent(tagPickParent === p.id ? null : p.id); }}>
                        {tagPickParent === p.id ? '▾' : '▸'}
                      </button>
                    </div>
                    {tagPickParent === p.id && tags.filter(t => (t as any).parentId === p.id).map(t => (
                      <div key={t.id} className={'row' + (pickAssign.all.includes(t.id) ? ' on' : '')}
                        style={{ paddingLeft: 26 }} onClick={() => toggleTagOnTargets(t.id)}>
                        <span className="tdot" style={{ background: t.color || '#8b93a1' }} />
                        <span className="label">{t.name}</span>
                        <span className="count">{pickAssign.all.includes(t.id) ? '已添加' : pickAssign.any.includes(t.id) ? '部分' : ''}</span>
                      </div>
                    ))}
                  </div>
                ))
              )}
              {tags.length === 0 && <div className="hint" style={{ padding: 8 }}>还没有标签，输入名称回车新建</div>}
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setTagPickOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {tagMgrOpen && (
        <div className="modal-mask" onMouseDown={() => setTagMgrOpen(false)}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">标签管理 · {tags.length} 个</div>
            <div className="tagmgr-body">
              <div className="tagmgr-left"
                onClick={e => { if (e.target === e.currentTarget) { setTagSel(new Set()); tagLastRef.current = null; } }}
                onContextMenu={e => {
                  e.preventDefault();
                  setTagMenu({ x: e.clientX, y: e.clientY, ids: [], kind: 'empty-primary' });
                }}>
                <div className={'tgm-item' + (selParent === 'none' ? ' on' : '')} onClick={() => setMgrParent('none')}>
                  <span className="label">未分类</span><span className="count">{unclassified.length}</span>
                </div>
                {primaries.map(p => (
                  <div key={p.id}
                    className={'tgm-item' + (tagSel.has(p.id) ? ' on' : '')}
                    onClick={e => { setMgrParent(p.id); selectTagRow(p.id, e, primaries.map(x => x.id)); }}
                    onContextMenu={e => {
                      e.stopPropagation();
                      e.preventDefault();
                      const ids = tagSel.has(p.id) ? [...tagSel] : [p.id];
                      setTagSel(new Set(ids));
                      setTagMenu({ x: e.clientX, y: e.clientY, ids, kind: 'primary' });
                    }}>
                    <span className="tdot" style={{ background: p.color || '#8b93a1' }} />
                    <span className="label">{p.name}</span>
                    <span className="count">{p.count}</span>
                  </div>
                ))}
                <div className="hint" style={{ padding: 8 }}>右键空白处新建一级标签</div>
              </div>
              <div className="tagmgr-right">
                <div className="tagbar">
                  <span className="hint">已选 {tagSel.size}</span>
                  <span style={{ flex: 1 }} />
                  <span className="hint">右键标签编辑，右键空白处新建二级标签</span>
                </div>
                <div className="taglist-wrap"
                  onClick={e => { if (e.target === e.currentTarget) { setTagSel(new Set()); tagLastRef.current = null; } }}
                  onContextMenu={e => {
                    e.preventDefault();
                    setTagMenu({ x: e.clientX, y: e.clientY, ids: [], kind: 'empty-secondary' });
                  }}>
                  <div className="tagchips">
                    {secondaries.map(t => (
                      <button key={t.id}
                        className={'tagchip' + (tagSel.has(t.id) ? ' on' : '')}
                        onClick={e => selectTagRow(t.id, e, secondaries.map(x => x.id))}
                        onContextMenu={e => {
                          e.stopPropagation();
                          e.preventDefault();
                          const ids = tagSel.has(t.id) ? [...tagSel] : [t.id];
                          setTagSel(new Set(ids));
                          setTagMenu({ x: e.clientX, y: e.clientY, ids, kind: 'secondary' });
                        }}>
                        <span>{t.name}</span><i>{t.count}</i>
                      </button>
                    ))}
                    {secondaries.length === 0 && <div className="hint">该分类下没有二级标签（右键新建）</div>}
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setTagMgrOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {tagMenu && (
        <div ref={tagMenuRef} className="ctxmenu" data-want-top={tagMenu.y} style={{
          left: Math.min(tagMenu.x, window.innerWidth - 230),
          top: tagMenu.y
        }}>
          {tagMenu.ids.length === 0 ? (
            <button onClick={() => {
              setTagMenu(null);
              tagNew(tagMenu.kind === 'empty-secondary'
                ? (selParent !== 'none' ? Number(selParent) : null)
                : null);
            }}>{tagMenu.kind === 'empty-secondary' ? '新建二级标签…' : '新建一级标签…'}</button>
          ) : (<>
            {tagMenu.ids.length === 1 && (
              <button onClick={() => { const ids = tagMenu.ids; setTagMenu(null); tagRename(ids); }}>重命名…</button>
            )}
            {tagMenu.ids.length === 1 && tagMenu.kind === 'primary' && (
              <button onClick={() => { const id = tagMenu.ids[0]; setTagMenu(null); tagNew(id); }}>新建子标签…</button>
            )}
            <div className="ctx-sep" />
            <button onClick={() => { const ids = tagMenu.ids; setTagMenu(null); tagDelete(ids); }}>
              删除{tagMenu.ids.length > 1 ? ` ${tagMenu.ids.length} 个` : ''}
            </button>
          </>)}
        </div>
      )}

      {orgOpen && (
        <div className="modal-mask" onMouseDown={() => { if (!orgBusy) setOrgOpen(false); }}>
          <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">整理计划 {orgBusy ? '· 处理中…' : `· ${orgRows.length} 项`}</div>
            <div className="hint">
              只对当前选择的文件夹（含子文件夹）生效：规范为「类型根 / 分类 / 规范名」，只移动整个素材目录；
              目录内含多个素材、或目标已存在时自动跳过。
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
              <button className="btn" disabled={orgShrinkBusy} onClick={async () => {
                setOrgBusy(true);
                const lines = await shrinkPreviews();
                setOrgLog(lines);
                setOrgBusy(false);
                loadAssets(lib);
                setThumbVer(v => v + 1);
              }}>{orgShrinkBusy ? '压缩中…' : '压缩预览图'}</button>
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
            <div className="uvrow" style={{ gap: 6 }}>
              <input className="modal-input" style={{ flex: 1 }} autoFocus ref={askRef}
                defaultValue={ask.value}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitAsk(askRef.current?.value ?? '');
                  if (e.key === 'Escape') submitAsk(null);
                }} />
              {ask.browse && (window as any).amApi?.pickFolder && (
                <button className="btn" onClick={async () => {
                  const p = await (window as any).amApi.pickFolder();
                  if (p && askRef.current) askRef.current.value = p;
                }}>浏览…</button>
              )}
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => submitAsk(null)}>取消</button>
              <button className="btn primary" onClick={() => submitAsk(askRef.current?.value ?? '')}>确定</button>
            </div>
          </div>
        </div>
      )}

      {ueImportAsk && (
        <div className="modal-mask" onMouseDown={() => setUeImportAsk(null)}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">导入到 Unreal · {ueImportAsk.asset.name}</div>
            <div className="hint">选择要导入的资产类型（可多选）。UE 会把 FBX 里有的东西都解析一遍，
              没勾的类型导入后会被丢弃。</div>
            <div className="uvrow" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
              <label className="vp-check" onClick={() => setUeImpStatic(v => !v)}>
                <span className={'box' + (ueImpStatic ? ' on' : '')}>{ueImpStatic ? '✓' : ''}</span>静态网格体
              </label>
              <label className="vp-check" onClick={() => setUeImpSkeletal(v => !v)}>
                <span className={'box' + (ueImpSkeletal ? ' on' : '')}>{ueImpSkeletal ? '✓' : ''}</span>骨骼网格体
              </label>
              <label className="vp-check" onClick={() => setUeImpPhysics(v => !v)}>
                <span className={'box' + (ueImpPhysics ? ' on' : '')}>{ueImpPhysics ? '✓' : ''}</span>物理资产
              </label>
              <label className="vp-check" onClick={() => setUeImpPlace(v => !v)}>
                <span className={'box' + (ueImpPlace ? ' on' : '')}>{ueImpPlace ? '✓' : ''}</span>导入后放到视口
              </label>
            </div>
            <div className="hint">物理资产只对骨骼网格体有效（没勾骨骼网格体时会被忽略）；FBX 里没有骨架的模型导不出骨骼网格体。
              默认只导入资产、<b>不往视口放演员</b>；勾「导入后放到视口」才会放一个（重复导入会复用同名演员，不会堆叠）。</div>
            <div className="modal-b">
              <button className="btn" onClick={() => setUeImportAsk(null)}>取消</button>
              <button className="btn primary"
                disabled={!ueImpStatic && !ueImpSkeletal && !ueImpPhysics}
                onClick={() => {
                  const a = ueImportAsk.asset;
                  setUeImportAsk(null);
                  sendToTarget(a, 'ue', 'import', {
                    options: {
                      importOptions: {
                        staticMesh: ueImpStatic, skeletalMesh: ueImpSkeletal,
                        physicsAsset: ueImpPhysics, placeInViewport: ueImpPlace
                      }
                    }
                  });
                }}>
                导入
              </button>
            </div>
          </div>
        </div>
      )}

      {hdriAsk && (
        <div className="modal-mask" onMouseDown={() => setHdriAsk(null)}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">位图视口放置 · {hdriAsk.asset.name}</div>
            <div className="hint">位图文件被放到视口上。将该文件用作</div>
            <div className="uvrow">
              <label className="vp-check" onClick={() => setHdriEnv(v => !v)}>
                <span className={'box' + (hdriEnv ? ' on' : '')}>{hdriEnv ? '✓' : ''}</span>环境贴图
              </label>
            </div>
            <div className="uvrow">
              <label className="vp-check" onClick={() => setHdriVp(v => !v)}>
                <span className={'box' + (hdriVp ? ' on' : '')}>{hdriVp ? '✓' : ''}</span>视口背景
              </label>
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setHdriAsk(null)}>取消</button>
              <button className="btn primary" disabled={!hdriEnv && !hdriVp}
                onClick={() => { const a = hdriAsk.asset; setHdriAsk(null); sendToTarget(a, 'max', 'hdri', { options: { env: hdriEnv, viewport: hdriVp } }); }}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {wsPrompt && (
        <div className="modal-mask">
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">先设定一个工作区</div>
            <div className="hint">
              软件运行产生的文件（拖放描述、Su 转换的 GLB、插件副本、自定义基本体等）都会放进工作区，
              不再往 C 盘临时目录塞。建议放在素材盘（例如 D:\AssetManagerWorkspace）。
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setWsPrompt(false)}>稍后（暂用数据目录）</button>
              <button className="btn primary" onClick={chooseWorkspace}>选择文件夹…</button>
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

      {importLog.length > 0 && (
        <div className="importlog">
          <div className="ilog-t">{importing ? '导入中…' : '导入结果'}</div>
          {importLog.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {toast && (
        <div className={'toast ' + toast.kind} onClick={() => setToast(null)} title="点击关闭">{toast.msg}</div>
      )}
    </div>
  );
}




