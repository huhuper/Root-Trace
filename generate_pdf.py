#!/usr/bin/env python3
"""从 input.js 生成族谱 PDF：古典中式封面 + 每人一页（世代标题、照片框、信息字段）。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict, deque
from pathlib import Path

from reportlab.lib.colors import Color, HexColor
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm, mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# 与 js/editor.js 中 MEMBER_FIELDS 一致，排除 image_path
PDF_FIELDS = [
    ("name", "姓名"),
    ("title", "称谓"),
    ("birth_date", "出生日期"),
    ("lunar_birthday", "阴历生日"),
    ("zodiac", "生肖"),
    ("death_date", "寿终"),
    ("biography", "生平"),
]

# 中式古典配色
PAPER = HexColor("#F3E9D5")
INK = HexColor("#2B1A12")
CINNABAR = HexColor("#8C1C13")
FRAME_GOLD = HexColor("#A67C3A")
MUTED = HexColor("#6B5344")
PHOTO_BG = HexColor("#E8DCC4")

PHOTO_SIZE = 5.2 * cm  # 圆形人像外接正方形边长

FONT_CANDIDATES = [
    # (path, name_hint) — 优先楷体 / 仿宋，偏古典
    (Path(r"C:\Windows\Fonts\simkai.ttf"), "kai"),
    (Path(r"C:\Windows\Fonts\simfang.ttf"), "fang"),
    (Path(r"C:\Windows\Fonts\STKAITI.TTF"), "kai"),
    (Path(r"C:\Windows\Fonts\simsun.ttc"), "song"),
    (Path(r"C:\Windows\Fonts\msyh.ttc"), "hei"),
    (Path(r"C:\Windows\Fonts\simhei.ttf"), "hei"),
    (Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"), "hei"),
    (Path("/System/Library/Fonts/PingFang.ttc"), "hei"),
]


def strip_line_comments(text: str) -> str:
    """去掉 // 注释，但保留字符串里的 //（例如生平里写的网址）。"""
    out = []
    in_string = False
    escape = False
    quote = ""
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                in_string = False
        elif ch in "\"'":
            in_string = True
            quote = ch
            out.append(ch)
        elif text.startswith("//", i):
            newline = text.find("\n", i)
            if newline == -1:
                break
            i = newline
            continue
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def parse_input_js(path: Path) -> dict:
    """解析 input.js 中的 _input 对象（JSON 兼容的对象字面量）。"""
    text = path.read_text(encoding="utf-8")
    match = re.search(r"(?:let|var|const)\s+_input\s*=\s*", text)
    if not match:
        raise ValueError(f"在 {path} 中未找到 _input 赋值")

    start = match.end()
    while start < len(text) and text[start].isspace():
        start += 1
    if start >= len(text) or text[start] != "{":
        raise ValueError("_input 不是对象字面量")

    depth = 0
    in_string = False
    escape = False
    quote = ""
    end = start
    for i, ch in enumerate(text[start:], start=start):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                in_string = False
            continue
        if ch in "\"'":
            in_string = True
            quote = ch
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    else:
        raise ValueError("无法匹配 _input 对象的结束括号")

    literal = strip_line_comments(text[start:end])
    try:
        return json.loads(literal)
    except json.JSONDecodeError as exc:
        raise ValueError(f"无法将 _input 解析为 JSON：{exc}") from exc


def normalize_node_id(node) -> str:
    """
    规范化节点 ID。
    编辑器中家庭节点多为 JSON.stringify([配偶A, 配偶B])，
    真实 input 里也可能直接写成嵌套数组 ["@I500@","@I501@"]。
    """
    if isinstance(node, (list, tuple)):
        partners = sorted(str(x) for x in node)
        return json.dumps(partners, ensure_ascii=False, separators=(",", ":"))
    if isinstance(node, str):
        text = node.strip()
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                return node
            if isinstance(parsed, list):
                partners = sorted(str(x) for x in parsed)
                return json.dumps(partners, ensure_ascii=False, separators=(",", ":"))
        return node
    raise ValueError(f"无法识别的节点 ID 类型：{type(node).__name__} -> {node!r}")


