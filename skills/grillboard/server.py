#!/usr/bin/env python3
"""Serve a grilling board and persist user references and answers (standard library only)."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import ProxyHandler, build_opener


PREFIX = "window.__GRILL_USER__ = "
MAX_BODY = 15 * 1024 * 1024
TARGET = re.compile(r"[A-Za-z0-9_-]{1,40}(:[A-Za-z0-9_-]{1,40})?")
ANSWER_ID = re.compile(r"a([1-9][0-9]*)")
ITEM_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")
REF_ID = re.compile(r"u([1-9][0-9]*)")
IMAGES = {"image/png": "png", "image/jpeg": "jpg",
          "image/gif": "gif", "image/webp": "webp"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
         ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".gif": "image/gif", ".webp": "image/webp", ".md": "text/markdown; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".log": "text/plain; charset=utf-8"}


class RequestError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def inside(root, path):
    """Resolve symlinks before allowing either reads or writes."""
    resolved = Path(os.path.realpath(path))
    try:
        contained = os.path.commonpath((str(root), str(resolved))) == str(root)
    except ValueError:
        contained = False
    if not contained:
        raise OSError("Path escapes session directory")
    return resolved


def atomic_write(path, text):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=".grill-", delete=False) as out:
            temporary = out.name
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def process_lock(root, name, blocking=True):
    """Keep lock files in place: unlinking one can let two processes own a lock."""
    path = inside(root, root / name)
    with open(path, "a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if not blocking:
                        raise
                    time.sleep(0.05)
        else:
            import fcntl
            flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            fcntl.flock(handle.fileno(), flags)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def read_user(root):
    path = inside(root, root / "user.js")
    if not path.exists():
        return {"version": 1, "refs": [], "nextId": 1, "answers": [], "nextAnswerId": 1}
    text = path.read_text(encoding="utf-8")
    if not text.startswith(PREFIX) or not text.rstrip().endswith(";"):
        raise ValueError("Invalid user.js")
    data = json.loads(text[len(PREFIX):].rstrip()[:-1])
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("refs"), list):
        raise ValueError("Invalid user.js")
    highest = 0
    seen = set()
    for ref in data["refs"]:
        match = REF_ID.fullmatch(ref.get("id", "")) if isinstance(ref, dict) else None
        if match is None or ref["id"] in seen:
            raise ValueError("Invalid reference id in user.js")
        seen.add(ref["id"])
        highest = max(highest, int(match[1]))
    counter = data.get("nextId", highest + 1)
    if type(counter) is not int or counter < 1:
        raise ValueError("Invalid counter in user.js")
    data["nextId"] = max(counter, highest + 1)
    answers = data.get("answers", [])
    if not isinstance(answers, list):
        raise ValueError("Invalid answers in user.js")
    highest = 0
    seen = set()
    for batch in answers:
        match = ANSWER_ID.fullmatch(batch.get("id", "")) if isinstance(batch, dict) and isinstance(batch.get("id"), str) else None
        if (match is None or batch["id"] in seen or set(batch) != {"id", "sent", "items"}
                or not isinstance(batch["sent"], str)):
            raise ValueError("Invalid answer batch in user.js")
        try:
            datetime.strptime(batch["sent"], "%Y-%m-%dT%H:%M:%SZ")
            validate_items(batch["items"])
        except (ValueError, RequestError):
            raise ValueError("Invalid answer batch in user.js") from None
        seen.add(batch["id"])
        highest = max(highest, int(match[1]))
    counter = data.get("nextAnswerId", highest + 1)
    if type(counter) is not int or counter < 1:
        raise ValueError("Invalid answer counter in user.js")
    data["answers"] = answers
    data["nextAnswerId"] = max(counter, highest + 1)
    return data


def validate_items(items):
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise RequestError(400, "Expected 1–50 answers")
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"question", "option", "text"}:
            raise RequestError(400, "Expected question, option and text")
        question, option, text = item["question"], item["option"], item["text"]
        if not isinstance(question, str) or not ITEM_ID.fullmatch(question) or question in seen:
            raise RequestError(400, "Bad or duplicate question")
        seen.add(question)
        if option is not None and (not isinstance(option, str) or not ITEM_ID.fullmatch(option)):
            raise RequestError(400, "Bad option")
        if not isinstance(text, str) or len(text) > 2000 or (option is None and not text.strip()):
            raise RequestError(400, "Bad or empty answer text")
    return items


def write_user(root, data):
    inside(root, root / "user.js")
    atomic_write(root / "user.js", PREFIX + json.dumps(data, indent=2, ensure_ascii=False) + ";\n")


def valid_target(value):
    if not isinstance(value, str) or (value and not TARGET.fullmatch(value)):
        raise RequestError(400, "Bad target")
    return value


class BoardHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def parse_request(self):
        if not super().parse_request():
            return False
        self.server.last_request = time.monotonic()
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_port
        if len(hosts) != 1 or hosts[0] not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self.send_error(403, "Bad Host")
            return False
        if self.is_api() and self.command != "GET" and self.headers.get_all("X-Grill-Board", []) != ["1"]:
            self.send_error(403, "Missing board header")
            return False
        return True

    def is_api(self):
        return self.path.partition("?")[0].startswith("/api/")

    def send_error(self, code, message=None, explain=None):
        self.json_response(code, {"ok": False, "error": message or "Request failed"})

    def json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if getattr(self, "command", None) != "HEAD":
            self.wfile.write(body)

    def body(self):
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]) or self.headers.get("Transfer-Encoding"):
            raise RequestError(400, "Content-Length required")
        digits = lengths[0].lstrip("0") or "0"
        limit = str(MAX_BODY)
        if len(digits) > len(limit) or (len(digits) == len(limit) and digits > limit):
            raise RequestError(413, "Body too large")
        length = int(digits)
        if length == 0:
            raise RequestError(400, "Empty body")
        try:
            body = self.rfile.read(min(length, MAX_BODY + 1))
        except TimeoutError:
            raise RequestError(400, "Incomplete body") from None
        if len(body) != length:
            raise RequestError(400, "Incomplete body")
        return body

    def json_body(self):
        if self.headers.get_content_type() != "application/json":
            raise RequestError(415, "JSON required")
        def reject_constant(value):
            raise ValueError("Invalid JSON constant")
        try:
            data = json.loads(self.body(), parse_constant=reject_constant)
            # Escaped lone surrogates cannot be persisted as UTF-8.
            json.dumps(data, ensure_ascii=False).encode("utf-8")
        except (UnicodeError, ValueError, RecursionError):
            raise RequestError(400, "Bad JSON") from None
        if not isinstance(data, dict):
            raise RequestError(400, "Bad JSON")
        return data

    def do_GET(self):
        self.dispatch()

    def do_HEAD(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def do_OPTIONS(self):
        self.send_error(403, "OPTIONS forbidden")

    def dispatch(self):
        try:
            path = self.path.partition("?")[0]
            if self.is_api():
                if path == "/api/ping" and self.command == "GET":
                    self.json_response(200, {"ok": True, "board": 1})
                elif path == "/api/answers" and self.command == "POST":
                    self.add_answers()
                elif path == "/api/refs" and self.command == "POST":
                    self.add_ref()
                elif path.startswith("/api/refs/") and self.command in ("POST", "DELETE"):
                    self.change_ref(path[len("/api/refs/"):])
                else:
                    raise RequestError(404, "Unknown API path or method")
            elif self.command in ("GET", "HEAD"):
                self.static_file(path)
            else:
                raise RequestError(404, "Unknown path or method")
        except RequestError as error:
            self.send_error(error.status, error.message)
        except (OSError, ValueError, TypeError, RecursionError):
            self.send_error(500, "Could not read or save session")

    def add_answers(self):
        data = self.json_body()
        if set(data) != {"items"}:
            raise RequestError(400, "Expected items only")
        items = validate_items(data["items"])
        with self.server.user_lock:
            data = read_user(self.server.root)
            batch = {"id": f"a{data['nextAnswerId']}",
                     "sent": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "items": items}
            data["nextAnswerId"] += 1
            data["answers"].append(batch)
            write_user(self.server.root, data)
        self.json_response(200, {"ok": True, "batch": batch})

    def add_ref(self):
        content_type = self.headers.get_content_type()
        picture = None
        name = ""
        if content_type == "application/json":
            data = self.json_body()
            src = data.get("url")
            if not isinstance(src, str) or not src or len(src) > 2000 or any(c.isspace() or ord(c) < 32 for c in src):
                raise RequestError(400, "Bad URL")
            try:
                url = urlsplit(src)
                if url.scheme not in ("http", "https") or not url.hostname:
                    raise ValueError()
                url.port  # Validate a supplied port as well.
            except ValueError:
                raise RequestError(400, "Bad URL") from None
            target = valid_target(data.get("target", ""))
            kind = "link"
        elif content_type in IMAGES:
            query = parse_qs(self.path.partition("?")[2], keep_blank_values=True)
            target = valid_target(query.get("target", [""])[0])
            original = query.get("name", [""])[0]
            name = "".join(c for c in original if c not in "/\\" and not unicodedata.category(c).startswith("C"))[:200]
            picture = self.body()
            kind = "image"
        else:
            raise RequestError(415, "Unsupported picture type")
        root = self.server.root
        with self.server.user_lock:
            data = read_user(root)
            ref_id = f"u{data['nextId']}"
            data["nextId"] += 1
            # Reserve the id before writing a picture, including across a crash.
            write_user(root, data)
            if picture is not None:
                refs = inside(root, root / "refs")
                refs.mkdir(exist_ok=True)
                src = f"refs/{ref_id}.{IMAGES[content_type]}"
                picture_path = inside(root, root / src)
                # Exclusive creation refuses overwriting an existing file.
                with open(picture_path, "xb") as out:
                    out.write(picture)
            ref = {"id": ref_id, "kind": kind, "src": src, "name": name,
                   "target": target, "note": "",
                   "added": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            data["refs"].append(ref)
            try:
                write_user(root, data)
            except Exception:
                if picture is not None:
                    picture_path.unlink(missing_ok=True)
                raise
        self.json_response(200, {"ok": True, "ref": ref})

    def change_ref(self, ref_id):
        if not REF_ID.fullmatch(ref_id):
            raise RequestError(404, "Unknown reference")
        patch = self.json_body() if self.command == "POST" else None
        if patch is not None:
            if not patch or any(key not in ("target", "note") for key in patch):
                raise RequestError(400, "Expected target or note")
            if "target" in patch:
                valid_target(patch["target"])
            if "note" in patch and (not isinstance(patch["note"], str) or len(patch["note"]) > 2000):
                raise RequestError(400, "Bad note")
        root = self.server.root
        with self.server.user_lock:
            data = read_user(root)
            ref = next((item for item in data["refs"] if item["id"] == ref_id), None)
            if ref is None:
                raise RequestError(404, "Unknown reference")
            if patch is not None:
                ref.update(patch)
            else:
                if ref.get("kind") == "image":
                    src = ref.get("src", "")
                    if (not isinstance(src, str) or not src.startswith("refs/")
                            or "\\" in src or "\0" in src
                            or any(not part or part.startswith(".") for part in src.split("/")[1:])):
                        raise ValueError("Invalid image path")
                    refs = inside(root, root / "refs")
                    inside(refs, inside(root, root / src)).unlink(missing_ok=True)
                data["refs"].remove(ref)
            write_user(root, data)
        self.json_response(200, {"ok": True, "ref": ref} if patch is not None else {"ok": True})

    def static_file(self, path):
        decoded = unquote(path).replace("\\", "/")
        segments = decoded.split("/")
        if any(segment.startswith(".") or segment == "server.json" for segment in segments) or "\0" in decoded:
            raise RequestError(404, "File not found")
        try:
            file_path = inside(self.server.root, self.server.root / (decoded.lstrip("/") or "index.html"))
            # Also hide private names reached through a symlink alias.
            relative = file_path.relative_to(self.server.root)
            if any(part.startswith(".") or part == "server.json" for part in relative.parts):
                raise OSError("Private file")
            with open(file_path, "rb") as source:
                size = os.fstat(source.fileno()).st_size
                self.send_response(200)
                self.send_header("Content-Type", TYPES.get(file_path.suffix.lower(), "application/octet-stream"))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(size))
                self.end_headers()
                if self.command != "HEAD":
                    remaining = size
                    while remaining:
                        chunk = source.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except OSError:
            raise RequestError(404, "File not found") from None


def live_url(root):
    try:
        state = json.loads(inside(root, root / "server.json").read_text(encoding="utf-8"))
        url = state["url"]
        if not isinstance(url, str) or not re.fullmatch(r"http://127\.0\.0\.1:[0-9]+/", url):
            return None
        # Never consult environment proxies or follow a redirect off loopback.
        from urllib.request import HTTPRedirectHandler
        class NoRedirect(HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(url + "api/ping", timeout=1) as response:
            data = json.loads(response.read(4096))
            return url if isinstance(data, dict) and data.get("ok") is True else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def launch(root, args):
    with process_lock(root, ".server-launch.lock"):
        url = live_url(root)
        if url:
            print(url, flush=True)
            return 0
        (root / "server.json").unlink(missing_ok=True)
        command = [sys.executable, str(Path(__file__).resolve()), str(root), "--serve",
                   "--port", str(args.port), "--idle-minutes", str(args.idle_minutes)]
        options = {"start_new_session": True} if os.name != "nt" else {
            "creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
        with open(os.devnull, "r+b") as null:
            subprocess.Popen(command, stdin=null, stdout=null, stderr=null, **options)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            url = live_url(root)
            if url:
                print(url, flush=True)
                return 0
            time.sleep(0.05)
        print("Could not start board server within 5 seconds", file=sys.stderr)
        return 1


def serve(root, args):
    with process_lock(root, ".server.lock", blocking=False):
        with ThreadingHTTPServer(("127.0.0.1", args.port), BoardHandler) as server:
            server.daemon_threads = True
            server.block_on_close = False
            server.root = root
            # The board polls user.js every second; an empty one saves it a 404 each time.
            if not (root / "user.js").exists():
                write_user(root, read_user(root))
            server.user_lock = threading.Lock()
            server.last_request = time.monotonic()
            server.timeout = 0.25
            stopping = threading.Event()
            def stop(signum, frame):
                stopping.set()
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, stop)
            url = f"http://127.0.0.1:{server.server_port}/"
            try:
                atomic_write(root / "server.json", json.dumps({"url": url, "pid": os.getpid()}))
                print(url, flush=True)
                while not stopping.is_set() and time.monotonic() - server.last_request < args.idle_minutes * 60:
                    server.handle_request()
            finally:
                try:
                    state = json.loads((root / "server.json").read_text(encoding="utf-8"))
                    if state.get("pid") == os.getpid():
                        (root / "server.json").unlink()
                except (OSError, ValueError, AttributeError):
                    pass
    return 0


def wait_answers(root, args):
    stopping = threading.Event()
    def stop(signum, frame):
        stopping.set()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    # Acquire separately so a file-read error is not mistaken for a busy lock.
    lock = process_lock(root, ".wait.lock", blocking=False)
    try:
        lock.__enter__()
    except BlockingIOError:
        print(json.dumps({"answers": [], "alreadyWaiting": True}), flush=True)
        return 3
    except OSError as error:
        if os.name != "nt" or error.errno not in (13, 36):
            raise
        print(json.dumps({"answers": [], "alreadyWaiting": True}), flush=True)
        return 3
    try:
        after = int(args.after[1:]) if args.after else 0
        deadline = time.monotonic() + args.timeout_minutes * 60
        while not stopping.is_set():
            try:
                batches = sorted((batch for batch in read_user(root)["answers"]
                                  if int(batch["id"][1:]) > after), key=lambda batch: int(batch["id"][1:]))
            except (OSError, ValueError, TypeError, RecursionError):
                batches = []
            if batches:
                print(json.dumps({"answers": batches}, ensure_ascii=False), flush=True)
                return 0
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                print(json.dumps({"answers": [], "timeout": True}), flush=True)
                return 2
            stopping.wait(min(0.5, remaining))
        return 0
    finally:
        lock.__exit__(None, None, None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_dir")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--serve", action="store_true")
    modes.add_argument("--wait-answers", action="store_true")
    parser.add_argument("--after", default="")
    parser.add_argument("--timeout-minutes", type=float, default=120)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--idle-minutes", type=float, default=30)
    args = parser.parse_args()
    root = Path(os.path.realpath(args.session_dir))
    if not root.is_dir():
        parser.error("session_dir must be an existing directory")
    if not 0 <= args.port <= 65535 or not 0 < args.idle_minutes < float("inf"):
        parser.error("port must be 0–65535 and idle-minutes must be positive and finite")
    if args.after and not ANSWER_ID.fullmatch(args.after):
        parser.error("after must be an answer batch id such as a3")
    if not 0 < args.timeout_minutes < float("inf"):
        parser.error("timeout-minutes must be positive and finite")
    try:
        if args.wait_answers:
            return wait_answers(root, args)
        return serve(root, args) if args.serve else launch(root, args)
    except (OSError, ValueError) as error:
        print(f"Board server: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
