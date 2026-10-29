#!/usr/bin/env python3
"""科研项目类 PPT 的绘图基元、文本排布与共享版式辅助。"""

from __future__ import annotations

import os
import re
import tempfile
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional

W, H = 1280, 720
MX = 40
CONTENT_W = W - MX * 2

COLORS = {
    "navy": "#003F9E",
    "navyDeep": "#002B6B",
    "royal": "#003F9E",
    "blue": "#2F5FA8",
    "azure": "#2F5FA8",
    "pale": "#E8F0FA",
    "ice": "#F5F8FC",
    "white": "#FFFFFF",
    "ink": "#1F2937",
    "textNavy": "#17375E",
    "gray": "#5A6B7B",
    "lgray": "#909090",
    "border": "#C9D8EA",
    "red": "#B80000",
    "redPale": "#FDECEC",
    "gold": "#F0C56B",
    "goldDeep": "#C99A37",
    "green": "#2E8B57",
    "greenPale": "#EAF5EE",
    "orange": "#E87722",
}

ZONE_TONES = {
    "ice": ("#F2F8FE", "#D7E7F7"),
    "mist": ("#F5F7FA", "#E2E8EF"),
    "cream": ("#FBF7EC", "#EAE0C8"),
    "lavender": ("#F5F1FA", "#E3DAF0"),
}

FONT_SANS = "Noto Sans SC"
FONT_SERIF = "Noto Serif SC"
FONT_OFFICE_SANS = "Microsoft YaHei"
FONT_OFFICE_SERIF = "SimSun"


def color(name: str) -> str:
    return COLORS.get(name, name)


FONT_PROFILES = {
    "noto": {"sans": FONT_SANS, "serif": FONT_SERIF},
    "office": {"sans": FONT_OFFICE_SANS, "serif": FONT_OFFICE_SERIF},
}


# ---------------------------------------------------------------- elements

@dataclass
class Run:
    text: str
    color: str = COLORS["ink"]
    bold: bool = False
    underline: bool = False
    size: float = 14.5
    family: str = FONT_SANS


@dataclass
class Line:
    x1: float
    y1: float
    x2: float
    y2: float
    color: str = COLORS["border"]
    width: float = 1
    dash: Optional[str] = None


@dataclass
class Rect:
    x: float
    y: float
    w: float
    h: float
    fill: Optional[str] = None
    gradient: Optional[tuple] = None  # (angle, [(pos, hex), ...])
    line: Optional[str] = None
    lw: float = 1
    radius: float = 0
    dash: Optional[str] = None


@dataclass
class Tri:
    x: float
    y: float
    w: float
    h: float
    color: str
    direction: str = "right"


@dataclass
class TextEl:
    x: float
    y: float
    w: float
    h: float
    lines: list[list[Run]]
    size: float
    color: str
    family: str
    bold: bool
    align: str = "left"
    valign: str = "top"
    lh: float = 1.5
    tracking: float = 0
    vertical: bool = False


@dataclass
class TableEl:
    x: float
    y: float
    w: float
    col_w: list[float]
    rows: list[list[list[Run]]]
    row_h: list[float]
    header: bool
    font_size: float
    header_fill: str
    header_color: str
    text_color: str
    border: str
    align: list[str]
    first_col_bold: bool
    vertical_align: str = "middle"
    family: str = FONT_SANS


@dataclass
class ImgEl:
    x: float
    y: float
    w: float
    h: float
    src: str
    fit: str = "cover"
    border: Optional[str] = COLORS["border"]
    radius: float = 2


# ---------------------------------------------------------------- text

EMPHASIS_RE = re.compile(r"(\*\*.*?\*\*|!!.*?!!|\[\[.*?\]\]|{{.*?}})")


def _style_for(mark: str, base_color: str) -> dict:
    if mark == "**":
        return {"color": COLORS["red"], "bold": True, "underline": False}
    if mark == "!!":
        return {"color": COLORS["red"], "bold": True, "underline": True}
    if mark == "[[":
        return {"color": COLORS["blue"], "bold": True, "underline": False}
    return {"color": COLORS["gold"], "bold": True, "underline": False}


