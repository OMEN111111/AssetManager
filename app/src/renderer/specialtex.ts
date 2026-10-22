import UTIF from 'utif';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import type { AssetFile } from './types';

export const SPECIAL_TEX = /\.(tiff?|tga)$/i;

/** 把 TIFF / TGA 贴图解码成 PNG blob URL（three 的 TextureLoader 不认这两种格式） */
export async function specialTextureUrl(f: AssetFile): Promise<string | null> {
  try {
    if (/\.tga$/i.test(f.rel_path)) {
      const tex: any = await new TGALoader().loadAsync(`/api/file/${f.id}`);
      const img: any = tex.image;
      if (!img?.width) return null;
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      return await new Promise<string>(res => cv.toBlob(b => res(b ? URL.createObjectURL(b) : ''), 'image/png'));
    }
    const buf = await (await fetch(`/api/file/${f.id}`)).arrayBuffer();
    const ifds = UTIF.decode(buf);
    UTIF.decodeImage(buf, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const w = ifds[0].width;
    const h = ifds[0].height;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    return await new Promise<string>(res => cv.toBlob(b => res(b ? URL.createObjectURL(b) : ''), 'image/png'));
  } catch {
    return null;
  }
}

/** 预解码模型里的 TIFF/TGA 贴图，返回 文件名(小写) → blob URL */
export async function preloadSpecialTextures(files: AssetFile[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = files.filter(f => SPECIAL_TEX.test(f.rel_path));
  for (const f of list) {
    const url = await specialTextureUrl(f);
    if (url) out.set(String(f.rel_path).split('/').pop()!.toLowerCase(), url);
  }
  return out;
}
