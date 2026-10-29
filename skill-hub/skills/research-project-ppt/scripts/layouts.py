#!/usr/bin/env python3
"""把 deck.json 的页面描述转换为绘图基元。"""

from __future__ import annotations

import math
from typing import Any

from deckkit import *  # noqa: F401,F403
import deckkit as dk

DEFAULT_SECTIONS = [
    {"no": "01", "title": "立项背景与总体思路"},
    {"no": "02", "title": "研究内容与技术路线"},
    {"no": "03", "title": "创新点与阶段性成果"},
    {"no": "04", "title": "下一步计划与条件保障"},
]


def build_slide(slide: dict, idx: int, meta: dict, base_dir: str, profile: dict,
                total: int = 0) -> tuple[list, list[str]]:
    sb = SB(idx, base_dir, profile)
    t = slide.get("type", "content")
    if t == "cover":
        build_cover(sb, slide, meta)
    elif t == "agenda":
        build_agenda(sb, slide, meta)
    elif t == "divider":
        if slide.get("variant", "navy") == "agenda":
            build_agenda(sb, slide, meta)
        else:
            build_divider(sb, slide, meta)
    elif t == "ending":
        build_ending(sb, slide, meta)
    else:
        build_content(sb, slide, idx=idx, total=total)
    return sb.els, sb.warn


# ---------------------------------------------------------------- cover

def _title_size(lines: list[str]) -> float:
    longest = max((len(x) for x in lines), default=10)
    if longest <= 11:
        return 82
    if longest <= 13:
        return 76
    if longest <= 15:
        return 70
    return 64


def _reporter_badge(sb: SB, text: str, y: float, dark=True) -> None:
    if not text:
        return
    size = 24
    text_w = sum(dk.char_w(ch, size, False) for ch in text) + 12
    bw = min(420, max(240, text_w + 76))
    x = (W - bw) / 2
    sb.rect(x, y, bw, 42, gradient=(90, [(0, "#1257AE"), (1, "#0A3F88")]),
            line="#7FB4E8", lw=1, radius=21)
    sb.text(x + 10, y, bw - 20, 42, text, size=size, color_name="white",
            align="center", valign="center", lh=1.2, tracking=1)
    line_y = y + 21
    start = MX + 36
    end = W - MX - 36
    sb.line(start, line_y, x - 18, line_y, color="#8FC0F0", width=1)
    sb.line(x + bw + 18, line_y, end, line_y, color="#8FC0F0", width=1)
    for k in range(3):
        sx = start + k * 11
        sb.line(sx, line_y - 7, sx + 8, line_y + 1, color="#8FC0F0", width=2)
        ex = end - k * 11
        sb.line(ex - 8, line_y + 1, ex, line_y - 7, color="#8FC0F0", width=2)


def build_cover(sb: SB, slide: dict, meta: dict) -> None:
    variant = slide.get("variant") or meta.get("coverStyle", "dark")
    if variant == "light":
        _cover_light(sb, meta)
    else:
        _cover_dark(sb, meta)


def _cover_dark(sb: SB, meta: dict) -> None:
    sb.rect(0, 0, W, H, gradient=(90, [(0, "#01276A"), (0.55, "#033B92"), (1, "#0750B4")]))
    for i in range(6):
        x = 860 + i * 30
        sb.line(x, 560, x + 150, 380, color="#1E5AA8", width=1)
    for i in range(4):
        y = 452 + i * 28
        sb.line(820, y, 1240, y, color="#1A539E", width=0.75)
    kicker = str(meta.get("kicker", ""))
    if kicker:
        sb.text(MX + 40, 38, CONTENT_W - 80, 30, kicker, size=19, color_name="white",
                align="center", valign="center", lh=1.2, tracking=1)
    lines = meta.get("titleLines") or [meta.get("title", "")]
    lines = [str(x) for x in lines if str(x)]
    size = _title_size(lines)
    ty = 96
    th = len(lines) * size * 1.12
    sb.text(MX + 20, ty, CONTENT_W - 40, th + 6, "\n".join(lines), size=size,
            color_name="white", family="serif", bold=True, align="center",
            valign="top", lh=1.12, tracking=1.5)
    accent = str(meta.get("titleAccent", ""))
    ay = ty + th + 4
    if accent:
        sb.text(MX + 20, ay, CONTENT_W - 40, 78 * 1.15, accent, size=78, color_name="gold",
                family="serif", bold=True, align="center", lh=1.15, tracking=1)
        title_bottom = ay + 90
    else:
        sb.rect(W / 2 - 90, ay + 18, 180, 3, fill=COLORS["gold"])
        title_bottom = ay + 32
    badge_y = min(430, max(392, title_bottom + 46))
    _reporter_badge(sb, str(meta.get("reporter", "")), badge_y, dark=True)
    band_y = 556
    sb.rect(0, band_y, W, H - band_y, fill=COLORS["white"])
    sb.rect(0, band_y, W, 1.5, fill="#DCE8F6")
    unit_lines = [str(u) for u in meta.get("unitLines", []) if str(u)]
    n = len(unit_lines)
    start_y = band_y + (H - band_y - n * 38) / 2 + 2
    for i, line in enumerate(unit_lines):
        label, _, value = line.partition("：")
        text = f"{label}：{value}" if value else line
        sb.text(MX + 60, start_y + i * 38, CONTENT_W - 120, 34, text, size=22,
                color_name="ink", bold=True, align="center", valign="center", lh=1.3)


