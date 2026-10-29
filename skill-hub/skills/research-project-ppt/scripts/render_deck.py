#!/usr/bin/env python3
"""把 deck.json 渲染为可编辑 PPTX。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layouts
from deckkit import (FONT_PROFILES, H, ImgEl, Line, Rect, Run, TableEl,
                     TextEl, Tri, W)


# ---------------------------------------------------------------- PPTX

def _pptx_modules():
    from pptx import Presentation
    from pptx.util import Emu, Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
    from pptx.enum.dml import MSO_LINE_DASH_STYLE
    from pptx.oxml.ns import qn
    from lxml import etree
    return (Presentation, Emu, Pt, RGBColor, PP_ALIGN, MSO_ANCHOR, MSO_SHAPE,
            MSO_CONNECTOR, MSO_LINE_DASH_STYLE, qn, etree)


def _rgb(hexstr: str):
    RGBColor = _pptx_modules()[3]
    h = hexstr.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _px(v: float) -> int:
    return int(round(v * 9525))


def _set_ea_font(run, name: str) -> None:
    _, _, _, _, _, _, _, _, _, qn, etree = _pptx_modules()
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        for old in rPr.findall(qn(tag)):
            rPr.remove(old)
    for tag in ("a:ea", "a:cs"):
        el = etree.SubElement(rPr, qn(tag))
        el.set("typeface", name)


def _run_font(run, spec: Run) -> None:
    Pt = _pptx_modules()[2]
    f = run.font
    f.name = spec.family
    f.size = Pt(spec.size * 0.75)
    f.bold = spec.bold
    f.underline = spec.underline
    f.color.rgb = _rgb(spec.color)
    _set_ea_font(run, spec.family)


def _add_text(slide, el: TextEl) -> None:
    _, Emu, Pt, _, PP_ALIGN, MSO_ANCHOR, _, _, _, _, _ = _pptx_modules()
    tb = slide.shapes.add_textbox(_px(el.x), _px(el.y), _px(el.w), _px(el.h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "center": MSO_ANCHOR.MIDDLE,
                          "bottom": MSO_ANCHOR.BOTTOM}.get(el.valign, MSO_ANCHOR.TOP)
    if el.vertical:
        tf._txBody.bodyPr.set("vert", "eaVert")
    align = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(el.align, PP_ALIGN.LEFT)
    for i, line in enumerate(el.lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = Pt(el.size * el.lh * 0.75)
        p.space_before = Pt(0)
        p.space_after = Pt(0)
        for spec in line:
            r = p.add_run()
            r.text = spec.text
            _run_font(r, spec)
            if el.bold:
                r.font.bold = True


def _add_rect(slide, el: Rect) -> None:
    Pt = _pptx_modules()[2]
    from pptx.enum.shapes import MSO_SHAPE
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if el.radius > 0 else MSO_SHAPE.RECTANGLE
    shp = slide.shapes.add_shape(shape_type, _px(el.x), _px(el.y), _px(el.w), _px(el.h))
    shp.shadow.inherit = False
    if el.radius > 0:
        try:
            shp.adjustments[0] = min(0.5, el.radius / max(1, min(el.w, el.h)))
        except Exception:
            pass
    if el.gradient:
        shp.fill.gradient()
        stops = el.gradient[1]
        shp.fill.gradient_stops[0].position = float(stops[0][0])
        shp.fill.gradient_stops[0].color.rgb = _rgb(stops[0][1])
        shp.fill.gradient_stops[1].position = float(stops[-1][0])
        shp.fill.gradient_stops[1].color.rgb = _rgb(stops[-1][1])
        try:
            shp.fill.gradient_angle = float(el.gradient[0])
        except Exception:
            pass
    elif el.fill:
        shp.fill.solid()
        shp.fill.fore_color.rgb = _rgb(el.fill)
    else:
        shp.fill.background()
    if el.line:
        shp.line.color.rgb = _rgb(el.line)
        shp.line.width = Pt(max(0.5, el.lw * 0.75))
    else:
        shp.line.fill.background()
    if el.dash:
        try:
            from pptx.enum.dml import MSO_LINE_DASH_STYLE
            shp.line.dash_style = MSO_LINE_DASH_STYLE.DASH
        except Exception:
            pass


def _add_line(slide, el: Line) -> None:
    _, _, Pt, _, _, _, _, MSO_CONNECTOR, MSO_LINE_DASH_STYLE, _, _ = _pptx_modules()
    conn = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, _px(el.x1), _px(el.y1),
                                      _px(el.x2), _px(el.y2))
    conn.line.color.rgb = _rgb(el.color)
    conn.line.width = Pt(max(0.5, el.width * 0.75))
    if el.dash:
        conn.line.dash_style = MSO_LINE_DASH_STYLE.DASH


def _add_tri(slide, el: Tri) -> None:
    _, _, _, _, _, _, MSO_SHAPE, _, _, _, _ = _pptx_modules()
    shp = slide.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, _px(el.x), _px(el.y),
                                 _px(el.w), _px(el.h))
    shp.shadow.inherit = False
    shp.rotation = 90 if el.direction == "right" else 180
    shp.fill.solid()
    shp.fill.fore_color.rgb = _rgb(el.color)
    shp.line.fill.background()


def _cell_borders(cell, color_hex: str, width_pt: float = 0.56) -> None:
    _, _, _, _, _, _, _, _, _, qn, etree = _pptx_modules()
    tcPr = cell._tc.get_or_add_tcPr()
    for i, tag in enumerate(("a:lnL", "a:lnR", "a:lnT", "a:lnB")):
        ln = etree.Element(qn(tag))
        ln.set("w", str(int(width_pt * 12700)))
        ln.set("cap", "flat")
        ln.set("cmpd", "sng")
        ln.set("algn", "ctr")
        fill = etree.SubElement(ln, qn("a:solidFill"))
        clr = etree.SubElement(fill, qn("a:srgbClr"))
        clr.set("val", color_hex.lstrip("#"))
        dash = etree.SubElement(ln, qn("a:prstDash"))
        dash.set("val", "solid")
        tcPr.insert(i, ln)


def _cell_text(cell, runs: list[Run], align: str, bold: bool = False) -> None:
    _, _, _, _, PP_ALIGN, MSO_ANCHOR, _, _, _, _, _ = _pptx_modules()
    tf = cell.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    cell.margin_left = _px(8)
    cell.margin_right = _px(8)
    cell.margin_top = _px(2)
    cell.margin_bottom = _px(2)
    p = tf.paragraphs[0]
    p.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(align, PP_ALIGN.CENTER)
    p.line_spacing = 1.1
    if not runs:
        return
    parts: list[tuple[str, Run]] = []
    for spec in runs:
        chunks = spec.text.split("\n")
        for k, ch in enumerate(chunks):
            if k > 0:
                parts.append(("\n", spec))
            if ch:
                parts.append((ch, spec))
    first = True
    for text, spec in parts:
        if text == "\n":
            p = tf.add_paragraph()
            p.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(align, PP_ALIGN.CENTER)
            p.line_spacing = 1.1
            first = True
            continue
        r = p.add_run()
        r.text = text
        _run_font(r, spec)
        if bold:
            r.font.bold = True


def _add_table(slide, el: TableEl) -> None:
    _, _, _, _, _, _, _, _, _, _, _ = _pptx_modules()
    nrows = len(el.rows)
    ncols = len(el.col_w)
    shape = slide.shapes.add_table(nrows, ncols, _px(el.x), _px(el.y), _px(el.w),
                                   _px(sum(el.row_h)))
    table = shape.table
    for j, w in enumerate(el.col_w):
        table.columns[j].width = _px(w)
    for i, h in enumerate(el.row_h):
        table.rows[i].height = _px(h)
    for i, row in enumerate(el.rows):
        for j, cell_runs in enumerate(row):
            cell = table.cell(i, j)
            cell.fill.solid()
            cell.fill.fore_color.rgb = _rgb(el.header_fill if i == 0 else
                                            ("#FFFFFF" if i % 2 == 1 else "#F7F9FC"))
            _cell_borders(cell, "#B7C9E2")
            align = el.align[j] if j < len(el.align) else "center"
            bold = (i == 0) or (el.first_col_bold and j == 0)
            if i == 0:
                for spec in cell_runs:
                    spec.color = el.header_color
            _cell_text(cell, cell_runs, align, bold=bold)


def _add_image(slide, el: ImgEl) -> None:
    from PIL import Image
    path = el.src
    if path.lower().endswith(".svg"):
        return
    iw, ih = Image.open(path).size
    target_ar = el.w / el.h if el.h else 1
    img_ar = iw / ih if ih else target_ar
    if el.fit == "cover":
        pic = slide.shapes.add_picture(path, _px(el.x), _px(el.y), _px(el.w), _px(el.h))
        if img_ar > target_ar:
            crop = 1 - target_ar / img_ar
            pic.crop_left = crop / 2
            pic.crop_right = crop / 2
        elif img_ar < target_ar:
            crop = 1 - img_ar / target_ar
            pic.crop_top = crop / 2
            pic.crop_bottom = crop / 2
    else:
        scale = min(el.w / iw, el.h / ih)
        pw, ph = iw * scale, ih * scale
        pic = slide.shapes.add_picture(path, _px(el.x + (el.w - pw) / 2),
                                       _px(el.y + (el.h - ph) / 2), _px(pw), _px(ph))
    if el.border:
        try:
            Pt = _pptx_modules()[2]
            pic.line.color.rgb = _rgb(el.border)
            pic.line.width = Pt(0.75)
        except Exception:
            pass


def render_pptx(slide_sets, meta: dict, out_path: str) -> None:
    (Presentation, Emu, Pt, RGBColor, PP_ALIGN, MSO_ANCHOR, MSO_SHAPE,
     MSO_CONNECTOR, MSO_LINE_DASH_STYLE, qn, etree) = _pptx_modules()
    prs = Presentation()
    prs.slide_width = Emu(_px(W))
    prs.slide_height = Emu(_px(H))
    blank = prs.slide_layouts[6]
    for els in slide_sets:
        slide = prs.slides.add_slide(blank)
        for el in els:
            if isinstance(el, Rect):
                _add_rect(slide, el)
            elif isinstance(el, Line):
                _add_line(slide, el)
            elif isinstance(el, Tri):
                _add_tri(slide, el)
            elif isinstance(el, TextEl):
                _add_text(slide, el)
            elif isinstance(el, TableEl):
                _add_table(slide, el)
            elif isinstance(el, ImgEl):
                _add_image(slide, el)
    prs.core_properties.title = str(meta.get("titleLines", ["科研项目汇报"])[0])
    prs.core_properties.author = str(meta.get("reporter", ""))
    prs.save(out_path)


# ---------------------------------------------------------------- audit

def _walk(obj):
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from _walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk(value)


def _strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for value in obj.values():
            yield from _strings(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _strings(value)


def _red_spans(slide: dict) -> int:
    return sum(len(re.findall(r"\*\*.+?\*\*", s)) + len(re.findall(r"!!.+?!!", s))
               for s in _strings(slide))


def _bullet_max(slide: dict) -> int:
    max_len = 0
    for node in _walk(slide):
        for key in ("bullets", "points"):
            value = node.get(key)
            if isinstance(value, list):
                max_len = max(max_len, len(value))
    return max_len


def _image_count(slide: dict) -> int:
    return sum(1 for node in _walk(slide) if isinstance(node, dict) and node.get("src"))


def _modules(slide: dict) -> int:
    if slide.get("type") in ("cover", "ending", "agenda", "divider"):
        return 0
    layout = slide.get("layout")
    if layout == "table":
        cards = slide.get("bottomCards") or []
        return 1 + len(cards) if cards else (2 if slide.get("points") else 1)
    if layout == "split":
        return 2
    if layout == "flow":
        return max(1, len(slide.get("cards") or []))
    if layout == "intro-cards":
        return len(slide.get("cards") or [])
    if layout == "roadmap":
        return 2
    if layout == "metrics":
        return (1 if slide.get("metrics") else 0) + len(slide.get("cards") or [])
    if layout == "profile":
        profile = slide.get("profile") or {}
        n = sum(1 for key in ("education", "achievements") if (profile.get(key) or {}).get("rows"))
        return n or 1
    if layout == "team":
        return len(slide.get("members") or [])
    if layout == "awards":
        return len(slide.get("panels") or []) + (1 if slide.get("certificates") else 0)
    if layout == "results":
        return len(slide.get("columns") or [])
    if layout == "images":
        return 1
    if layout == "custom":
        count = 0
        for row in slide.get("rows") or []:
            for col in row.get("cols") or []:
                count += _nested_modules(col.get("blocks") or [])
        return max(1, count)
    return 0


def _nested_modules(blocks: list) -> int:
    count = 0
    for block in blocks:
        if block.get("kind") in ("card", "table", "flow", "metrics", "vlabel", "image", "images"):
            count += 1
        count += _nested_modules(block.get("body") or [])
    return count


def _zones(slide: dict) -> list[str]:
    tones = []
    for row in slide.get("rows") or []:
        for col in row.get("cols") or []:
            for block in col.get("blocks") or []:
                if block.get("kind") == "zone":
                    tones.append(str(block.get("tone", "ice")))
    return tones


def _is_dark(slide: dict, meta: dict) -> bool:
    t = slide.get("type")
    if t == "cover":
        return str(meta.get("coverStyle", "dark")) != "light"
    if t == "ending":
        return True
    if t == "divider":
        return str(slide.get("variant", "navy")) != "agenda"
    return False


def _load_tokens() -> dict:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "aesthetic-tokens.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def audit_deck(deck: dict, meta: dict) -> list[str]:
    tokens = _load_tokens()
    cfg = tokens.get("audit") or {}
    modules_max = int(cfg.get("modules_max", 4))
    red_max = int(cfg.get("red_spans_max", 3))
    bullets_max = int(cfg.get("bullets_max", 6))
    images_max = int(cfg.get("images_max", 4))
    images_max_catalogue = int(cfg.get("images_max_catalogue", 6))
    zones_max = int(cfg.get("zones_max", 3))
    zone_tones_max = int(cfg.get("zone_tones_max", 2))
    if str(meta.get("coverStyle", "dark")) == "light":
        dark_range = cfg.get("dark_page_ratio_light", [0.05, 0.25])
    else:
        dark_range = cfg.get("dark_page_ratio", [0.15, 0.25])

    slides = deck.get("slides") or []
    issues: list[str] = []
    rows = []
    dark = 0
    all_zone_tones: set[str] = set()
    for i, slide in enumerate(slides, start=1):
        dark += 1 if _is_dark(slide, meta) else 0
        layout = slide.get("layout") or slide.get("type")
        modules = _modules(slide)
        red = _red_spans(slide)
        bullets = _bullet_max(slide)
        images = _image_count(slide)
        zones = _zones(slide)
        all_zone_tones.update(zones)
        image_limit = images_max_catalogue if layout in ("images", "awards") else images_max
        flags = []
        if slide.get("type") == "content":
            if modules > modules_max:
                flags.append("modules")
                issues.append(f"[audit] slide {i}: modules {modules} > {modules_max}")
            if red > red_max:
                flags.append("red")
                issues.append(f"[audit] slide {i}: red spans {red} > {red_max}")
            if bullets > bullets_max:
                flags.append("bullets")
                issues.append(f"[audit] slide {i}: bullets {bullets} > {bullets_max}")
            if images > image_limit:
                flags.append("images")
                issues.append(f"[audit] slide {i}: images {images} > {image_limit}")
            if len(zones) > zones_max:
                flags.append("zones")
                issues.append(f"[audit] slide {i}: zones {len(zones)} > {zones_max}")
            for tone in zones:
                if tone not in layouts.ZONE_TONES:
                    flags.append("tone")
                    issues.append(f"[audit] slide {i}: unknown zone tone '{tone}'")
        rows.append((i, layout, modules, red, images, bullets, len(zones), flags))

    if len(all_zone_tones) > zone_tones_max:
        issues.append(f"[audit] zone tones {sorted(all_zone_tones)} > {zone_tones_max}")

    total = len(slides) or 1
    ratio = dark / total
    ok_dark = float(dark_range[0]) <= ratio <= float(dark_range[1])
    if not ok_dark:
        issues.append(f"[audit] dark pages {dark}/{total} = {ratio:.1%}, target {dark_range[0]:.0%}-{dark_range[1]:.0%}")

    print("\n[aesthetic audit]")
    print(f"{'page':>4}  {'layout':<14}{'modules':>8}{'red':>5}{'images':>7}{'bullets':>8}{'zones':>6}  status")
    for i, layout, modules, red, images, bullets, zones, flags in rows:
        status = "WARN " + ",".join(flags) if flags else "OK"
        print(f"{i:>4}  {str(layout):<14}{modules:>8}{red:>5}{images:>7}{bullets:>8}{zones:>6}  {status}")
    print(f"deep pages: {dark}/{total} = {ratio:.1%} (target {dark_range[0]:.0%}-{dark_range[1]:.0%}) {'OK' if ok_dark else 'WARN'}")
    if issues:
        print("\n".join(issues))
    else:
        print("aesthetic audit: pass")
    return issues


# ---------------------------------------------------------------- CLI

def _safe_name(meta: dict) -> str:
    if meta.get("outputName"):
        return str(meta["outputName"])
    lines = meta.get("titleLines") or [meta.get("title") or "科研项目汇报"]
    name = "".join(str(x) for x in lines)
    name = re.sub(r'[\\/:*?"<>|]', "", name).strip()
    return (name or "科研项目汇报")[:40]


def main() -> int:
    parser = argparse.ArgumentParser(description="科研项目类 PPT 渲染器")
    parser.add_argument("deck", help="deck.json 路径")
    parser.add_argument("-o", "--out", default="out", help="输出目录")
    parser.add_argument("--audit", action="store_true", help="输出美学量化审计表")
    parser.add_argument("--strict", action="store_true", help="审计不通过时返回非零退出码")
    args = parser.parse_args()
    if args.strict:
        args.audit = True

    with open(args.deck, "r", encoding="utf-8") as f:
        deck = json.load(f)
    meta = deck.get("meta") or {}
    meta.setdefault("sections", deck.get("sections") or [])
    slides = deck.get("slides") or []
    if not slides:
        print("deck.json 没有 slides", file=sys.stderr)
        return 2
    profile = FONT_PROFILES.get(str(meta.get("fontProfile", "office")), FONT_PROFILES["office"])
    base_dir = os.path.dirname(os.path.abspath(args.deck))

    sets = []
    warnings = []
    total = len(slides)
    for i, slide in enumerate(slides, start=1):
        els, warns = layouts.build_slide(slide, i, meta, base_dir, profile, total=total)
        sets.append(els)
        warnings.extend(warns)

    os.makedirs(args.out, exist_ok=True)
    try:
        pptx_path = os.path.join(args.out, _safe_name(meta) + ".pptx")
        render_pptx(sets, meta, pptx_path)
        print(f"PPTX: {pptx_path}")
    except ImportError as e:
        print(f"缺少 python-pptx：{e}. 运行 pip install python-pptx", file=sys.stderr)
        return 3

    issues = audit_deck(deck, meta) if args.audit else []

    if warnings:
        print("\n".join(warnings))
        print(f"\n共 {len(warnings)} 条警告，请调整 deck.json 后重新渲染。")
        return 1
    if args.strict and issues:
        print(f"\n美学审计未通过：{len(issues)} 项。")
        return 1
    tail = f"，美学审计 {len(issues)} 项" if args.audit else ""
    print(f"\n完成：{len(sets)} 页，无警告{tail}。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
