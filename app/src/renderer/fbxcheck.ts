/** FBX 头检查：three 的 FBXLoader 只支持二进制 FBX（Kaydara FBX Binary） */
export const ASCII_FBX_MSG =
  '该 FBX 是 ASCII 文本格式，three.js 不支持。请用 3ds Max / Blender 另存为「二进制 FBX」，或直接导出 GLB 后再试。';

export async function assertBinaryFbx(fileId: number, relPath: string) {
  if (!/\.fbx$/i.test(relPath || '')) return;
  try {
    const r = await fetch(`/api/file-head/${fileId}`).then(x => (x.ok ? x.json() : null));
    const head = String(r?.head || '');
    if (head && !head.startsWith('Kaydara FBX Binary')) {
      throw new Error(ASCII_FBX_MSG);
    }
  } catch (e: any) {
    if (String(e?.message || '').includes('ASCII')) throw e;
    /* 读不到头就交给 loader 自己报错 */
  }
}