def _cover_light(sb: SB, meta: dict) -> None:
    sb.rect(0, 0, W, H, fill=COLORS["white"])
    sb.rect(0, 0, W, 260, fill="#F3F8FE")
    sb.rect(0, 0, W, 120, fill="#EAF4FD")
    sb.rect(0, 570, W, 150, fill="#F7FAFE")
    kicker = str(meta.get("kicker", ""))
    if kicker:
        sb.text(MX + 60, 42, CONTENT_W - 120, 26, kicker, size=18, color_name="azure",
                align="center", valign="center", lh=1.2, tracking=1)
    lines = meta.get("titleLines") or [meta.get("title", "")]
    lines = [str(x) for x in lines if str(x)]
    size = min(78, _title_size(lines))
    th = len(lines) * size * 1.16
    sb.text(MX + 30, 120, CONTENT_W - 60, th + 4, "\n".join(lines), size=size,
            color_name="navy", family="serif", bold=True, align="center",
            valign="top", lh=1.16, tracking=1.5)
    y = 120 + th + 8
    if meta.get("subtitle"):
        sb.text(MX + 60, y, CONTENT_W - 120, 40, str(meta["subtitle"]), size=30,
                color_name="blue", family="serif", bold=True, align="center", lh=1.25)
        y += 44
    sb.line(W / 2 - 150, y + 12, W / 2 + 150, y + 12, color="#BBD6F2", width=1)
    rep = str(meta.get("reporter", ""))
    if rep:
        sb.text(W / 2 - 260, y + 28, 80, 30, "‹‹", size=22, color_name="azure",
                align="right", valign="center", lh=1.2)
        sb.text(W / 2 - 170, y + 24, 340, 36, rep, size=24, color_name="navy",
                bold=True, align="center", valign="center", lh=1.2, tracking=1)
        sb.text(W / 2 + 180, y + 28, 80, 30, "››", size=22, color_name="azure",
                align="left", valign="center", lh=1.2)
    units = [str(u) for u in meta.get("units", []) if str(u)]
    if units:
        n = len(units)
        uw = CONTENT_W / n
        for i, u in enumerate(units):
            sb.text(MX + i * uw + 6, 566, uw - 12, 26, u, size=17, color_name="gray",
                    align="center", valign="center", lh=1.3)
            if i < n - 1:
                sb.line(MX + (i + 1) * uw, 570, MX + (i + 1) * uw, 608, color="#C9D6E8", width=1)
    sb.rect(-80, 638, 1440, 190, gradient=(90, [(0, "#2E75B6"), (1, "#0B4FA8")]), radius=80)
    sb.rect(-80, 690, 1440, 140, fill="#0B4FA8", radius=60)


# ---------------------------------------------------------------- agenda / divider

def build_agenda(sb: SB, slide: dict, meta: dict) -> None:
    sections = meta.get("sections") or DEFAULT_SECTIONS
    active = slide.get("active")
    sb.rect(0, 0, W, H, fill=COLORS["white"])
    sb.rect(360, 0, 920, H, fill="#FBFCFE")
    sb.rect(360, 0, W - 360, 180, fill="#F6FAFF")
    sb.rect(0, 0, 360, H, gradient=(90, [(0, "#0440A0"), (1, "#01296E")]))
    for i in range(4):
        sb.line(20 + i * 20, 690, 180 + i * 20, 520, color="#1A5FB4", width=1)
    vertical_chars(sb, 96, 118, 140, 356, "汇报提纲", 62, "white", family="serif", tracking=6)
    sb.text(252, 300, 22, 160, "\n".join(list("CONTENTS")), size=11, color_name="#A9CDF2",
            align="center", lh=1.55, tracking=2)
    _agenda_items(sb, sections, active, 430, 118, 600, 76, 20, dark=False)
    sb.line(360, 0, 360, H, color="#0B4FA8", width=1)


def build_divider(sb: SB, slide: dict, meta: dict) -> None:
    sections = meta.get("sections") or DEFAULT_SECTIONS
    active = slide.get("active")
    sb.rect(0, 0, W, H, gradient=(90, [(0, "#012B72"), (1, "#0547A2")]))
    for i in range(10):
        sb.line(760 + i * 34, 720, 940 + i * 34, 420, color="#1F5EB0", width=0.75)
    sb.rect(0, 0, 430, H, gradient=(90, [(0, "#01225E"), (1, "#023890")]))
    vertical_chars(sb, 92, 120, 140, 356, "汇报提纲", 62, "white", family="serif", tracking=6)
    sb.text(250, 300, 22, 160, "\n".join(list("CONTENTS")), size=11, color_name="#8FC0F0",
            align="center", lh=1.55, tracking=2)
    _agenda_items(sb, sections, active, 470, 118, 660, 76, 20, dark=True)