def parse_markup(text: str, size: float, family: str, base_color: str) -> list[Run]:
    runs: list[Run] = []
    for part in EMPHASIS_RE.split(text):
        if not part:
            continue
        mark = part[:2]
        if mark in ("**", "!!", "[["):
            inner = part[2:-2]
            st = _style_for(mark, base_color)
            runs.append(Run(inner, st["color"], st["bold"], st["underline"], size, family))
        elif mark == "{{":
            inner = part[2:-2]
            runs.append(Run(inner, COLORS["gold"], True, False, size, family))
        else:
            runs.append(Run(part, base_color, False, False, size, family))
    return [r for r in runs if r.text]


def char_w(ch: str, size: float, bold: bool = False) -> float:
    if ch == "\n":
        return 0
    if ch == " ":
        return size * 0.30
    if ch == "\t":
        return size * 0.6
    code = ord(ch)
    if code < 128:
        if ch.isupper():
            w = 0.62
        elif ch.isdigit():
            w = 0.56
        elif ch in "il.,;:!|'`":
            w = 0.3
        elif ch in "mw":
            w = 0.8
        else:
            w = 0.52
        return size * w * (1.04 if bold else 1)
    if ch in "，。、；：！？）》”’」』":
        return size * 0.98
    if ch in "（《“‘「『":
        return size * 0.98
    return size


CLOSING = set("，。、；：！？）》”’」』%‰")


def _chars_from_runs(runs: list[Run]) -> list[tuple[str, Run]]:
    out: list[tuple[str, Run]] = []
    for r in runs:
        for ch in r.text:
            out.append((ch, r))
    return out


def _line_from_chars(chars: list[tuple[str, Run]]) -> list[Run]:
    merged: list[Run] = []
    for ch, r in chars:
        if merged and merged[-1].color == r.color and merged[-1].bold == r.bold \
                and merged[-1].underline == r.underline and merged[-1].size == r.size:
            merged[-1].text += ch
        else:
            merged.append(Run(ch, r.color, r.bold, r.underline, r.size, r.family))
    return merged


def wrap_runs(runs: list[Run], width: float) -> list[list[Run]]:
    chars = _chars_from_runs(runs)
    lines: list[list[tuple[str, Run]]] = []
    cur: list[tuple[str, Run]] = []
    cur_w = 0.0
    last_space = -1
    limit = max(10, width - 1)
    for ch, r in chars:
        if ch == "\n":
            lines.append(cur)
            cur, cur_w, last_space = [], 0.0, -1
            continue
        cw = char_w(ch, r.size, r.bold)
        if cur and cur_w + cw > limit:
            if ch in CLOSING and cur_w + cw <= limit * 1.08:
                cur.append((ch, r))
                lines.append(cur)
                cur, cur_w, last_space = [], 0.0, -1
                continue
            latin_after_space = False
            if last_space >= 0:
                tail = cur[last_space + 1:]
                latin_after_space = any(ord(c) < 128 and c.isalpha() for c, _ in tail)
            if latin_after_space and last_space > 0:
                head = cur[:last_space]
                tail = cur[last_space + 1:]
                lines.append(head)
                cur = tail
                cur_w = sum(char_w(c, rr.size, rr.bold) for c, rr in cur)
            else:
                lines.append(cur)
                cur, cur_w = [], 0.0
            last_space = -1
        cur.append((ch, r))
        cur_w += cw
        if ch == " ":
            last_space = len(cur) - 1
    if cur:
        lines.append(cur)
    return [_line_from_chars(line) for line in lines if line]


# ---------------------------------------------------------------- builder

