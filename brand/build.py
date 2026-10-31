# Petti brand: "P." mark and "Petti." wordmark, drawn from Inter ExtraBold outlines.
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from PIL import Image, ImageDraw
import cairosvg, io
GREEN, SAND, INK = '#1b5e4b', '#e4b85c', '#19231f'
f = TTFont('/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf')
gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f['head'].unitsPerEm
def run(text, track=-0.04):
    """glyph paths for text, y flipped, baseline 0; returns [(char, d, x)] and total advance"""
    out, x = [], 0
    for ch in text:
        g = gs[cmap[ord(ch)]]; p = SVGPathPen(gs); g.draw(p)
        out.append((ch, p.getCommands(), x)); x += g.width + track * upm
        if ch == 't': x -= 0.012 * upm      # the two t's overlap a touch so their crossbars join cleanly
    return out, x - track * upm
def bbox(text):
    b = BoundsPen(gs); x = 0
    xs=[];ys=[]
    for ch,d,ox in run(text)[0]:
        bp=BoundsPen(gs); gs[cmap[ord(ch)]].draw(bp)
        if bp.bounds: xs += [bp.bounds[0]+ox, bp.bounds[2]+ox]; ys += [bp.bounds[1], bp.bounds[3]]
    return min(xs), min(ys), max(xs), max(ys)
def group(text, colors, scale, tx, ty):
    glyphs,_ = run(text)
    # one path per colour, so touching letters fill as one shape with no seam
    from fontTools.pens.transformPen import TransformPen
    by = {}
    for i,(ch,d,ox) in enumerate(glyphs):
        p = SVGPathPen(gs); gs[cmap[ord(ch)]].draw(TransformPen(p, (scale,0,0,-scale,tx+ox*scale,ty)))
        by.setdefault(colors(i,ch), []).append(p.getCommands())
    return ''.join(f'<path fill="{c}" fill-rule="nonzero" d="{" ".join(ds)}"/>' for c,ds in by.items())
def mark_svg(size=512, bg=GREEN, fg='#fff', radius=0.22, dot=None):
    x0,y0,x1,y1 = bbox('P.')
    s = size*0.56/(y1-y0)                       # cap height fills 56% of the square
    w = (x1-x0)*s; tx = (size-w)/2 - x0*s; ty = size/2 + (y1+y0)/2*s
    body = group('P.', lambda i,c: (dot or SAND) if c=='.' else fg, s, tx, ty)
    r = f'<rect width="{size}" height="{size}" rx="{size*radius:.1f}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">{r}{body}</svg>'
def word_svg(fg=GREEN, h=200):
    x0,y0,x1,y1 = bbox('Petti.')
    s = h*0.8/(y1-y0); pad = h*0.1
    W = (x1-x0)*s + 2*pad
    body = group('Petti.', lambda i,c: SAND if c=='.' else fg, s, pad - x0*s, pad + y1*s)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.1f} {h}" width="{W:.0f}" height="{h}">{body}</svg>'
files = {
  'petti-mark.svg': mark_svg(),
  'petti-mark-maskable.svg': mark_svg(radius=0),          # Android crops its own shape
  'petti-wordmark.svg': word_svg(),
  'petti-wordmark-white.svg': word_svg(fg='#ffffff'),
  'petti-wordmark-dark.svg': word_svg(fg=INK),
}
for n,s in files.items(): open(n,'w').write(s)
def png(svg, px): return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px)))
web = '/home/claude/petty-cash-stock/web/'
# iOS and Android draw their own rounded corners, so app icons are full-bleed squares
png(files['petti-mark-maskable.svg'], 512).save(web+'icon-512.png'); png(files['petti-mark-maskable.svg'], 192).save(web+'icon-192.png')
png(files['petti-mark-maskable.svg'], 180).save(web+'icon-180.png')
# notification badge: Android shows it as a white silhouette, so a transparent "P." only
png(mark_svg(bg=None, fg='#ffffff', dot='#ffffff'), 96).save(web+'badge-96.png')
png(files['petti-mark.svg'], 1024).save('petti-mark-1024.png')
cairosvg.svg2png(bytestring=files['petti-wordmark.svg'].encode(), write_to='petti-wordmark.png', output_height=400)
print('done')