def _agenda_items(sb: SB, sections, active, x, y, w, h, gap, dark) -> None:
    for i, sec in enumerate(sections[:4]):
        yy = y + i * (h + gap)
        on = (active == i)
        if on:
            sb.rect(x, yy, w, h, gradient=(90, [(0, "#1257AE"), (1, "#0A3F88")]), radius=6)
            if dark:
                sb.rect(x, yy, 4, h, fill=COLORS["gold"], radius=2)
            num_color, title_color, div_color = COLORS["white"], COLORS["white"], "#8FC0F0"
        elif dark:
            sb.rect(x, yy, w, h, fill="#0A3A80", line="#2F6BB8", lw=1, radius=6)
            num_color, title_color, div_color = "#8FC0F0", "#D6E4F7", "#4E86C8"
        else:
            sb.rect(x, yy, w, h, fill=COLORS["white"], line="#E3EAF4", lw=1, radius=6)
            num_color, title_color, div_color = "#C3CCD9", "#B9C3D2", "#D5DCE7"
        sb.text(x + 24, yy, 64, h, str(sec.get("no", f"{i + 1:02d}")), size=28,
                color_name=num_color, bold=True, align="left", valign="center", lh=1.1)
        sb.line(x + 92, yy + 22, x + 92, yy + h - 22, color=div_color, width=1)
        sb.text(x + 110, yy, w - 130, h, str(sec.get("title", "")), size=25,
                color_name=title_color, bold=True, align="left", valign="center",
                lh=1.2, tracking=4)


# ---------------------------------------------------------------- ending

def build_ending(sb: SB, slide: dict, meta: dict) -> None:
    sb.rect(0, 0, W, H, gradient=(90, [(0, "#01276A"), (1, "#0750B4")]))
    for i in range(9):
        sb.line(860 + i * 26, 560, 1010 + i * 26, 380, color="#1E5AA8", width=1)
    kicker = str(meta.get("kicker", ""))
    if kicker:
        sb.text(MX + 50, 34, CONTENT_W - 100, 28, kicker, size=18, color_name="#D9E8F8",
                align="center", valign="center", lh=1.2, tracking=1)
    thanks = slide.get("lines") or ["感谢各位领导专家", "敬请批评指正！"]
    sb.text(MX + 20, 104, CONTENT_W - 40, 2 * 76 * 1.15, "\n".join(thanks), size=76,
            color_name="white", family="serif", bold=True, align="center", lh=1.15,
            tracking=1.5)
    sb.rect(W / 2 - 100, 300, 200, 3, fill=COLORS["gold"])
    _reporter_badge(sb, str(meta.get("reporter", "")), 350, dark=True)
    band_y = 556
    sb.rect(0, band_y, W, H - band_y, fill=COLORS["white"])
    sb.rect(0, band_y, W, 1.5, fill="#DCE8F6")
    unit_lines = [str(u) for u in meta.get("unitLines", []) if str(u)]
    if not unit_lines and meta.get("units"):
        units = [str(u) for u in meta["units"] if str(u)]
        unit_lines = ["    |    ".join(units[:3])]
        if len(units) > 3:
            unit_lines.append("    |    ".join(units[3:]))
    n = len(unit_lines)
    start_y = band_y + (H - band_y - n * 38) / 2 + 2
    for i, line in enumerate(unit_lines):
        label, _, value = line.partition("：")
        text = f"{label}：{value}" if value else line
        sb.text(MX + 60, start_y + i * 38, CONTENT_W - 120, 34, text, size=21,
                color_name="ink", bold=True, align="center", valign="center", lh=1.3)


# ---------------------------------------------------------------- content

def build_content(sb: SB, slide: dict, idx: int = 0, total: int = 0) -> None:
    layout = slide.get("layout", "custom")
    page_bg(sb)
    page_header(sb, str(slide.get("no", "")), str(slide.get("title", "")))
    has_banner = bool(slide.get("banner"))
    if has_banner:
        page_banner(sb, str(slide["banner"]))
    has_conclusion = bool(slide.get("conclusion"))
    if has_conclusion:
        page_conclusion(sb, str(slide["conclusion"]))
    x, y, w, h = content_area(has_banner, has_conclusion)
    if slide.get("intro"):
        intro_h = _intro(sb, slide["intro"], x, y, w)
        y += intro_h + 12
        h -= intro_h + 12
    if slide.get("notes"):
        page_footer(sb, idx, total, notes=slide["notes"])
    elif total:
        page_footer(sb, idx, total)
    builder = {
        "table": _content_table,
        "split": _content_split,
        "flow": _content_flow,
        "intro-cards": _content_intro_cards,
        "roadmap": _content_roadmap,
        "metrics": _content_metrics,
        "profile": _content_profile,
        "team": _content_team,
        "awards": _content_awards,
        "results": _content_results,
        "images": _content_images,
        "custom": _content_custom,
    }.get(layout)
    if builder is None:
        sb.warn_msg(f"unknown layout {layout}")
        builder = _content_custom
    builder(sb, slide, x, y, w, h)


def _intro(sb: SB, intro, x, y, w) -> float:
    items = [str(i) for i in intro if str(i)]
    n = len(items)
    h = 18 + n * 23
    sb.rect(x, y, w, h, fill="#F8FBFE", line="#DCE8F6", lw=1, radius=3)
    sb.rect(x, y, 4, h, fill=COLORS["royal"])
    sb.bullets(x + 14, y + 9, w - 24, h - 14, items, size=14, marker="dot", lh=1.55)
    return h