class SB:
    def __init__(self, idx: int, base_dir: str, profile: dict):
        self.idx = idx
        self.base = base_dir
        self.fonts = profile
        self.els: list[Any] = []
        self.warn: list[str] = []

    def warn_msg(self, msg: str) -> None:
        self.warn.append(f"[warn] slide {self.idx}: {msg}")

    def rect(self, x, y, w, h, fill=None, line=None, lw=1, radius=0,
             gradient=None, dash=None) -> Rect:
        el = Rect(x, y, w, h, fill, gradient, line, lw, radius, dash)
        self.els.append(el)
        return el

    def line(self, x1, y1, x2, y2, color=COLORS["border"], width=1, dash=None) -> Line:
        el = Line(x1, y1, x2, y2, color, width, dash)
        self.els.append(el)
        return el

    def tri(self, x, y, w, h, color, direction="right") -> Tri:
        el = Tri(x, y, w, h, color, direction)
        self.els.append(el)
        return el

    def text(self, x, y, w, h, content, size=14.5, color_name="ink",
             family="sans", bold=False, align="left", valign="top",
             lh=1.5, tracking=0, vertical=False, red_as=None) -> TextEl:
        fam = self.fonts.get(family, self.fonts["sans"])
        base_color = color(color_name)
        runs = parse_markup(content, size, fam, base_color)
        if red_as:
            for r in runs:
                if r.color == COLORS["red"]:
                    r.color = color(red_as)
        lines = wrap_runs(runs, w)
        need = len(lines) * size * lh
        if need > h + max(1.5, size * 0.15):
            self.warn_msg(f"text overflow at ({int(x)}, {int(y)}) need {need:.0f}px / box {h:.0f}px: {content[:24]}")
        el = TextEl(x, y, w, h, lines, size, base_color, fam, bold, align, valign,
                    lh, tracking, vertical)
        self.els.append(el)
        return el

    def bullets(self, x, y, w, h, items, size=14.5, marker="chevron", lh=1.55,
                color_name="ink", gap_lines=0, align="left", valign="top") -> TextEl:
        fam = self.fonts["sans"]
        base = color(color_name)
        marker_char, marker_color = {
            "chevron": ("▸", COLORS["blue"]),
            "dot": ("●", COLORS["blue"]),
            "check": ("✓", COLORS["blue"]),
            "none": ("", COLORS["blue"]),
        }.get(marker, ("▸", COLORS["blue"]))
        marker_w = char_w(marker_char, size * 0.8, True) + size * 0.45 if marker_char else 0
        lines: list[list[Run]] = []
        for i, item in enumerate(items):
            runs = parse_markup(str(item), size, fam, base)
            body = wrap_runs(runs, w - marker_w)
            for j, line in enumerate(body):
                if j == 0 and marker_char:
                    lines.append([Run(marker_char + " ", marker_color, True, False, size * 0.8, fam)] + line)
                elif marker_char:
                    pad = "\u3000" if marker_char else ""
                    lines.append([Run(pad, base, False, False, size, fam)] + line)
                else:
                    lines.append(line)
            if gap_lines and i < len(items) - 1:
                for _ in range(gap_lines):
                    lines.append([Run("", base, False, False, size * 0.35, fam)])
        need = sum(max(r.size for r in line) if line else size * 0.35 for line in lines) * lh
        if need > h + 2:
            self.warn_msg(f"bullets overflow at ({int(x)}, {int(y)}) need {need:.0f}px / box {h:.0f}px")
        el = TextEl(x, y, w, h, lines, size, base, fam, False, align, valign, lh, 0, False)
        self.els.append(el)
        return el

    def image(self, x, y, w, h, src, fit="cover", border=COLORS["border"], radius=2) -> Optional[ImgEl]:
        resolved = resolve_image(src, self.base, self.warn_msg)
        if not resolved:
            self.rect(x, y, w, h, fill=COLORS["ice"], line=border, lw=1, radius=radius)
            self.text(x + 8, y + h / 2 - 10, w - 16, 20, "图片缺失", size=10.5, color_name="lgray",
                      align="center", valign="center")
            return None
        if fit == "contain":
            try:
                from PIL import Image
                iw, ih = Image.open(resolved).size
                scale = min(w / iw, h / ih)
                nw, nh = iw * scale, ih * scale
                x += (w - nw) / 2
                y += (h - nh) / 2
                w, h = nw, nh
            except Exception:
                pass
        el = ImgEl(x, y, w, h, resolved, fit, border, radius)
        self.els.append(el)
        return el

    def table(self, x, y, w, cols, rows, row_h=32, header_h=30, font_size=12,
              align=None, first_col_bold=True, header_fill=COLORS["pale"],
              header_color=COLORS["textNavy"], text_color=COLORS["textNavy"]) -> TableEl:
        weights = [float(c.get("w", 1)) for c in cols]
        total = sum(weights) or 1
        col_w = [w * wt / total for wt in weights]
        ncol = len(cols)
        if align is None:
            align = ["left"] + ["center"] * (ncol - 1)
        header_rows = [[parse_markup(str(c.get("label", "")), font_size, self.fonts["sans"], header_color)
                        for c in cols]]
        body_rows: list[list[list[Run]]] = []
        for row in rows:
            cells = []
            for i in range(ncol):
                val = row[i] if i < len(row) else ""
                cells.append(parse_markup(str(val), font_size, self.fonts["sans"], text_color))
            body_rows.append(cells)
        all_rows = header_rows + body_rows
        heights = [header_h] + [row_h] * len(body_rows)
        el = TableEl(x, y, w, col_w, all_rows, heights, True, font_size,
                     header_fill, header_color, text_color, COLORS["border"], align,
                     first_col_bold, "middle", self.fonts["sans"])
        self.els.append(el)
        return el


