#!/usr/bin/env python3
"""Root Trace 本地启动器：打开建族谱向导，并负责把数据写进项目文件夹。

用法：双击「启动向导」，或在项目文件夹里运行  python start.py
只在本机（127.0.0.1）上提供服务，别的电脑和网站都访问不到。
只用 Python 标准库；生成 PDF 需要额外安装 reportlab（pip install reportlab）。
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import shutil
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
INPUT_FILE = ROOT / "input.js"
BACKUP_FILE = ROOT / "input.backup.js"
IMAGES_DIR = ROOT / "images"
PDF_FILE = ROOT / "family_tree.pdf"

# input.js 第一行的标记：有它说明是向导自己写的，再次保存可直接覆盖；
# 没有它说明是用户手写或从 index.html 复制来的，覆盖前先备份。
WIZARD_MARKER = "// 由建族谱向导生成"

PHOTO_EXTENSIONS = {"jpg", "png", "gif", "webp", "bmp"}
MEMBER_ID = re.compile(r"^I\d{1,6}$")
MAX_PHOTO_BYTES = 20 * 1024 * 1024
MAX_JSON_BYTES = 5 * 1024 * 1024
NO_STORE_PREFIXES = ("/input.js", "/images/", "/family_tree.pdf")

PDF_LOCK = threading.Lock()


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def save_input(data) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("members"), dict) \
            or not isinstance(data.get("links"), list) or not isinstance(data.get("start"), str):
        raise ApiError(400, "数据格式不正确（缺少 start、members 或 links）")
    backed_up = False
    if INPUT_FILE.is_file():
        old = INPUT_FILE.read_text(encoding="utf-8", errors="replace")
        if not old.startswith(WIZARD_MARKER):
            shutil.copyfile(INPUT_FILE, BACKUP_FILE)
            backed_up = True
    text = (
        WIZARD_MARKER + "（用向导再次保存会直接覆盖；手动修改过的文件会先备份为 input.backup.js）\n"
        + "let _input = " + json.dumps(data, ensure_ascii=False, indent="\t") + ";\n"
    )
    write_atomic(INPUT_FILE, text.encode("utf-8"))
    return {"ok": True, "backed_up": backed_up}


def save_photo(member_id: str, ext: str, body: bytes) -> dict:
    if not MEMBER_ID.match(member_id or ""):
        raise ApiError(400, "成员编号不正确")
    ext = (ext or "").lower()
    if ext == "jpeg":
        ext = "jpg"
    if ext not in PHOTO_EXTENSIONS:
        raise ApiError(400, "只支持 jpg、png、gif、webp、bmp 格式的照片")
    if not body:
        raise ApiError(400, "照片是空的")
    IMAGES_DIR.mkdir(exist_ok=True)
    for old in IMAGES_DIR.glob(member_id + ".*"):
        if old.suffix.lower().lstrip(".") in PHOTO_EXTENSIONS | {"jpeg"}:
            old.unlink()
    name = f"{member_id}.{ext}"
    write_atomic(IMAGES_DIR / name, body)
    return {"ok": True, "image_path": "images/" + name}


def make_pdf() -> dict:
    if not INPUT_FILE.is_file():
        raise ApiError(400, "还没有 input.js，请先完成向导")
    try:
        import generate_pdf  # 依赖 reportlab，按需导入
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.startswith("reportlab"):
            raise ApiError(500, "生成 PDF 需要先安装 reportlab：在命令行运行  pip install reportlab  后重新启动向导")
        raise
    with PDF_LOCK:
        try:
            summary = generate_pdf.generate(INPUT_FILE, PDF_FILE)
        except ValueError as exc:
            raise ApiError(400, f"数据有问题，无法生成 PDF：{exc}")
    return {"ok": True, "url": f"/family_tree.pdf?t={int(time.time())}", "summary": summary}


class Handler(http.server.SimpleHTTPRequestHandler):
    port = 0  # 启动后赋值

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---------- 安全检查 ----------
    def allowed_hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    def is_trusted(self) -> bool:
        # Host 检查：防止其他网站通过 DNS 重绑定访问
        if self.headers.get("Host", "") not in self.allowed_hosts():
            return False
        # 只允许本页面自己发起的请求（防止其他网站嵌入 input.js 读走家族数据）
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site not in ("same-origin", "none"):
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {"http://" + h for h in self.allowed_hosts()}:
            return False
        return True

    def path_only(self) -> str:
        return urlparse(self.path).path

    # ---------- 响应 ----------
    def end_headers(self):
        if self.path_only().startswith(NO_STORE_PREFIXES):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # 不在终端刷屏

    def read_body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ApiError(413, f"内容太大（上限 {limit // 1024 // 1024} MB）")
        return self.rfile.read(length) if length > 0 else b""

    # ---------- 路由 ----------
    def do_GET(self):
        path = self.path_only()
        if not self.is_trusted():
            self.send_error(403)
            return
        if any(part.startswith(".") for part in path.split("/") if part):
            self.send_error(404)
            return
        if path == "/api/ping":
            self.send_json(200, {"app": "root-trace"})
            return
        if path.startswith("/api/"):
            self.send_json(404, {"error": "未知接口"})
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.is_trusted():
            self.send_error(403)
            return
        super().do_HEAD()

    def do_POST(self):
        if not self.is_trusted():
            self.send_json(403, {"error": "拒绝访问"})
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/input":
                try:
                    data = json.loads(self.read_body(MAX_JSON_BYTES).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise ApiError(400, "数据不是有效的 JSON")
                self.send_json(200, save_input(data))
            elif parsed.path == "/api/photo":
                query = parse_qs(parsed.query)
                member_id = (query.get("id") or [""])[0]
                ext = (query.get("ext") or [""])[0]
                self.send_json(200, save_photo(member_id, ext, self.read_body(MAX_PHOTO_BYTES)))
            elif parsed.path == "/api/pdf":
                self.send_json(200, make_pdf())
            else:
                self.send_json(404, {"error": "未知接口"})
        except ApiError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except Exception as exc:  # 意外错误也给页面一个可读的说明
            print(f"出错：{exc!r}", file=sys.stderr)
            self.send_json(500, {"error": f"出错了：{exc}"})


def create_server(first_port: int) -> http.server.ThreadingHTTPServer:
    for port in range(first_port, first_port + 20):
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        except OSError:
            continue
        Handler.port = server.server_address[1]
        return server
    raise SystemExit(f"端口 {first_port}~{first_port + 19} 都被占用了，请关闭其他程序后重试。")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="启动 Root Trace 建族谱向导")
    parser.add_argument("--port", type=int, default=8765, help="起始端口（默认 8765）")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args(argv)

    server = create_server(args.port)
    url = f"http://127.0.0.1:{Handler.port}/wizard.html"
    print("Root Trace 建族谱向导已启动")
    print(f"  浏览器地址：{url}")
    print(f"  项目文件夹：{ROOT}")
    print("  使用期间请不要关闭这个窗口；关闭窗口（或按 Ctrl+C）即可退出。")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
