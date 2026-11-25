#!/usr/bin/env python3
"""Image comparison for visual-diff.sh (ImageMagick does the pixel work).

  visual-compare.py check <baseline-dir> <current-dir> <config.json> <diff-dir>
  visual-compare.py noise <run-dir> "<other-run-dir> ..." <config.json> <diff-dir>

For each view: paint the configured mask rectangles on both images, then
  compare -metric AE -fuzz <fuzz>   -> differing pixels -> % of the image.
mode "layout-only": both images are first blurred (sigma 8) and shrunk to 1/8,
so text/antialiasing/jitter disappear and only moved/added/removed regions count.
Config (visual-config.json):
  {"default": {"fuzz": "3%", "threshold": 0.5},
   "views": {"graph": {"mode": "layout-only", "threshold": 8, "masks": [[x0,y0,x1,y1,"why"]]}}}
"""
import json, os, re, subprocess, sys

mode, a_dir, b_arg, cfg_path, diff_dir = sys.argv[1:6]
cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
default = cfg.get("default", {"fuzz": "3%", "threshold": 0.5})
views_cfg = cfg.get("views", {})


def vcfg(view, raw=False):
    c = dict(default)
    if not raw:
        c.update(views_cfg.get(view, {}))
    return c


def view_of(fn):
    return re.sub(r"^\d+-", "", os.path.basename(fn)[:-4])


def size(p):
    w, h = subprocess.run(["identify", "-format", "%w %h", p], capture_output=True, text=True).stdout.split()
    return int(w), int(h)


def prep(src, out, c):
    cmd = ["convert", src, "-alpha", "off"]
    for m in c.get("masks", []):
        x0, y0, x1, y1 = m[:4]
        cmd += ["-fill", "#ff00ff", "-draw", f"rectangle {x0},{y0} {x1},{y1}"]
    if c.get("mode") == "layout-only":
        cmd += ["-blur", "0x8", "-resize", "12.5%"]
    subprocess.run(cmd + [out], check=True)


def diff(a, b, view, tag, write, raw=False):
    c = vcfg(view, raw)
    wa, ha = size(a); wb, hb = size(b)
    if (wa, ha) != (wb, hb):
        return {"pct": 100.0, "note": f"size {wa}x{ha} vs {wb}x{hb}", "c": c}
    pa, pb = f"{diff_dir}/.a.png", f"{diff_dir}/.b.png"
    prep(a, pa, c); prep(b, pb, c)
    w, h = size(pa)
    r = subprocess.run(["compare", "-metric", "AE", "-fuzz", c["fuzz"], pa, pb, f"{diff_dir}/.d.png"], capture_output=True, text=True)
    m = re.match(r"\s*([\d.e+]+)", r.stderr)
    if not m:
        raise SystemExit(f"compare failed for {view}: {r.stderr[:200]}")
    ae = float(m.group(1)); pct = 100.0 * ae / (w * h)
    bbox = ""
    if ae > 0:
        scale = 8 if c.get("mode") == "layout-only" else 1
        t = subprocess.run(["convert", pa, pb, "-compose", "difference", "-composite", "-colorspace", "gray",
                            "-threshold", c["fuzz"], "-format", "%@", "info:"], capture_output=True, text=True).stdout.strip()
        mm = re.match(r"(\d+)x(\d+)\+(\d+)\+(\d+)", t)
        if mm:
            bw, bh, bx, by = (int(v) * scale for v in mm.groups())
            bbox = f"{bx},{by} {bx + bw},{by + bh}"
    out = {"pct": pct, "bbox": bbox, "c": c}
    if write:
        img = f"{diff_dir}/{tag}.png"
        hl = f"{diff_dir}/.hl.png"
        subprocess.run(["compare", "-fuzz", c["fuzz"], "-highlight-color", "red", a, b, hl], capture_output=True)
        subprocess.run(["convert", a, b, hl if os.path.exists(hl) else b, "-resize", "50%", "+append", img], check=True)
        out["img"] = img
    return out


