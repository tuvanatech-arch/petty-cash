# Makes a .webp next to each .jpg/.png given (the website shows the WebP; the JPEG stays for social previews).
# python3 ops/webp.py site/img/*.jpg site/img/cycle/*.jpg site/img/pack-recon.png
import sys, os
from PIL import Image
for f in sys.argv[1:]:
    Image.open(f).save(os.path.splitext(f)[0] + '.webp', 'WEBP', quality=80, method=6)
    print('webp', f)