def is_member_id(node_id: str, members: dict) -> bool:
    """成员以 members 字典为准（兼容 I500 / @I500@ 等）。"""
    return node_id in members


def build_unions(links: list, members: dict) -> dict[str, dict]:
    """
    按家庭节点聚合配偶与子女。
    支持：
      - 旧格式 U 节点：["I500","U500"] / ["U500","I502"]
      - 编辑器格式：["@I500@", ["@I500@","@I501@"]] 或字符串化的配偶数组 ID
    """
    unions: dict[str, dict] = defaultdict(lambda: {"partners": [], "children": []})
    for link in links:
        if not isinstance(link, (list, tuple)) or len(link) != 2:
            raise ValueError(f"边必须是长度为 2 的数组：{link!r}")
        a = normalize_node_id(link[0])
        b = normalize_node_id(link[1])
        a_member = is_member_id(a, members)
        b_member = is_member_id(b, members)

        if (not a_member) and b_member:
            # 家庭 -> 子女
            if b not in unions[a]["children"]:
                unions[a]["children"].append(b)
        elif a_member and (not b_member):
            # 成员 -> 家庭（配偶关系）
            if a not in unions[b]["partners"]:
                unions[b]["partners"].append(a)
        elif a_member and b_member:
            # 极少数：直接成员边（无家庭节点）。视为 a 为父、b 为子的匿名家庭。
            uid = json.dumps(
                sorted([a, f"anon-parent-of:{b}"]),
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if a not in unions[uid]["partners"]:
                unions[uid]["partners"].append(a)
            if b not in unions[uid]["children"]:
                unions[uid]["children"].append(b)
        else:
            raise ValueError(f"无法识别的边：[{link[0]!r}, {link[1]!r}]（规范化后：{a!r} -> {b!r}）")
    return dict(unions)


def resolve_root(data: dict, unions: dict[str, dict]) -> str:
    start = normalize_node_id(data.get("start"))
    members = data["members"]
    if start in members:
        return start
    if start in unions and unions[start]["partners"]:
        return unions[start]["partners"][0]
    raise ValueError(f"无法从 start={data.get('start')!r} 确定始祖")


def assign_generations(root_id: str, unions: dict[str, dict], members: dict) -> dict[str, int]:
    person_to_unions: dict[str, list[str]] = defaultdict(list)
    child_to_parents: dict[str, list[str]] = {}

    for uid, info in unions.items():
        for pid in info["partners"]:
            person_to_unions[pid].append(uid)
        for cid in info["children"]:
            child_to_parents[cid] = list(info["partners"])

    generations: dict[str, int] = {root_id: 1}
    queue: deque[str] = deque([root_id])

    def set_generation(person_id: str, gen: int) -> None:
        if person_id not in members:
            return
        prev = generations.get(person_id)
        if prev is None:
            generations[person_id] = gen
            queue.append(person_id)
        elif prev != gen:
            raise ValueError(
                f"世代冲突：{person_id} 已为第 {prev} 世，又被标为第 {gen} 世"
            )

    while queue:
        person_id = queue.popleft()
        gen = generations[person_id]

        for uid in person_to_unions.get(person_id, []):
            info = unions[uid]
            for partner in info["partners"]:
                set_generation(partner, gen)
            for child in info["children"]:
                set_generation(child, gen + 1)

        parents = child_to_parents.get(person_id, [])
        for parent in parents:
            set_generation(parent, gen - 1)

    missing = [pid for pid in members if pid not in generations]
    if missing:
        raise ValueError(f"以下成员未能确定世代（请检查 links）：{missing}")

    return generations


def register_fonts() -> dict[str, str]:
    """注册可用中文字体，返回 role -> fontName。"""
    fonts: dict[str, str] = {}
    for path, hint in FONT_CANDIDATES:
        if not path.is_file():
            continue
        name = f"FT_{hint}_{path.stem}"
        try:
            if path.suffix.lower() == ".ttc":
                pdfmetrics.registerFont(TTFont(name, str(path), subfontIndex=0))
            else:
                pdfmetrics.registerFont(TTFont(name, str(path)))
        except Exception:
            continue
        fonts.setdefault(hint, name)
        fonts.setdefault("any", name)
        if len(fonts) >= 4 and "any" in fonts:
            break

    body = fonts.get("kai") or fonts.get("fang") or fonts.get("song") or fonts.get("any") or "Helvetica"
    title = fonts.get("kai") or fonts.get("song") or body
    return {"body": body, "title": title, "path_hint": body}


def escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def person_sort_key(person_id: str, generation: int) -> tuple:
    return (generation, person_id)


def resolve_image_path(image_path: str, base_dir: Path) -> Path | None:
    if not image_path or not str(image_path).strip():
        return None
    path = Path(image_path)
    if not path.is_absolute():
        path = base_dir / path
    if path.is_file():
        return path
    return None


def draw_double_rect(c, x, y, w, h, stroke, outer=1.6, gap=2.8, inner=0.7):
    c.setStrokeColor(stroke)
    c.setLineWidth(outer)
    c.rect(x, y, w, h, stroke=1, fill=0)
    c.setLineWidth(inner)
    c.rect(x + gap, y + gap, w - 2 * gap, h - 2 * gap, stroke=1, fill=0)


def draw_corner_clouds(c, x, y, w, h, color, arm=14):
    """四角回纹装饰。"""
    c.setStrokeColor(color)
    c.setLineWidth(1.1)
    pairs = [
        (x, y + h, 1, -1),
        (x + w, y + h, -1, -1),
        (x, y, 1, 1),
        (x + w, y, -1, 1),
    ]
    for cx, cy, sx, sy in pairs:
        c.line(cx, cy, cx + sx * arm, cy)
        c.line(cx, cy, cx, cy + sy * arm)
        c.line(cx + sx * 4, cy + sy * 4, cx + sx * (arm - 2), cy + sy * 4)
        c.line(cx + sx * 4, cy + sy * 4, cx + sx * 4, cy + sy * (arm - 2))


def draw_page_chrome(c, doc, *, cover: bool = False):
    width, height = A4
    c.saveState()
    c.setFillColor(PAPER)
    c.rect(0, 0, width, height, stroke=0, fill=1)

    margin = 12 * mm
    draw_double_rect(
        c,
        margin,
        margin,
        width - 2 * margin,
        height - 2 * margin,
        CINNABAR if cover else INK,
        outer=2.2 if cover else 1.5,
        gap=3.5 if cover else 2.6,
        inner=0.9 if cover else 0.65,
    )
    draw_corner_clouds(
        c,
        margin + 5,
        margin + 5,
        width - 2 * margin - 10,
        height - 2 * margin - 10,
        FRAME_GOLD if cover else MUTED,
        arm=16 if cover else 12,
    )

    # 上下细线装饰
    c.setStrokeColor(CINNABAR if cover else FRAME_GOLD)
    c.setLineWidth(0.6)
    y_top = height - margin - 10 * mm
    y_bot = margin + 10 * mm
    inset = margin + 18 * mm
    if cover:
        c.line(inset, y_top, width - inset, y_top)
        c.line(inset, y_bot, width - inset, y_bot)
    c.restoreState()


def make_on_page(cover: bool):
    def _on_page(canvas, doc):
        draw_page_chrome(canvas, doc, cover=cover)

    return _on_page


class PhotoFrame(Flowable):
    """固定尺寸圆形人像：有图显示，无图留空，结构一致。"""

    def __init__(self, image_path: Path | None, size=PHOTO_SIZE):
        super().__init__()
        self.image_path = image_path
        self.width = size
        self.height = size

    def wrap(self, availWidth, availHeight):
        return self.width, self.height

    def draw(self):
        c = self.canv
        cx = self.width / 2
        cy = self.height / 2
        outer_r = self.width / 2 - 1.2
        inner_r = outer_r - 3.2

        # 圆形底
        c.setFillColor(PHOTO_BG)
        c.setStrokeColor(CINNABAR)
        c.setLineWidth(1.6)
        c.circle(cx, cy, outer_r, stroke=1, fill=1)

        # 内金圈
        c.setStrokeColor(FRAME_GOLD)
        c.setLineWidth(0.8)
        c.circle(cx, cy, inner_r, stroke=1, fill=0)

        if self.image_path is not None:
            try:
                reader = ImageReader(str(self.image_path))
                iw, ih = reader.getSize()
                # cover 裁剪：铺满圆内接正方形
                side = inner_r * 2 - 1.5
                scale = max(side / iw, side / ih)
                dw, dh = iw * scale, ih * scale
                x = cx - dw / 2
                y = cy - dh / 2
                c.saveState()
                p = c.beginPath()
                p.circle(cx, cy, inner_r - 0.8)
                c.clipPath(p, stroke=0)
                c.drawImage(
                    reader,
                    x,
                    y,
                    width=dw,
                    height=dh,
                    preserveAspectRatio=True,
                    mask="auto",
                )
                c.restoreState()
                # 再描一圈外框，盖住裁切边缘
                c.setStrokeColor(CINNABAR)
                c.setLineWidth(1.4)
                c.circle(cx, cy, outer_r, stroke=1, fill=0)
                c.setStrokeColor(FRAME_GOLD)
                c.setLineWidth(0.7)
                c.circle(cx, cy, inner_r, stroke=1, fill=0)
                return
            except Exception:
                pass

        # 无照片：留空并标注
        c.setFillColor(MUTED)
        c.setFont(self._font_name(), 9)
        label = "暂无照片"
        tw = c.stringWidth(label, self._font_name(), 9)
        c.drawString(cx - tw / 2, cy - 3, label)

    def _font_name(self):
        return getattr(self, "font_name", "Helvetica")


def build_styles(fonts: dict[str, str]) -> dict[str, ParagraphStyle]:
    title_font = fonts["title"]
    body_font = fonts["body"]
    return {
        "cover_main": ParagraphStyle(
            "CoverMain",
            fontName=title_font,
            fontSize=42,
            leading=56,
            alignment=TA_CENTER,
            textColor=CINNABAR,
        ),
        "cover_sub": ParagraphStyle(
            "CoverSub",
            fontName=body_font,
            fontSize=14,
            leading=22,
            alignment=TA_CENTER,
            textColor=CINNABAR,
        ),
        "cover_meta": ParagraphStyle(
            "CoverMeta",
            fontName=body_font,
            fontSize=11,
            leading=18,
            alignment=TA_CENTER,
            textColor=MUTED,
        ),
        "gen_title": ParagraphStyle(
            "GenTitle",
            fontName=title_font,
            fontSize=20,
            leading=28,
            alignment=TA_CENTER,
            textColor=CINNABAR,
            spaceAfter=6,
        ),
        "field_label": ParagraphStyle(
            "FieldLabel",
            fontName=body_font,
            fontSize=11,
            leading=16,
            textColor=CINNABAR,
        ),
        "field_value": ParagraphStyle(
            "FieldValue",
            fontName=body_font,
            fontSize=11,
            leading=17,
            textColor=INK,
            alignment=TA_LEFT,
        ),
        "bio_value": ParagraphStyle(
            "BioValue",
            fontName=body_font,
            fontSize=11,
            leading=18,
            textColor=INK,
            alignment=TA_JUSTIFY,
        ),
    }


# 常见复姓（按长度优先匹配姓名开头）
COMPOUND_SURNAMES = (
    "欧阳", "司马", "上官", "皇甫", "诸葛", "东方", "西门", "南宫",
    "司徒", "司空", "夏侯", "慕容", "令狐", "公孙", "宇文", "长孙",
    "尉迟", "端木", "独孤", "赫连", "万俟", "纳兰",
)


def extract_clan_from_name(name: str) -> str:
    """从姓名推断姓氏：先匹配复姓，否则取首字。无法识别则返回空。"""
    text = (name or "").strip()
    if not text:
        return ""
    for surname in COMPOUND_SURNAMES:
        if text.startswith(surname):
            return surname
    return text[0]


def resolve_cover(data: dict, root_id: str) -> dict[str, str]:
    """
    封面字段：
      cover.clan  — 姓氏，自填优先；留空则用始祖姓名开头识别（含复姓）
      cover.motto — 祖训，自填；留空用默认
    标题恒为「{姓}氏族谱」；姓仍空时显示「　氏族谱」。
    """
    cover = data.get("cover") or {}
    if not isinstance(cover, dict):
        cover = {}

    clan = str(cover.get("clan", "") or "").strip()
    if not clan:
        root_name = str((data.get("members") or {}).get(root_id, {}).get("name", "") or "")
        clan = extract_clan_from_name(root_name)

    motto = str(cover.get("motto", "") or "").strip()
    if not motto:
        motto = "慎终追远　民德归厚"

    display_clan = clan if clan else "　"
    return {
        "clan": clan,
        "title": f"{display_clan}氏族谱",
        "motto": motto,
        "root_name": str((data.get("members") or {}).get(root_id, {}).get("name", "") or "始祖"),
    }


def cover_flowables(styles: dict, cover: dict[str, str]) -> list:
    return [
        Spacer(1, 4.2 * cm),
        Paragraph(escape_xml(cover["title"]), styles["cover_main"]),
        Spacer(1, 0.6 * cm),
        Paragraph("◇　◆　◇", styles["cover_sub"]),
        Spacer(1, 0.8 * cm),
        Paragraph(f"{escape_xml(cover['root_name'])}一脉", styles["cover_sub"]),
        Spacer(1, 3.8 * cm),
        Paragraph(escape_xml(cover["motto"]), styles["cover_meta"]),
    ]


def member_flowables(
    member: dict,
    generation: int,
    styles: dict,
    base_dir: Path,
    body_font: str,
) -> list:
    image_file = resolve_image_path(str(member.get("image_path", "") or ""), base_dir)
    photo = PhotoFrame(image_file)
    photo.font_name = body_font

    # 居中照片框（外层满宽表格保证水平居中）
    photo_table = Table([[photo]], colWidths=[PHOTO_SIZE])
    photo_table.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    photo_wrap = Table([[photo_table]], colWidths=[13.8 * cm])
    photo_wrap.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )

    rows = []
    for key, label in PDF_FIELDS:
        raw = member.get(key, "")
        if raw is None:
            raw = ""
        value = escape_xml(str(raw))
        display = value if value != "" else "　"
        value_style = styles["bio_value"] if key == "biography" else styles["field_value"]
        rows.append(
            [
                Paragraph(f"{label}", styles["field_label"]),
                Paragraph(display, value_style),
            ]
        )

    info_table = Table(rows, colWidths=[2.6 * cm, 11.2 * cm])
    info_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("LINEBELOW", (0, 0), (-1, -2), 0.4, FRAME_GOLD),
                ("BACKGROUND", (0, 0), (0, -1), Color(0.93, 0.88, 0.78, alpha=0.35)),
            ]
        )
    )

    return [
        Paragraph(f"第 {generation} 世", styles["gen_title"]),
        Paragraph("—　像　—", ParagraphStyle(
            "PhotoCaption",
            fontName=body_font,
            fontSize=9,
            leading=12,
            alignment=TA_CENTER,
            textColor=MUTED,
            spaceAfter=4,
        )),
        photo_wrap,
        Spacer(1, 0.55 * cm),
        info_table,
    ]


