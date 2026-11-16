import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const args = { cmd: null, manifest: 'annotations/manifest.json', md: null, out: null, title: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && !args.cmd && ['--update-hashes', '--build-images', '--build-docs', '--verify'].includes(a)) {
      args.cmd = a;
    } else if (a === '--manifest' && argv[i + 1]) {
      args.manifest = argv[++i];
    } else if (a === '--md' && argv[i + 1]) {
      args.md = argv[++i];
    } else if (a === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    } else if (a === '--title' && argv[i + 1]) {
      args.title = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = resolve(process.cwd(), args.manifest);
const root = dirname(dirname(manifestPath));

const pythonScript = String.raw`
import sys, json, hashlib, struct, math, os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
mode = sys.argv[3]
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))

def pick_font_path(candidates):
    for p in candidates:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(f"No usable font found in {candidates}")

regular_path = pick_font_path([
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
])
bold_path = pick_font_path([
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
])

def get_font(path, size):
    return ImageFont.truetype(path, size)

def png_size(path):
    with path.open('rb') as f:
        sig = f.read(8)
        assert sig == b'\x89PNG\r\n\x1a\n', f'Not a valid PNG: {path}'
        f.read(8)
        return struct.unpack('>II', f.read(8))

def png_has_forbidden_chunks(path):
    data = path.read_bytes()
    pos = 8
    forbidden = {b'tEXt', b'iTXt', b'zTXt', b'eXIf'}
    found = []
    while pos + 8 <= len(data):
        length = struct.unpack('>I', data[pos:pos+4])[0]
        ctype = data[pos+4:pos+8]
        if ctype in forbidden:
            found.append(ctype.decode('ascii', errors='ignore'))
        pos += 12 + length
        if ctype == b'IEND':
            break
    return found

def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def text_fit(draw, text, fnt, maxw):
    if not text:
        return ''
    bbox = draw.textbbox((0, 0), text, font=fnt)
    if (bbox[2] - bbox[0]) <= maxw:
        return text
    while text:
        bbox = draw.textbbox((0, 0), text + '…', font=fnt)
        if (bbox[2] - bbox[0]) <= maxw:
            return text + '…'
        text = text[:-1]
    return '…'

def draw_arrow(draw, x1, y1, x2, y2, color):
    dx = x2 - x1
    dy = y2 - y1
    dist = math.hypot(dx, dy)
    if dist < 4:
        return
    ux = dx / dist
    uy = dy / dist
    head_len = min(18.0, max(12.0, dist * 0.35))
    head_half_w = 9.0
    bx = x2 - ux * head_len
    by = y2 - uy * head_len
    px = -uy
    py = ux
    p1 = (x2, y2)
    p2 = (bx + px * head_half_w, by + py * head_half_w)
    p3 = (bx - px * head_half_w, by - py * head_half_w)
    draw.line((x1, y1, bx, by), fill='#FFFFFF', width=8)
    draw.line((x1, y1, bx, by), fill=color, width=4)
    draw.polygon([p1, p2, p3], fill=color, outline='#FFFFFF')

def build_image(item):
    raw_path = root / item['rawPath']
    out_path = root / item['annotatedPath']
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.open(raw_path).convert('RGBA')
    w, h = im.size
    banner_h = int(manifest.get('topBannerHeight', 72))
    canvas = Image.new('RGBA', (w, h + banner_h), (255, 255, 255, 255))
    canvas.paste(im, (0, banner_h))
    d = ImageDraw.Draw(canvas, 'RGBA')

    # 1. Top Step Guide Banner (72px)
    d.rectangle((0, 0, w, banner_h), fill='#1E293B')
    d.rectangle((0, banner_h - 3, w, banner_h), fill='#FFCF40')
    tag_text = f"{item['scenarioId']} · 步骤 {item['stepIndex']}"
    f_tag = get_font(bold_path, 22)
    f_banner = get_font(bold_path, 23)
    d.rounded_rectangle((16, 14, 196, 58), radius=10, fill='#FFCF40')
    tb = d.textbbox((0, 0), tag_text, font=f_tag)
    d.text((16 + (180 - (tb[2] - tb[0])) / 2, 14 + (44 - (tb[3] - tb[1])) / 2 - 2), tag_text, font=f_tag, fill='#111827')
    d.text((212, 22), text_fit(d, item['headerBanner'], f_banner, w - 228), font=f_banner, fill='#FFFFFF')

    # 2. Pass 1: highlight boxes & arrows
    for a in item['annotations']:
        kind = a.get('kind', 'action')
        color = '#E53935' if kind == 'action' else ('#16A34A' if kind == 'verify_green' else '#D97706')
        box = a['box']
        bx0, by0 = box['x'], box['y'] + banner_h
        bx1, by1 = bx0 + box['w'], by0 + box['h']
        rx = box.get('rx', 12)
        d.rounded_rectangle((bx0 - 2, by0 - 2, bx1 + 2, by1 + 2), radius=rx + 2, fill=None, outline='#FFFFFF', width=7)
        d.rounded_rectangle((bx0, by0, bx1, by1), radius=rx, fill=None, outline=color, width=4)

        ar = a['arrow']
        draw_arrow(d, ar['x1'], ar['y1'] + banner_h, ar['x2'], ar['y2'] + banner_h, color)

    # 3. Pass 2: callout pills & numbered badges on top
    for a in item['annotations']:
        kind = a.get('kind', 'action')
        color = '#E53935' if kind == 'action' else ('#16A34A' if kind == 'verify_green' else '#D97706')
        c = a['callout']
        cx0, cy0 = c['x'], c['y'] + banner_h
        cx1, cy1 = cx0 + c['w'], cy0 + c['h']
        crx = c.get('rx', 12)
        d.rounded_rectangle((cx0 + 2, cy0 + 4, cx1 + 2, cy1 + 4), radius=crx, fill=(15, 23, 42, 48))
        d.rounded_rectangle((cx0, cy0, cx1, cy1), radius=crx, fill=(255, 255, 255, 248), outline=color, width=3)
        f_title = get_font(bold_path, 24)
        f_sub = get_font(regular_path, 19)
        d.text((cx0 + 16, cy0 + 14), text_fit(d, c['text'], f_title, c['w'] - 32), font=f_title, fill='#111827')
        if c.get('subtext'):
            d.text((cx0 + 16, cy0 + 50), text_fit(d, c['subtext'], f_sub, c['w'] - 32), font=f_sub, fill='#4B5563')

        b = a['badge']
        bcx, bcy, br = b['cx'], b['cy'] + banner_h, b.get('r', 20)
        d.ellipse((bcx - br, bcy - br, bcx + br, bcy + br), fill=color, outline='#FFFFFF', width=3)
        lbl = str(a['step'])
        f_num = get_font(bold_path, 22)
        nb = d.textbbox((0, 0), lbl, font=f_num)
        d.text((bcx - (nb[2] - nb[0]) / 2, bcy - (nb[3] - nb[1]) / 2 - 2), lbl, font=f_num, fill='#FFFFFF')

    canvas.convert('RGB').save(out_path, format='PNG', optimize=True)

def rect_overlap_area(r1, r2):
    x_left = max(r1[0], r2[0])
    y_top = max(r1[1], r2[1])
    x_right = min(r1[2], r2[2])
    y_bottom = min(r1[3], r2[3])
    if x_right <= x_left or y_bottom <= y_top:
        return 0
    return (x_right - x_left) * (y_bottom - y_top)

items = manifest.get('items', [])
if mode == 'update':
    for item in items:
        p = root / item['rawPath']
        item['rawSha256'] = sha256_file(p)
        item['width'], item['height'] = png_size(p)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"Updated SHA-256 and dimensions for {len(items)} raw images.")

elif mode == 'images':
    for item in items:
        build_image(item)
    print(f"Rendered {len(items)} annotated screenshots.")

elif mode == 'verify':
    assert len(items) > 0, "manifest.items must not be empty"
    canvas_w = int(manifest.get('canvasWidth', 750))
    banner_h = int(manifest.get('topBannerHeight', 72))
    required_fields = {'id', 'scenarioId', 'stepIndex', 'headerBanner', 'rawPath', 'annotatedPath', 'rawSha256', 'annotations'}

    for item in items:
        missing = required_fields - set(item.keys())
        assert not missing, f"{item.get('id')} missing fields: {missing}"
        raw_p = root / item['rawPath']
        ann_p = root / item['annotatedPath']
        assert raw_p.exists() and raw_p.stat().st_size > 1000, f"Raw missing or too small: {raw_p}"
        assert ann_p.exists() and ann_p.stat().st_size > 1000, f"Annotated missing or too small: {ann_p}"
        actual_sha = sha256_file(raw_p)
        assert actual_sha == item['rawSha256'], f"SHA mismatch on {item['id']}: {actual_sha} != {item['rawSha256']}"
        rw, rh = png_size(raw_p)
        ow, oh = png_size(ann_p)
        assert rw == canvas_w and ow == canvas_w, f"Width != {canvas_w} on {item['id']}: raw={rw}, ann={ow}"
        assert oh == rh + banner_h, f"Height mismatch on {item['id']}: ann={oh} != raw({rh})+{banner_h}"
        assert not png_has_forbidden_chunks(raw_p), f"Forbidden PNG chunks in {raw_p}"
        assert not png_has_forbidden_chunks(ann_p), f"Forbidden PNG chunks in {ann_p}"
        assert isinstance(item['annotations'], list) and len(item['annotations']) >= 1, f"Empty annotations in {item['id']}"

        inner_boxes = []
        callouts = []
        for a in item['annotations']:
            b, c, bd = a['box'], a['callout'], a['badge']
            assert b['w'] >= 24 and b['h'] >= 24, f"Box too small in {item['id']}"
            assert 0 <= b['x'] and b['x'] + b['w'] <= rw and 0 <= b['y'] and b['y'] + b['h'] <= rh, f"Box out of bounds in {item['id']}"
            assert 0 <= c['x'] and c['x'] + c['w'] <= rw and 0 <= c['y'] and c['y'] + c['h'] <= rh, f"Callout out of bounds in {item['id']}"
            r = bd.get('r', 20)
            assert r <= bd['cx'] <= rw - r and r <= bd['cy'] <= rh - r, f"Badge out of bounds in {item['id']}"
            inner_boxes.append((b['x'] + 6, b['y'] + 6, b['x'] + b['w'] - 6, b['y'] + b['h'] - 6))
            callouts.append((c['x'], c['y'], c['x'] + c['w'], c['y'] + c['h']))

        for c_rect in callouts:
            for ib_rect in inner_boxes:
                ov = rect_overlap_area(c_rect, ib_rect)
                assert ov == 0, f"Callout overlaps target box inner zone in {item['id']} (overlap={ov})"

    print(f"Gate 1 & Gate 2 passed: {len(items)} raw + {len(items)} annotated PNGs verified (SHA-256, {canvas_w}px width, clean chunks, zero occlusion).")
`;

function renderMarkdownToHtml(title, mdText) {
  const lines = mdText.split(/\r?\n/);
  let html = '';
  let inList = null;
  let inTable = false;
  let tableRows = [];
  let inCode = false;
  let codeLines = [];

  const formatInline = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<figure class="shot-card"><img src="$2" alt="$1" loading="lazy"><figcaption>$1</figcaption></figure>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const slugify = (text) => text.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s-]/g, '').trim().replace(/\s+/g, '-');
  const flushList = () => { if (inList) { html += `</${inList}>\n`; inList = null; } };
  const flushTable = () => {
    if (!inTable) return;
    inTable = false;
    if (!tableRows.length) return;
    html += '<div class="table-wrap"><table><thead><tr>';
    for (const h of tableRows[0]) html += `<th>${formatInline(h)}</th>`;
    html += '</tr></thead><tbody>';
    for (let i = 2; i < tableRows.length; i++) {
      html += '<tr>';
      for (const cell of tableRows[i]) html += `<td>${formatInline(cell)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>\n';
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('```')) {
      flushList(); flushTable();
      if (!inCode) { inCode = true; codeLines = []; }
      else { inCode = false; html += `<pre><code>${codeLines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>\n`; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (line.startsWith('|') && line.endsWith('|')) {
      flushList(); inTable = true;
      tableRows.push(line.slice(1, -1).split('|').map((c) => c.trim()));
      continue;
    } else if (inTable) { flushTable(); }

    if (!line.trim()) { flushList(); continue; }
    if (line === '---') { flushList(); html += '<hr>\n'; continue; }
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushList();
      html += `<h${hMatch[1].length} id="${slugify(hMatch[2].trim())}">${formatInline(hMatch[2].trim())}</h${hMatch[1].length}>\n`;
      continue;
    }
    if (line.startsWith('>')) { flushList(); html += `<blockquote>${formatInline(line.replace(/^>\s?/, ''))}</blockquote>\n`; continue; }
    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) { if (inList !== 'ul') { flushList(); inList = 'ul'; html += '<ul>\n'; } html += `<li>${formatInline(ulMatch[1])}</li>\n`; continue; }
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) { if (inList !== 'ol') { flushList(); inList = 'ol'; html += '<ol>\n'; } html += `<li>${formatInline(olMatch[1])}</li>\n`; continue; }
    flushList();
    html += `<p>${formatInline(line)}</p>\n`;
  }
  flushList(); flushTable();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=2">
