import { useEffect, useRef, useState } from 'react';
import UTIF from 'utif';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';

const SPECIAL = /\.(tiff?|tga)$/i;

export const isSpecialImage = (p: string) => SPECIAL.test(p);

/**
 * 浏览器原生解不了的 TIFF / TGA：本地解码成 Blob URL。
 * 进入视口才解码，且可限制最长边（网格缩略图用 512，详情页传 0 表示原尺寸）。
 */
export default function SmartImage({ fileId, path, className, alt, max = 512, fit = 'cover' }:
  { fileId: number; path: string; className?: string; alt?: string; max?: number; fit?: 'cover' | 'contain' }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setVisible(true);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !isSpecialImage(path)) return;
    let alive = true;
    let url: string | null = null;
    (async () => {
      try {
        const ext = (path.split('.').pop() || '').toLowerCase();
        let source: CanvasImageSource | null = null;
        let w = 0, h = 0;
        if (ext === 'tif' || ext === 'tiff') {
          const buf = await (await fetch(`/api/file/${fileId}`)).arrayBuffer();
          const ifds = UTIF.decode(buf);
          UTIF.decodeImage(buf, ifds[0]);
          const rgba = UTIF.toRGBA8(ifds[0]);
          w = ifds[0].width;
          h = ifds[0].height;
          const tmp = document.createElement('canvas');
          tmp.width = w;
          tmp.height = h;
          const tctx = tmp.getContext('2d')!;
          const img = tctx.createImageData(w, h);
          img.data.set(rgba);
          tctx.putImageData(img, 0, 0);
          source = tmp;
        } else {
          const tex = await new TGALoader().loadAsync(`/api/file/${fileId}`);
          const el: any = tex.image;
          w = el.width;
          h = el.height;
          source = el;
        }
        if (!alive) return;
        const scale = max > 0 ? Math.min(1, max / Math.max(w, h)) : 1;
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        canvas.getContext('2d')!.drawImage(source, 0, 0, cw, ch);
        const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
        if (!alive || !blob) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [visible, fileId, path, max]);

  return (
    <div className="smartimg" ref={boxRef}>
      {src ? <img src={src} alt={alt || ''} className={className} style={{ objectFit: fit }} />
        : failed ? <div className="imgfail">无法解码</div>
          : <div className="imgwait" />}
    </div>
  );
}