def resolve_image(src: str, base_dir: str, warn) -> Optional[str]:
    if not src:
        return None
    if src.startswith("http://") or src.startswith("https://"):
        cache = os.path.join(tempfile.gettempdir(), "research-ppt-imgcache")
        os.makedirs(cache, exist_ok=True)
        name = re.sub(r"[^a-zA-Z0-9._-]", "_", src.split("/")[-1])[:80] or "img"
        ext = os.path.splitext(name)[1].lower()
        if ext not in (".png", ".jpg", ".jpeg", ".webp"):
            name += ".png"
        path = os.path.join(cache, name)
        if not os.path.exists(path):
            try:
                urllib.request.urlretrieve(src, path)
            except Exception as e:  # noqa: BLE001
                warn(f"download failed {src}: {e}")
                return None
        return path
    path = src if os.path.isabs(src) else os.path.join(base_dir, src)
    if not os.path.exists(path):
        warn(f"missing image {src}")
        return None
    if path.lower().endswith(".svg"):
        warn(f"SVG needs rasterization before PPTX output: {src}")
        return path
    return path


# ---------------------------------------------------------------- shared chrome

def page_bg(sb: SB, subtle=True) -> None:
    sb.rect(0, 0, W, H, fill=COLORS["white"])
    if subtle:
        sb.line(1040, 30, 1210, 150, color="#DCE8F6", width=1)
        sb.line(1092, 22, 1244, 120, color="#E6EFF9", width=1)


def page_header(sb: SB, no: str, title: str) -> None:
    bw, bh = 60, 43
    if no:
        sb.rect(MX, 34, bw, bh, fill=COLORS["royal"], radius=6)
        sb.text(MX, 34, bw, bh, no, size=25, color_name="white", bold=True,
                align="center", valign="center", lh=1.1)
        tx = MX + bw + 12
    else:
        tx = MX
    sb.text(tx, 30, 1080, 50, title, size=32, color_name="textNavy",
            family="sans", bold=True, valign="center", lh=1.2, tracking=0.5)
    sb.rect(MX, 96, CONTENT_W, 1, fill=COLORS["royal"])
    sb.rect(MX, 94.5, 52, 3, fill=COLORS["navyDeep"])


def page_banner(sb: SB, text: str, y: float = 108, h: float = 38) -> None:
    sb.rect(MX, y, CONTENT_W, h, gradient=(90, [(0, "#1257AE"), (1, "#0A3F88")]))
    sb.text(MX + 16, y, CONTENT_W - 32, h, text, size=16.5, color_name="white",
            bold=True, align="center", valign="center", lh=1.2, red_as="gold")


def page_footer(sb: SB, idx: int, total: int, notes=None) -> None:
    if notes:
        text = "    ".join(str(n) for n in notes[:2])
        sb.text(MX, 666, 900, 14, text, size=10.5, color_name="lgray", lh=1.2)
    if total:
        sb.text(W - MX - 120, 666, 120, 14, f"{idx} / {total}", size=10.5,
                color_name="lgray", align="right", lh=1.2)


def page_conclusion(sb: SB, text: str) -> None:
    sb.rect(0, 624, W, 38, fill=COLORS["navy"])
    sb.rect(0, 624, W, 2, fill=COLORS["goldDeep"])
    sb.text(24, 624, W - 48, 38, text, size=17, color_name="white", bold=True,
            align="center", valign="center", lh=1.2, red_as="gold")


def module_header(sb: SB, x, y, w, title, style="solid", h=30) -> None:
    if style == "outline":
        sb.rect(x, y, w, h, fill=COLORS["white"], line=COLORS["royal"], lw=1, radius=3)
        sb.rect(x, y, 6, h, fill=COLORS["royal"])
        sb.text(x + 14, y, w - 24, h, title, size=18, color_name="textNavy",
                bold=True, align="left", valign="center", lh=1.1, tracking=0.5)
    else:
        sb.rect(x, y, w, h, gradient=(90, [(0, "#1257AE"), (1, "#0A3F88")]), radius=3)
        sb.text(x + 8, y, w - 16, h, title, size=18, color_name="white", bold=True,
                align="center", valign="center", lh=1.1, tracking=1)