<title>${title}</title>
<style>
  :root { --bg:#F4F6F9; --card:#FFFFFF; --text:#111827; --sub:#4B5563; --accent:#FFCF40; --border:#E5E7EB; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; line-height:1.68; font-size:16px; }
  .container { max-width:780px; margin:0 auto; padding:20px 16px 64px; }
  .doc-card { background:var(--card); border-radius:18px; padding:24px 20px; box-shadow:0 4px 20px rgba(17,24,39,.06); }
  h1 { font-size:26px; margin:0 0 16px; padding-bottom:12px; border-bottom:3px solid var(--accent); }
  h2 { font-size:21px; margin:32px 0 12px; padding:10px 14px; background:#1E293B; color:#FFF; border-left:6px solid var(--accent); border-radius:8px; }
  .shot-card { margin:18px auto; max-width:460px; background:#F8FAFC; border:1px solid var(--border); border-radius:14px; padding:10px; text-align:center; }
  .shot-card img { display:block; width:100%; height:auto; border-radius:10px; }
  .shot-card figcaption { margin-top:8px; font-size:14px; font-weight:600; color:var(--sub); }
  .table-wrap { overflow-x:auto; margin:14px 0 22px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { border:1px solid var(--border); padding:10px 12px; text-align:left; }
  th { background:#F3F4F6; }
  @media print { body { background:#FFF; } .doc-card { box-shadow:none; padding:0; } .shot-card { page-break-inside:avoid; max-width:360px; } }
</style>
</head>
<body><div class="container"><article class="doc-card">${html}</article></div></body>
</html>`;
}

function runPython(mode) {
  const res = spawnSync('uv', ['run', '--with', 'pillow', 'python3', '-c', pythonScript, root, manifestPath, mode], { encoding: 'utf8' });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) process.exit(res.status || 1);
}

function verifyDocs() {
  if (!args.md) return;
  const mdPath = resolve(process.cwd(), args.md);
  if (!existsSync(mdPath)) throw new Error(`Missing Markdown file: ${mdPath}`);
  const mdText = readFileSync(mdPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const knownAnnotated = new Set((manifest.items || []).map((x) => x.annotatedPath));
  const imgRegex = /!\[[^\]]*\]\(\.?\/?(screenshots\/annotated\/[^)]+)\)/g;
  const matches = [...mdText.matchAll(imgRegex)].map((m) => m[1]);
  for (const relPath of matches) {
    if (!knownAnnotated.has(relPath)) throw new Error(`Image ${relPath} is not registered in manifest.json`);
    if (!existsSync(join(root, relPath))) throw new Error(`Referenced image missing on disk: ${relPath}`);
  }
  console.log(`Gate 3 passed: Verified ${matches.length} image links in ${args.md}.`);
}

if (args.cmd === '--update-hashes') {
  runPython('update');
} else if (args.cmd === '--build-images') {
  runPython('images');
} else if (args.cmd === '--build-docs') {
  if (!args.md) throw new Error('--build-docs requires --md <file.md>');
  const mdPath = resolve(process.cwd(), args.md);
  const outPath = args.out ? resolve(process.cwd(), args.out) : mdPath.replace(/\.md$/i, '.html');
  const mdText = readFileSync(mdPath, 'utf8');
  writeFileSync(outPath, renderMarkdownToHtml(args.title || '操作图解手册', mdText), 'utf8');
  console.log(`Compiled HTML manual: ${outPath}`);
} else if (args.cmd === '--verify') {
  runPython('verify');
  verifyDocs();
} else {
  console.error('Usage: node annotate-screenshots.mjs <--update-hashes|--build-images|--build-docs|--verify> [--manifest annotations/manifest.json] [--md guide.md] [--out guide.html] [--title "..."]');
  process.exit(1);
}