def _content_table(sb: SB, slide: dict, x, y, w, h) -> None:
    spec = slide.get("table") or {}
    cols = spec.get("cols") or []
    rows = spec.get("rows") or []
    if not cols:
        sb.warn_msg("table layout without cols")
        return
    row_h = float(spec.get("rowH", 32))
    header_h = float(spec.get("headerH", 30))
    th = header_h + len(rows) * row_h
    if th > h + 1:
        sb.warn_msg(f"table height {th:.0f}px exceeds content {h:.0f}px")
    sb.table(x, y, w, cols, rows, row_h=row_h, header_h=header_h, font_size=12,
             align=spec.get("align"), first_col_bold=spec.get("firstColBold", True))
    extra_y = y + th + 14
    extra_h = h - th - 14
    bottom = slide.get("bottomCards") or []
    if bottom and extra_h > 80:
        reserve = 34 if slide.get("notes") else 0
        _bottom_cards(sb, bottom, x, extra_y, w, max(80, extra_h - reserve))
    elif extra_h > 40:
        _bottom_notes(sb, slide, x, extra_y, w, extra_h)


def _bottom_cards(sb: SB, cards, x, y, w, h) -> None:
    n = max(1, min(3, len(cards)))
    gap = 14
    cw = (w - gap * (n - 1)) / n
    max_bullets = max((len(c.get("bullets", [])) for c in cards[:n]), default=3)
    ch = min(h, max(140, 46 + max_bullets * 24))
    oy = y + max(0, (h - ch) / 2) if h > ch else y
    for i, c in enumerate(cards[:n]):
        bx, by, bw, bh = card(sb, x + i * (cw + gap), oy, cw, ch, str(c.get("title", "")), style="outline")
        sb.bullets(bx, by, bw, bh, [str(b) for b in c.get("bullets", [])], size=12.2, lh=1.6,
                   valign="center")


def _bottom_notes(sb: SB, slide, x, y, w, h) -> None:
    points = slide.get("points") or []
    if not points:
        return
    note_box(sb, x, y, w, h, "", tone="light")
    sb.bullets(x + 16, y + 8, w - 28, h - 16, [str(p) for p in points], size=12.5,
               marker="chevron", lh=1.6, valign="center")


def _content_split(sb: SB, slide: dict, x, y, w, h) -> None:
    gap = 14
    cw = (w - gap) / 2
    for i, key in enumerate(("left", "right")):
        spec = slide.get(key) or {}
        cx = x + i * (cw + gap)
        bx, by, bw, bh = card(sb, cx, y, cw, h, str(spec.get("title", "")), style="solid")
        img = spec.get("image")
        bullets = [str(b) for b in spec.get("bullets", []) if str(b)]
        pos = spec.get("imagePosition", "bottom")
        if img:
            cap_h = 18 if img.get("caption") else 0
            ih = min(230, bh * 0.54)
            if pos == "top":
                sb.image(bx, by, bw, ih, str(img.get("src", "")), fit=str(img.get("fit", "cover")))
                if img.get("caption"):
                    caption(sb, bx, by + ih + 2, bw, str(img["caption"]))
                ty = by + ih + cap_h + 8
                sb.bullets(bx, ty, bw, by + bh - ty, bullets, size=13.2, lh=1.65, valign="center")
            else:
                bh_bullets = bh - ih - cap_h - 8
                sb.bullets(bx, by, bw, bh_bullets, bullets, size=13.2, lh=1.65, valign="center")
                iy = by + bh - ih
                sb.image(bx, iy, bw, ih, str(img.get("src", "")), fit=str(img.get("fit", "cover")))
                if img.get("caption"):
                    caption(sb, bx, iy - 16, bw, str(img["caption"]))
        else:
            sb.bullets(bx, by, bw, bh, bullets, size=14.5, lh=1.85, valign="center")


def _content_flow(sb: SB, slide: dict, x, y, w, h) -> None:
    steps = slide.get("steps") or []
    if not steps:
        sb.warn_msg("flow layout without steps")
        return
    fh = 108
    flow_steps(sb, x, y, w, fh, steps)
    cards = slide.get("cards") or []
    if not cards:
        return
    cy = y + fh + 16
    ch = h - fh - 16
    n = min(3, len(cards))
    gap = 14
    cw = (w - gap * (n - 1)) / n
    for i, c in enumerate(cards[:n]):
        bx, by, bw, bh = card(sb, x + i * (cw + gap), cy, cw, ch, str(c.get("title", "")))
        img = c.get("image")
        bullets = [str(b) for b in c.get("bullets", [])]
        if img:
            cap = 18 if img.get("caption") else 0
            ih = min(190, bh * 0.46)
            sb.bullets(bx, by, bw, bh - ih - cap - 8, bullets, size=12.5, lh=1.7,
                       valign="center")
            iy = by + bh - ih
            sb.image(bx, iy, bw, ih, str(img.get("src", "")), fit=str(img.get("fit", "contain")))
            if img.get("caption"):
                caption(sb, bx, iy - 16, bw, str(img["caption"]))
        else:
            sb.bullets(bx, by, bw, bh, bullets, size=13, lh=1.7, valign="center")


