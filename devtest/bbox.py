from PIL import Image
import os

p = os.path.join(r'D:\Program\AssetManager\app', 'shot-model.png')
im = Image.open(p).convert('RGB')
w, h = im.size
# stage excludes header (48) and toolbar area bottom ~120
x0, y0, x1, y1 = 0, 60, w, h - 140
px = im.load()
minx, miny, maxx, maxy = 10**9, 10**9, -1, -1
count = 0
for y in range(y0, y1, 2):
    for x in range(x0, x1, 2):
        r, g, b = px[x, y]
        if r + g + b > 120:
            count += 1
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
print('bbox', (minx, miny, maxx, maxy), 'size', (maxx - minx, maxy - miny), 'bright px', count)