def card(sb: SB, x, y, w, h, title, style="solid", header_h=30) -> tuple[float, float, float, float]:
    sb.rect(x, y, w, h, fill=COLORS["white"], line=COLORS["border"], lw=1, radius=3)
    if title:
        module_header(sb, x, y, w, title, style=style, h=header_h)
        return (x + 12, y + header_h + 10, w - 24, h - header_h - 20)
    return (x + 12, y + 12, w - 24, h - 24)


def note_box(sb: SB, x, y, w, h, text, tone="light", size=12.5) -> None:
    fills = {"light": COLORS["ice"], "warn": "#FBF3E2", "danger": "#FBEDEC"}
    lines = {"light": COLORS["blue"], "warn": COLORS["goldDeep"], "danger": COLORS["red"]}
    sb.rect(x, y, w, h, fill=fills.get(tone, COLORS["ice"]), radius=3,
            line="#E2EBF6", lw=0.75)
    sb.rect(x, y, 4, h, fill=lines.get(tone, COLORS["blue"]))
    sb.text(x + 12, y, w - 20, h, text, size=size, color_name="ink",
            valign="center", lh=1.5)


def caption(sb: SB, x, y, w, text, size=10.5) -> None:
    sb.text(x, y, w, 16, text, size=size, color_name="gray", align="center", lh=1.3)


def vertical_label(sb: SB, x, y, w, h, label, size=20) -> None:
    sb.rect(x, y, w, h, fill=COLORS["navy"], radius=3)
    vertical_chars(sb, x, y + 8, w, h - 16, label, size, "white", family="sans", bold=True, tracking=2)


def vertical_chars(sb: SB, x, y, w, h, text, size, color_name="white",
                   family="serif", bold=True, tracking=0) -> None:
    n = max(1, len(text))
    step = h / n
    for i, ch in enumerate(text):
        sb.text(x, y + i * step, w, step, ch, size=size, color_name=color_name,
                family=family, bold=bold, align="center", valign="center",
                lh=1.0, tracking=tracking)


def flow_steps(sb: SB, x, y, w, h, steps) -> None:
    n = max(1, len(steps))
    gap = 26
    bw = (w - gap * (n - 1)) / n
    for i, st in enumerate(steps):
        bx = x + i * (bw + gap)
        sb.rect(bx, y, bw, h, fill=COLORS["ice"], line="#B7C9E2", lw=1, radius=4)
        sb.rect(bx, y, bw, 3, fill=COLORS["royal"], radius=1)
        sb.text(bx + 10, y + 9, 34, 18, f"{i + 1:02d}", size=10.5, color_name="azure",
                bold=True, lh=1.0)
        sb.text(bx + 10, y + 30, bw - 20, 24, str(st.get("title", "")), size=14.5,
                color_name="textNavy", bold=True, align="center", valign="center", lh=1.2)
        desc = str(st.get("desc", ""))
        if desc:
            sb.text(bx + 10, y + 58, bw - 20, h - 66, desc, size=11, color_name="gray",
                    align="center", lh=1.4)
        if i < n - 1:
            sb.tri(bx + bw + (gap - 14) / 2, y + h / 2 - 9, 14, 18, COLORS["royal"], "right")


def metric_tiles(sb: SB, x, y, w, h, items, value_color="navy") -> None:
    n = max(1, len(items))
    gap = 12
    tw = (w - gap * (n - 1)) / n
    for i, it in enumerate(items):
        tx = x + i * (tw + gap)
        sb.rect(tx, y, tw, h, fill=COLORS["white"], line=COLORS["border"], lw=1, radius=3)
        sb.rect(tx, y, tw, 3, fill=COLORS["royal"], radius=1)
        sb.text(tx + 8, y + 12, tw - 16, 34, str(it.get("value", "")), size=30,
                color_name=str(it.get("tone", value_color)), bold=True, align="center",
                valign="center", lh=1.0)
        sb.text(tx + 8, y + 50, tw - 16, 18, str(it.get("label", "")), size=12,
                color_name="textNavy", bold=True, align="center", lh=1.2)
        note = str(it.get("note", ""))
        if note:
            sb.text(tx + 8, y + 68, tw - 16, 16, note, size=10, color_name="gray",
                    align="center", lh=1.2)


def content_area(has_banner=False, has_conclusion=True):
    top = 158 if has_banner else 110
    bottom = 612 if has_conclusion else 662
    return MX, top, CONTENT_W, bottom - top


def table_height(cols, rows, row_h=32, header_h=30) -> float:
    return header_h + len(rows) * row_h