def _content_intro_cards(sb: SB, slide: dict, x, y, w, h) -> None:
    cards = slide.get("cards") or []
    n = len(cards)
    if not n:
        sb.warn_msg("intro-cards without cards")
        return
    gap = 14
    cw = (w - gap * (n - 1)) / n
    for i, c in enumerate(cards):
        cx = x + i * (cw + gap)
        bx, by, bw, bh = card(sb, cx, y, cw, h, str(c.get("title", "")))
        img = c.get("image")
        bullets = [str(b) for b in c.get("bullets", [])]
        if img:
            cap = 18 if img.get("caption") else 0
            ih = min(230, bh * 0.5)
            sb.image(bx, by, bw, ih, str(img.get("src", "")), fit=str(img.get("fit", "cover")))
            if img.get("caption"):
                caption(sb, bx, by + ih + 2, bw, str(img["caption"]))
            sb.bullets(bx, by + ih + cap + 8, bw, bh - ih - cap - 8, bullets, size=12.2,
                       lh=1.6, valign="top")
        else:
            sb.bullets(bx, by, bw, bh, bullets, size=13, lh=1.8, valign="center")


def _content_roadmap(sb: SB, slide: dict, x, y, w, h) -> None:
    spec = slide.get("table") or {}
    cols = spec.get("cols") or []
    rows = spec.get("rows") or []
    row_h = float(spec.get("rowH", 34))
    th = 30 + len(rows) * row_h
    sb.table(x, y, w, cols, rows, row_h=row_h, header_h=30, font_size=12,
             align=spec.get("align"), first_col_bold=True)
    stages = slide.get("stages") or []
    sy = y + th + 22
    sh = h - th - 22
    n = max(1, len(stages))
    sw = w / n
    sb.rect(x, sy, w, sh, fill="#FAFCFE", line="#E6EEF8", lw=1, radius=3)
    block_top = sy + max(24, (sh - 190) / 2)
    for i, st in enumerate(stages):
        cx = x + i * sw
        if i > 0:
            sb.line(cx, sy + 14, cx, sy + sh - 14, color="#C9D6E8", width=1, dash="dash")
        sb.rect(cx + sw / 2 - 46, block_top, 92, 26, fill=COLORS["ice"], line="#DCE8F6", lw=1, radius=13)
        sb.text(cx + sw / 2 - 46, block_top, 92, 26, str(st.get("period", "")), size=12,
                color_name="blue", bold=True, align="center", valign="center", lh=1.1)
        sb.text(cx + 20, block_top + 40, sw - 40, 54, str(st.get("title", "")), size=18,
                color_name="textNavy", bold=True, align="center", lh=1.3)
        sb.text(cx + 20, block_top + 100, sw - 40, 70, str(st.get("desc", "")), size=11.5,
                color_name="gray", align="center", lh=1.5)
        sb.tri(cx + sw / 2 - 7, block_top + 176, 14, 14, COLORS["royal"], "down")


def _content_metrics(sb: SB, slide: dict, x, y, w, h) -> None:
    items = slide.get("metrics") or []
    if items:
        metric_tiles(sb, x, y, w, 100, items)
        cy = y + 116
        ch = h - 116
    else:
        cy, ch = y, h
    cards = slide.get("cards") or []
    if cards:
        n = min(2, len(cards))
        gap = 14
        cw = (w - gap * (n - 1)) / n
        for i, c in enumerate(cards[:n]):
            bx, by, bw, bh = card(sb, x + i * (cw + gap), cy, cw, ch, str(c.get("title", "")))
            img = c.get("image")
            bullets = [str(b) for b in c.get("bullets", [])]
            if img:
                cap = 18 if img.get("caption") else 0
                ih = min(220, bh * 0.5)
                sb.bullets(bx, by, bw, bh - ih - cap - 8, bullets, size=12.8, lh=1.7,
                           valign="center")
                iy = by + bh - ih
                sb.image(bx, iy, bw, ih, str(img.get("src", "")), fit=str(img.get("fit", "contain")))
                if img.get("caption"):
                    caption(sb, bx, iy - 16, bw, str(img["caption"]))
            else:
                sb.bullets(bx, by, bw, bh, bullets, size=13, lh=1.7, valign="center")


def _content_profile(sb: SB, slide: dict, x, y, w, h) -> None:
    spec = slide.get("profile") or {}
    photo_w, photo_h = 220, 275
    if spec.get("photo"):
        sb.image(x, y, photo_w, photo_h, str(spec["photo"]), fit="cover")
    else:
        _photo_placeholder(sb, x, y, photo_w, photo_h, size=14)
    name = str(spec.get("name", ""))
    title = str(spec.get("title", ""))
    sb.text(x - 10, y + photo_h + 10, photo_w + 20, 34, name, size=26, color_name="navy",
            family="serif", bold=True, align="center", lh=1.2, tracking=2)
    sb.text(x - 10, y + photo_h + 46, photo_w + 20, 20, title, size=11.5, color_name="gray",
            align="center", lh=1.2)
    rx = x + photo_w + 24
    rw = w - photo_w - 24
    direction = str(spec.get("direction", ""))
    if direction:
        sb.rect(rx, y, rw, 36, fill=COLORS["ice"], line="#DCE8F6", lw=1, radius=3)
        sb.rect(rx, y, 4, 36, fill=COLORS["royal"])
        sb.text(rx + 14, y, rw - 20, 36, direction, size=14, color_name="ink",
                valign="center", lh=1.4)
        ry = y + 48
    else:
        ry = y
    edu = spec.get("education") or {}
    if edu.get("rows"):
        eh = _label_table(sb, rx, ry, rw, "教育经历", edu)
        ry += eh + 14
    ach = spec.get("achievements") or {}
    if ach.get("rows"):
        _label_table(sb, rx, ry, rw, "成果列表", ach)


