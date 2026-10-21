#!/usr/bin/env python3
"""Zet de plaatafbeeldingen uit deze map (bestandsnaam: <sleutel>-<plaatnummer>.png/.jpg) als kleine ingebedde
afbeeldingen in module1-configurator.html en homepage-oud.html. Sleutels: gebrokenwit, wit, zwart, antraciet,
beige, eikenhout, notenhout, taupe. Gebruik: python3 materialen/bouw-afbeeldingen.py  (vereist ImageMagick: convert)"""
import base64, glob, json, os, re, subprocess, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
imgs = {}
for f in sorted(glob.glob(os.path.join(root, 'materialen', '*'))):
    base = os.path.basename(f)
    m = re.match(r'^([a-z]+)-[a-z0-9]+\.(png|jpe?g|webp)$', base, re.I)
    if not m: continue
    out = subprocess.run(['convert', f, '-resize', '256x256^', '-gravity', 'center', '-extent', '256x256', '-strip', '-quality', '82', 'jpg:-'], capture_output=True, check=True).stdout
    imgs[m.group(1).lower()] = 'data:image/jpeg;base64,' + base64.b64encode(out).decode()
block = '/*M1_MAT_IMAGES_START*/var M1_MAT_IMAGES = ' + json.dumps(imgs) + ';/*M1_MAT_IMAGES_END*/'
for name in ('module1-configurator.html', 'homepage-oud.html'):
    p = os.path.join(root, name)
    s = open(p, encoding='utf-8').read()
    if '/*M1_MAT_IMAGES_START*/' in s:
        s = re.sub(r'/\*M1_MAT_IMAGES_START\*/.*?/\*M1_MAT_IMAGES_END\*/', lambda _: block, s, flags=re.S)
        open(p, 'w', encoding='utf-8').write(s)
        print(name, 'bijgewerkt met', ', '.join(imgs))
    else:
        print(name, 'heeft nog geen plek voor de afbeeldingen', file=sys.stderr)