def build_pdf(
    data: dict,
    generations: dict[str, int],
    output_path: Path,
    fonts: dict[str, str],
    base_dir: Path,
    root_id: str,
) -> None:
    styles = build_styles(fonts)
    width, height = A4
    margin = 22 * mm
    cover = resolve_cover(data, root_id)

    doc = BaseDocTemplate(
        str(output_path),
        pagesize=A4,
        title=cover["title"],
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
    )

    frame = Frame(
        margin,
        margin,
        width - 2 * margin,
        height - 2 * margin,
        id="normal",
        showBoundary=0,
        leftPadding=8,
        rightPadding=8,
        topPadding=10,
        bottomPadding=10,
    )

    doc.addPageTemplates(
        [
            PageTemplate(id="cover", frames=[frame], onPage=make_on_page(True)),
            PageTemplate(id="member", frames=[frame], onPage=make_on_page(False)),
        ]
    )

    members = data["members"]
    ordered = sorted(
        members.keys(),
        key=lambda pid: person_sort_key(pid, generations[pid]),
    )

    story: list = [
        NextPageTemplate("member"),
        *cover_flowables(styles, cover),
        PageBreak(),
    ]

    for index, person_id in enumerate(ordered):
        blocks = member_flowables(
            members[person_id],
            generations[person_id],
            styles,
            base_dir,
            fonts["body"],
        )
        story.append(KeepTogether(blocks))
        if index < len(ordered) - 1:
            story.append(PageBreak())

    doc.build(story)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="根据 input.js 生成族谱 PDF")
    parser.add_argument(
        "-i",
        "--input",
        type=Path,
        default=Path(__file__).resolve().parent / "input.js",
        help="input.js 路径",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "family_tree.pdf",
        help="输出 PDF 路径",
    )
    args = parser.parse_args(argv)

    if not args.input.is_file():
        print(f"找不到输入文件：{args.input}", file=sys.stderr)
        return 1

    summary = generate(args.input, args.output)

    print(f"使用字体：{summary['font']}")
    print(f"封面：{summary['title']}")
    print(f"祖训：{summary['motto']}")
    print(f"始祖：{summary['root_name']}（{summary['root_id']}）")
    for gen, names in summary["generations"]:
        print(f"  第 {gen} 世：{', '.join(names)}")
    count = summary["member_count"]
    print(f"已生成：{args.output}（封面 + {count} 人，共 {count + 1} 页）")
    return 0