def _label_table(sb: SB, x, y, w, label, spec) -> float:
    cols = spec.get("cols") or []
    rows = spec.get("rows") or []
    row_h = float(spec.get("rowH", 34))
    th = 30 + len(rows) * row_h
    lw = 44
    vertical_label(sb, x, y, lw, th, label)
    sb.table(x + lw + 6, y, w - lw - 6, cols, rows, row_h=row_h, header_h=30, font_size=11.5,
             align=spec.get("align"), first_col_bold=False)
    return th


def _photo_placeholder(sb: SB, x, y, w, h, size=12) -> None:
    sb.rect(x, y, w, h, fill=COLORS["ice"], line=COLORS["border"], lw=1, radius=2)
    sb.text(x, y, w, h, "照片", size=size, color_name="lgray", align="center", valign="center")


def _content_team(sb: SB, slide: dict, x, y, w, h) -> None:
    members = slide.get("members") or []
    n = max(1, len(members))
    plat_h = 54 if slide.get("platform") else 0
    max_ch = h - plat_h - (14 if plat_h else 0)
    ch = min(max(140, max_ch), 340)
    group_h = ch + (14 + plat_h if plat_h else 0)
    oy = y + 20 if h - group_h > 60 else y + max(0, (h - group_h) / 2)
    gap = 12
    cw = (w - gap * (n - 1)) / n
    for i, m in enumerate(members):
        cx = x + i * (cw + gap)
        sb.rect(cx, oy, cw, ch, fill=COLORS["white"], line=COLORS["border"], lw=1, radius=3)
        if m.get("photo"):
            sb.image(cx + 12, oy + 12, 94, 120, str(m["photo"]), fit="cover")
        else:
            _photo_placeholder(sb, cx + 12, oy + 12, 94, 120, size=10.5)
        sb.text(cx + 116, oy + 16, cw - 126, 28, str(m.get("name", "")), size=19,
                color_name="navy", family="serif", bold=True, lh=1.2)
        sb.text(cx + 116, oy + 48, cw - 126, 46, str(m.get("role", "")), size=10.8,
                color_name="gray", lh=1.4)
        sb.rect(cx + 12, oy + 140, cw - 24, 1, fill="#E6EEF8")
        sb.bullets(cx + 12, oy + 148, cw - 24, ch - 158,
                   [str(b) for b in m.get("bullets", [])], size=12, lh=1.7, valign="top")
    if slide.get("platform"):
        py = oy + ch + 14
        sb.rect(x, py, w, plat_h, fill=COLORS["ice"], line="#DCE8F6", lw=1, radius=3)
        sb.rect(x, py, 4, plat_h, fill=COLORS["royal"])
        sb.text(x + 16, py, w - 26, plat_h, str(slide["platform"]), size=13,
                color_name="ink", valign="center", lh=1.5)


def _content_awards(sb: SB, slide: dict, x, y, w, h) -> None:
    panels = slide.get("panels") or []
    certs = slide.get("certificates") or []
    cert_h = 160 if certs else 0
    ph = min(max(120, h - cert_h - 14), 260) if certs else h
    group_h = ph + cert_h + (14 if certs else 0)
    oy = y + max(0, (h - group_h) / 2)
    n = max(1, min(2, len(panels)))
    gap = 14
    pw = (w - gap * (n - 1)) / n
    for i, p in enumerate(panels[:2]):
        px = x + i * (pw + gap)
        bx, by, bw, bh = card(sb, px, oy, pw, ph, str(p.get("title", "")), style="outline")
        sb.bullets(bx, by, bw, bh, [str(b) for b in p.get("bullets", [])], size=12.5, lh=1.6)
    if certs:
        cy = oy + ph + 14
        n = len(certs)
        cw = (w - 8 * (n - 1)) / n
        for i, c in enumerate(certs):
            cx = x + i * (cw + 8)
            sb.image(cx, cy, cw, cert_h - 18, str(c.get("src", "")), fit="contain")
            caption(sb, cx, cy + cert_h - 18, cw, str(c.get("caption", "")))


def _content_results(sb: SB, slide: dict, x, y, w, h) -> None:
    cols = slide.get("columns") or []
    n = max(1, len(cols))
    gap = 14
    cw = (w - gap * (n - 1)) / n
    for i, col in enumerate(cols):
        cx = x + i * (cw + gap)
        bx, by, bw, bh = card(sb, cx, y, cw, h, str(col.get("title", "")))
        img = col.get("image")
        bullets = [str(b) for b in col.get("bullets", [])]
        if img:
            ih = min(240, bh * 0.52)
            sb.bullets(bx, by, bw, bh - ih - 18, bullets, size=12.8, lh=1.7, valign="center")
            sb.image(bx, by + bh - ih, bw, ih, str(img.get("src", "")), fit="contain")
            if img.get("caption"):
                caption(sb, bx, by + bh - ih - 16, bw, str(img["caption"]))
        else:
            sb.bullets(bx, by, bw, bh, bullets, size=13, lh=1.7, valign="center")