def pngs(d):
    if not os.path.isdir(d):
        return {}
    return {view_of(f): os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".png")}


if mode == "check":
    base, cur = pngs(a_dir), pngs(b_arg)
    print("# Visual regression\n")
    print(f"Baselines: `{a_dir}`  \nCurrent: `{b_arg}`\n")
    rows = []
    order = sorted(set(base) | set(cur), key=lambda v: os.path.basename(cur.get(v) or base.get(v)))
    for v in order:
        if v not in base:
            rows.append((v, None, "NEW", None, "", "")); continue
        if v not in cur:
            rows.append((v, None, "MISSING", None, "", "")); continue
        d = diff(base[v], cur[v], v, v, write=False)
        status = "CHANGED" if d["pct"] > d["c"]["threshold"] else "PASS"
        if status == "CHANGED":
            d = diff(base[v], cur[v], v, v, write=True)
        rows.append((v, d["pct"], status, d["c"], d.get("bbox", ""), d.get("img", d.get("note", ""))))
    counts = {s: sum(1 for r in rows if r[2] == s) for s in ("PASS", "CHANGED", "NEW", "MISSING")}
    print(" · ".join(f"**{k}** {v}" for k, v in counts.items()) + "\n")
    print("| View | % changed | threshold | mode | status | changed area (x0,y0 x1,y1) | side-by-side |\n|---|---|---|---|---|---|---|")
    for v, pct, st, c, bbox, img in rows:
        print(f"| {v} | {'' if pct is None else f'{pct:.3f}'} | {'' if not c else c['threshold']} | "
              f"{'' if not c else c.get('mode', 'pixel')} | {st} | {bbox} | {img} |")
    print("\n## How to read\n\nPASS = differing pixels (after masks, fuzz) at or under the view's threshold. "
          "CHANGED = over it; the side-by-side is baseline | current | diff (red). NEW = no baseline (approve to add). "
          "MISSING = a baseline view was not produced (tour broke or a view was renamed). "
          "Thresholds sit above the measured noise floor (visual-noise.md).")
else:
    ref = pngs(a_dir); others = [pngs(d) for d in b_arg.split()]
    print("# Visual noise floor\n")
    print(f"Same build, same seed, tour run {1 + len(others)} times; each later run compared with the first. "
          "Raw = no masks, pixel mode, default fuzz. Configured = with the view's masks/mode/fuzz from visual-config.json.\n")
    print("| View | raw % (max) | configured % (max) | threshold | mode | margin | changed area (raw) |\n|---|---|---|---|---|---|---|")
    for v, p in ref.items():
        raws, cfgs, boxes = [], [], []
        for i, o in enumerate(others):
            if v not in o:
                continue
            r = diff(p, o[v], v, f"noise-raw-{v}-{i}", write=False, raw=True)
            raws.append(r["pct"]); boxes.append(r.get("bbox", ""))
            d = diff(p, o[v], v, f"noise-{v}-{i}", write=r["pct"] > 0.05)
            cfgs.append(d["pct"])
        if not raws:
            continue
        c = vcfg(v)
        mr, mc = max(raws), max(cfgs)
        margin = "OK" if mc <= c["threshold"] / 2 else ("TIGHT" if mc <= c["threshold"] else "NOISY: threshold below noise")
        print(f"| {v} | {mr:.3f} | {mc:.3f} | {c['threshold']} | {c.get('mode', 'pixel')} | {margin} | {'; '.join(b for b in boxes if b)} |")
    print("\n## Notes\n\nA view whose configured % is above half its threshold is TIGHT: a real change of that size "
          "would be hidden. Add a mask or switch it to layout-only rather than raising the threshold blindly.")
for f in (".a.png", ".b.png", ".d.png", ".hl.png"):
    try:
        os.remove(f"{diff_dir}/{f}")
    except OSError:
        pass
