from PIL import Image, ImageStat
import os

base = r'D:\Program\AssetManager\app'
for name in ['shot-mat.png', 'shot-model.png', 'shot-5.png']:
    p = os.path.join(base, name)
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB')
    w, h = im.size
    c = im.crop((int(w * 0.3), int(h * 0.2), int(w * 0.78), int(h * 0.86)))
    st = ImageStat.Stat(c)
    px = list(c.getdata())
    bg = sum(1 for q in px if q[0] < 32 and q[1] < 32 and q[2] < 36)
    print(name, im.size, 'mean', [round(x, 1) for x in st.mean],
          'std', [round(x, 1) for x in st.stddev], 'bg%', round(100 * bg / len(px), 1))