def _content_images(sb: SB, slide: dict, x, y, w, h) -> None:
    imgs = slide.get("images") or []
    n = len(imgs)
    if not n:
        sb.warn_msg("images layout without images")
        return
    if n <= 2:
        cols, rows = n, 1
    elif n == 3:
        cols, rows = 3, 1
    else:
        cols, rows = 2, 2
    gap = 14
    igh = (h - gap * (rows - 1)) / rows
    igw = (w - gap * (cols - 1)) / cols
    for i, img in enumerate(imgs[:6]):
        r, c = divmod(i, cols)
        ix = x + c * (igw + gap)
        iy = y + r * (igh + gap)
        sb.rect(ix, iy, igw, igh, fill=COLORS["white"], line=COLORS["border"], lw=1, radius=3)
        ih = igh - 42
        sb.image(ix + 10, iy + 10, igw - 20, ih, str(img.get("src", "")), fit=str(img.get("fit", "cover")))
        caption(sb, ix + 10, iy + ih + 14, igw - 20, str(img.get("caption", "")))
        if img.get("note"):
            sb.text(ix + 10, iy + ih + 30, igw - 20, 14, str(img["note"]), size=10,
                    color_name="gray", align="center", lh=1.2)


# ---------------------------------------------------------------- custom

def _content_custom(sb: SB, slide: dict, x, y, w, h) -> None:
    rows = slide.get("rows") or []
    if not rows:
        return
    fixed = sum(float(r["h"]) for r in rows if "h" in r)
    frs = sum(float(r.get("fr", 1)) for r in rows if "h" not in r)
    remaining = max(0, h - fixed - sum(float(r.get("gap", 12)) for r in rows[:-1]))
    heights = []
    for r in rows:
        if "h" in r:
            heights.append(float(r["h"]))
        else:
            heights.append(remaining * float(r.get("fr", 1)) / (frs or 1))
    cy = y
    for i, row in enumerate(rows):
        rh = heights[i]
        cols = row.get("cols") or []
        if not cols:
            cy += rh + float(row.get("gap", 12))
            continue
        weights = [float(c.get("w", 1)) for c in cols]
        total = sum(weights) or 1
        cx = x
        avail_w = w - 12 * (len(cols) - 1)
        for c, wt in zip(cols, weights):
            cw = avail_w * wt / total
            _layout_blocks(sb, c.get("blocks") or [], cx, cy, cw, rh)
            cx += cw + 12
        cy += rh + float(row.get("gap", 12))


def _text_h(content: str, w: float, size: float, lh: float) -> float:
    runs = parse_markup(str(content), size, FONT_SANS, COLORS["ink"])
    lines = wrap_runs(runs, w)
    return max(1, len(lines)) * size * lh + 2


def _intrinsic(block: dict, w: float) -> float:
    kind = block.get("kind")
    if kind == "text":
        return float(block.get("h", _text_h(block.get("text", ""), w, float(block.get("size", 15)), 1.5)))
    if kind == "bullets":
        size = float(block.get("size", 14.5))
        n = 0
        for item in block.get("items", []):
            runs = parse_markup(str(item), size, FONT_SANS, COLORS["ink"])
            n += max(1, len(wrap_runs(runs, w - size * 1.4)))
        return n * size * 1.55 + 4
    if kind == "note":
        return 22 + _text_h(block.get("text", ""), w - 24, float(block.get("size", 12.5)), 1.5)
    if kind == "table":
        return 30 + len(block.get("rows", [])) * float(block.get("rowH", 30))
    if kind == "flow":
        return 122
    if kind == "metrics":
        return 100
    if kind == "tags":
        return 30
    if kind == "bars":
        return 12 + len(block.get("items", [])) * 30
    if kind == "spacer":
        return float(block.get("h", 8))
    if kind == "card":
        body = block.get("body") or []
        inner_h = sum(_intrinsic(b, w - 24) for b in body) + 10 * max(0, len(body) - 1)
        return 30 + 20 + inner_h
    if kind == "zone":
        body = block.get("body") or []
        inner_h = sum(_intrinsic(b, w - 24) for b in body) + 10 * max(0, len(body) - 1)
        return (20 if block.get("label") else 0) + 24 + inner_h
    if kind == "vlabel":
        body = block.get("body") or []
        return max(90, sum(_intrinsic(b, w - 70) for b in body))
    if kind == "image":
        return float(block.get("h", 150))
    if kind == "images":
        return float(block.get("h", 160))
    return 40