def generate(input_path: Path, output_path: Path) -> dict:
    """解析 input.js 并生成 PDF，返回摘要。数据有问题时抛出 ValueError（中文说明）。
    供命令行和本地启动器（start.py）共用。"""
    input_path = Path(input_path)
    data = parse_input_js(input_path)
    if "members" not in data or "links" not in data:
        raise ValueError("input 缺少 members 或 links")

    base_dir = input_path.resolve().parent
    unions = build_unions(data["links"], data["members"])
    root_id = resolve_root(data, unions)
    generations = assign_generations(root_id, unions, data["members"])

    fonts = register_fonts()
    cover = resolve_cover(data, root_id)
    build_pdf(data, generations, Path(output_path), fonts, base_dir, root_id)

    by_gen: dict[int, list[str]] = defaultdict(list)
    for pid, gen in generations.items():
        by_gen[gen].append(data["members"][pid].get("name", pid))

    return {
        "font": fonts["body"],
        "title": cover["title"],
        "motto": cover["motto"],
        "root_id": root_id,
        "root_name": data["members"][root_id].get("name", root_id),
        "generations": [(gen, by_gen[gen]) for gen in sorted(by_gen)],
        "member_count": len(data["members"]),
    }


if __name__ == "__main__":
    raise SystemExit(main())