def _layout_blocks(sb: SB, blocks: list, x, y, w, h) -> None:
    if not blocks:
        return
    gap = 10
    fill_kinds = ("image", "images", "card", "vlabel", "zone")
    fr_blocks = [b for b in blocks if "h" not in b and ("fr" in b or b.get("kind") in fill_kinds)]
    fr_ids = {id(b) for b in fr_blocks}
    fixed = 0.0
    for b in blocks:
        if "h" in b:
            fixed += float(b["h"])
        elif id(b) not in fr_ids:
            fixed += _intrinsic(b, w)
    frs = sum(float(b.get("fr", 1)) for b in fr_blocks) or 1
    remaining = max(0, h - fixed - gap * (len(blocks) - 1))
    heights = []
    for b in blocks:
        if "h" in b:
            heights.append(float(b["h"]))
        elif id(b) in fr_ids:
            heights.append(remaining * float(b.get("fr", 1)) / frs)
        else:
            heights.append(_intrinsic(b, w))
        if heights[-1] <= 0:
            heights[-1] = 30
    cy = y
    for b, bh in zip(blocks, heights):
        kind = b.get("kind")
        if kind == "text":
            sb.text(x, cy, w, bh, str(b.get("text", "")), size=float(b.get("size", 15)),
                    color_name=str(b.get("color", "ink")), bold=bool(b.get("bold")),
                    align=str(b.get("align", "left")), lh=float(b.get("lh", 1.5)))
        elif kind == "bullets":
            sb.bullets(x, cy, w, bh, [str(i) for i in b.get("items", [])],
                       size=float(b.get("size", 14.5)), marker=str(b.get("marker", "chevron")),
                       lh=1.55)
        elif kind == "note":
            note_box(sb, x, cy, w, bh, str(b.get("text", "")), tone=str(b.get("tone", "light")))
        elif kind == "card":
            bx, by, bw, bhh = card(sb, x, cy, w, bh, str(b.get("title", "")),
                                   style=str(b.get("style", "solid")))
            _layout_blocks(sb, b.get("body") or [], bx, by, bw, bhh)
        elif kind == "zone":
            fill, edge = ZONE_TONES.get(str(b.get("tone", "ice")), ZONE_TONES["ice"])
            if w * bh > 0.25 * W * H:
                sb.warn_msg(f"zone covers {w * bh / (W * H):.0%} of page > 25%")
            sb.rect(x, cy, w, bh, fill=fill, line=edge, lw=0.75, radius=4, dash="dash")
            inner_y, top = cy + 12, 22
            if b.get("label"):
                sb.text(x + 12, cy + 8, w - 24, 18, str(b["label"]), size=10.5,
                        color_name="gray", bold=True, lh=1.1)
                inner_y, top = cy + 30, 42
            _layout_blocks(sb, b.get("body") or [], x + 12, inner_y, w - 24, bh - top)
        elif kind == "table":
            sb.table(x, cy, w, b.get("cols") or [], b.get("rows") or [],
                     row_h=float(b.get("rowH", 30)), header_h=float(b.get("headerH", 30)),
                     font_size=float(b.get("fontSize", 11.5)),
                     align=b.get("align"), first_col_bold=b.get("firstColBold", True))
        elif kind == "flow":
            flow_steps(sb, x, cy, w, bh, b.get("steps") or [])
        elif kind == "metrics":
            metric_tiles(sb, x, cy, w, bh, b.get("items") or [])
        elif kind == "tags":
            _tags(sb, x, cy, w, b.get("items") or [])
        elif kind == "vlabel":
            lw = 56
            vertical_label(sb, x, cy, lw, bh, str(b.get("label", "")))
            _layout_blocks(sb, b.get("body") or [], x + lw + 10, cy, w - lw - 10, bh)
        elif kind == "bars":
            _bars(sb, x, cy, w, bh, b.get("items") or [], float(b.get("max", 100)))
        elif kind == "image":
            img = b
            cap = 18 if img.get("caption") else 0
            sb.image(x, cy, w, bh - cap, str(img.get("src", "")), fit=str(img.get("fit", "cover")))
            if img.get("caption"):
                caption(sb, x, cy + bh - cap, w, str(img["caption"]))
        elif kind == "images":
            _images_grid(sb, x, cy, w, bh, b.get("items") or [], int(b.get("cols", 3)))
        elif kind == "spacer":
            pass
        cy += bh + 10


def _tags(sb: SB, x, y, w, items) -> None:
    cx, cy = x, y
    for item in items[:8]:
        text = str(item)
        tw = sum(dk.char_w(ch, 11) for ch in text) + 22
        if cx + tw > x + w:
            cx = x
            cy += 32
        sb.rect(cx, cy, tw, 26, fill=COLORS["ice"], line="#DCE8F6", lw=1, radius=13)
        sb.text(cx, cy, tw, 26, text, size=11, color_name="textNavy", align="center",
                valign="center", lh=1.1)
        cx += tw + 8


def _bars(sb: SB, x, y, w, h, items, maxv) -> None:
    label_w = 96
    val_w = 66
    bw = w - label_w - val_w - 16
    for i, it in enumerate(items):
        by = y + i * 30
        sb.text(x, by, label_w, 22, str(it.get("label", "")), size=11.5, color_name="textNavy",
                bold=True, valign="center", lh=1.2)
        sb.rect(x + label_w, by + 4, bw, 14, fill="#EDF2F8", radius=7)
        v = float(it.get("value", 0))
        frac = max(0.02, min(1, v / maxv if maxv else 0))
        sb.rect(x + label_w, by + 4, bw * frac, 14,
                fill=color(str(it.get("color", "green"))), radius=7)
        sb.text(x + label_w + bw + 8, by, val_w, 22, str(it.get("valueText", it.get("value", ""))),
                size=11, color_name="gray", align="right", valign="center", lh=1.2)


def _images_grid(sb: SB, x, y, w, h, items, cols) -> None:
    n = len(items)
    if not n:
        return
    cols = max(1, min(cols, n))
    rows = math.ceil(n / cols)
    gap = 8
    cw = (w - gap * (cols - 1)) / cols
    ch = (h - gap * (rows - 1)) / rows
    for i, it in enumerate(items):
        r, c = divmod(i, cols)
        ix = x + c * (cw + gap)
        iy = y + r * (ch + gap)
        cap = 16 if it.get("caption") else 0
        sb.image(ix, iy, cw, ch - cap, str(it.get("src", "")), fit=str(it.get("fit", "cover")))
        if it.get("caption"):
            caption(sb, ix, iy + ch - cap, cw, str(it["caption"]))
