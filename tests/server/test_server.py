"""Server contracts and real HTTP/waiter entry points, using only stdlib."""

from contextlib import redirect_stdout
from concurrent.futures import ThreadPoolExecutor
import fcntl
import io
import importlib.util
import json
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[2]
SERVER_PATH = ROOT / "skills/grillboard/server.py"
SPEC = importlib.util.spec_from_file_location("grillboard_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)
ITEM = {"question": "q1", "option": "a", "text": ""}


def batch(number):
    return {"id": f"a{number}", "sent": "2026-10-12T09:00:00Z", "items": [dict(ITEM)]}


class ReadUserTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def write(self, data):
        (self.root / "user.js").write_text(server.PREFIX + json.dumps(data) + ";\n")

    def test_missing_file(self):
        self.assertEqual(server.read_user(self.root), {
            "version": 1, "refs": [], "nextId": 1, "answers": [], "nextAnswerId": 1})

    def test_legacy_file(self):
        self.write({"version": 1, "refs": [{"id": "u2"}]})
        self.assertEqual(server.read_user(self.root), {
            "version": 1, "refs": [{"id": "u2"}], "nextId": 3,
            "answers": [], "nextAnswerId": 1})

    def test_bad_prefix(self):
        (self.root / "user.js").write_text('window.other = {"version": 1, "refs": []};')
        with self.assertRaises(ValueError):
            server.read_user(self.root)

    def test_wrong_version(self):
        self.write({"version": 2, "refs": []})
        with self.assertRaises(ValueError):
            server.read_user(self.root)

    def test_duplicate_reference_id(self):
        self.write({"version": 1, "refs": [{"id": "u1"}, {"id": "u1"}]})
        with self.assertRaises(ValueError):
            server.read_user(self.root)

    def test_duplicate_batch_id(self):
        self.write({"version": 1, "refs": [], "answers": [batch(1), batch(1)]})
        with self.assertRaises(ValueError):
            server.read_user(self.root)

    def test_optional_answer_request_id(self):
        answers = [batch(1), dict(batch(2), requestId="retry-1")]
        self.write({"version": 1, "refs": [], "answers": answers})
        self.assertEqual(server.read_user(self.root)["answers"], answers)

    def test_invalid_or_duplicate_stored_request_id(self):
        for answers in ([dict(batch(1), requestId=None)],
                        [dict(batch(1), requestId="bad id")],
                        [dict(batch(1), requestId="same"), dict(batch(2), requestId="same")]):
            with self.subTest(answers=answers):
                self.write({"version": 1, "refs": [], "answers": answers})
                with self.assertRaises(ValueError):
                    server.read_user(self.root)

    def test_low_counters_corrected(self):
        self.write({"version": 1, "refs": [{"id": "u7"}], "nextId": 2,
                    "answers": [batch(12)], "nextAnswerId": 3})
        data = server.read_user(self.root)
        self.assertEqual(data["nextId"], 8)
        self.assertEqual(data["nextAnswerId"], 13)


class ValidateItemsTests(unittest.TestCase):
    def reject(self, items, message):
        with self.assertRaises(server.RequestError) as raised:
            server.validate_items(items)
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.message, message)

    def test_valid_option(self):
        self.assertEqual(server.validate_items([dict(ITEM)]),
                         [{"question": "q1", "option": "a", "text": ""}])

    def test_valid_text(self):
        self.assertEqual(server.validate_items([{"question": "q2", "option": None, "text": "Own answer"}]),
                         [{"question": "q2", "option": None, "text": "Own answer"}])

    def test_no_items(self):
        self.reject([], "Expected a non-empty list of answers")

    def test_large_frontier(self):
        items = [dict(ITEM, question=f"q{i}") for i in range(1000)]
        self.assertEqual(server.validate_items(items), items)

    def test_bad_question_id(self):
        self.reject([dict(ITEM, question="q:1")], "Bad or duplicate question")

    def test_bad_option_id(self):
        self.reject([dict(ITEM, option="a b")], "Bad option")

    def test_duplicate_question(self):
        self.reject([dict(ITEM), dict(ITEM, option="b")], "Bad or duplicate question")

    def test_non_string_text(self):
        self.reject([dict(ITEM, text=1)], "Bad or empty answer text")

    def test_long_text(self):
        self.reject([dict(ITEM, text="x" * 2001)], "Bad or empty answer text")

    def test_neither_option_nor_text(self):
        self.reject([dict(ITEM, option=None, text=" ")], "Bad or empty answer text")

    def test_unknown_key(self):
        self.reject([dict(ITEM, extra=True)], "Expected question, option and text")


class NewBatchesTests(unittest.TestCase):
    def test_no_batches(self):
        self.assertEqual(server.answer_batches_after({"answers": []}, ""), [])

    def test_empty_after(self):
        self.assertEqual(server.answer_batches_after({"answers": [batch(1), batch(2)]}, ""),
                         [batch(1), batch(2)])

    def test_after_newest(self):
        self.assertEqual(server.answer_batches_after({"answers": [batch(1), batch(2)]}, "a2"), [])

    def test_out_of_order(self):
        self.assertEqual(server.answer_batches_after({"answers": [batch(10), batch(2), batch(1)]}, "a1"),
                         [batch(2), batch(10)])

    def test_invalid_after_counts_as_none(self):
        for after in ("invalid", "a0", "a01", "a-1"):
            with self.subTest(after=after):
                self.assertEqual(server.answer_batches_after({"answers": [batch(1)]}, after), [batch(1)])

    def test_id_numbers(self):
        self.assertEqual(server.answer_id_number("a12"), 12)
        self.assertEqual(server.answer_id_number(""), 0)
        self.assertEqual(server.answer_id_number("invalid"), 0)


class EntryPointTests(unittest.TestCase):
    def setUp(self):
        self.processes = []
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        # Cleanup also runs if server startup fails during setUp.
        self.addCleanup(self.stop_processes)
        process = self.start("--serve", "--port", "0")
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(timeout=5), "Server did not print its URL")
        self.url = process.stdout.readline().strip()
        if not self.url:
            self.fail("Server startup failed: " + process.communicate(timeout=2)[1])
        self.assertRegex(self.url, r"^http://127\.0\.0\.1:[0-9]+/$")

    def start(self, *args):
        process = subprocess.Popen([sys.executable, str(SERVER_PATH), str(self.root), *args],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        return process

    def stop_processes(self):
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=2)
        self.temporary.cleanup()

    def tearDown(self):
        self.stop_processes()

    def post(self, body=None, header=True, request_id=None):
        headers = {"Content-Type": "application/json"}
        if header:
            headers["X-Grill-Board"] = "1"
        path = "api/answers" + ("?requestId=" + quote(request_id, safe="") if request_id is not None else "")
        request = Request(self.url + path, method="POST", headers=headers,
                          data=json.dumps(body if body is not None else {"items": [ITEM]}).encode())
        opener = build_opener(ProxyHandler({}))
        try:
            response = opener.open(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.code, json.load(response)

    def request(self, path, method="GET", data=None, headers=None):
        request = Request(self.url + path, method=method, data=data,
                          headers={"X-Grill-Board": "1", **(headers or {})})
        opener = build_opener(ProxyHandler({}))
        try:
            response = opener.open(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.code, response.read()

    def test_failed_image_delete_preserves_reference_and_image(self):
        picture = b"picture data"
        status, body = self.request("api/refs?name=sample.png", "POST", picture,
                                    {"Content-Type": "image/png"})
        self.assertEqual(status, 200)
        ref = json.loads(body)["ref"]
        before = (self.root / "user.js").read_bytes()
        self.root.chmod(0o555)
        try:
            self.assertEqual(self.request("api/refs/" + ref["id"], "DELETE")[0], 500)
            self.assertEqual((self.root / "user.js").read_bytes(), before)
            self.assertEqual(server.read_user(self.root)["refs"], [ref])
            self.assertEqual(self.request(ref["src"]), (200, picture))
        finally:
            self.root.chmod(0o755)
        self.assertEqual(self.request("api/refs/" + ref["id"], "DELETE")[0], 200)
        self.assertEqual(server.read_user(self.root)["refs"], [])
        self.assertFalse((self.root / ref["src"]).exists())
        self.assertEqual(self.request(ref["src"])[0], 404)

    @unittest.skipIf(sys.platform == "win32", "Backslashes are path separators on Windows")
    def test_encoded_backslash_serves_literal_filename(self):
        refs = self.root / "refs"
        refs.mkdir()
        literal = refs / "plan\\draft.svg"
        picture = b"<svg><text>Literal filename</text></svg>"
        literal.write_bytes(picture)
        path = "refs/" + quote(literal.name, safe="")
        for nested_exists in (False, True):
            if nested_exists:
                nested = refs / "plan"
                nested.mkdir()
                (nested / "draft.svg").write_text("<svg><text>Wrong nested file</text></svg>")
            with self.subTest(nested_exists=nested_exists):
                self.assertEqual(self.request(path), (200, picture))

    def waiting(self, process):
        # Observe the actual lock, so the POST cannot outrun waiter startup.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            self.assertIsNone(process.poll(), "Waiter exited before acquiring its lock")
            path = self.root / ".wait.lock"
            if path.exists():
                with path.open("rb") as handle:
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        return
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            time.sleep(0.01)
        self.fail("Waiter did not acquire its lock")

    def test_ping_advertises_answer_request_id_support(self):
        status, body = self.request("api/ping")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {
            "ok": True, "board": 1, "session": str(self.root), "answerRequestIds": True})

    def test_post_persists_batch(self):
        status, response = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(response["ok"], True)
        data = server.read_user(self.root)
        self.assertEqual(len(data["answers"]), 1)
        self.assertEqual(data["answers"][0]["id"], "a1")
        self.assertEqual(data["answers"][0]["items"], [{"question": "q1", "option": "a", "text": ""}])
        self.assertEqual(data["answers"], [response["batch"]])

    def test_request_id_retry_survives_restart_and_reaches_waiter_once(self):
        body = {"items": [ITEM]}
        status, original = self.post(body, request_id="retry-1")
        self.assertEqual(status, 200)
        before = (self.root / "user.js").read_bytes()
        self.processes[0].terminate()
        self.processes[0].communicate(timeout=3)
        process = self.start("--serve", "--port", "0")
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(timeout=5), "Restarted server did not start")
        self.url = process.stdout.readline().strip()
        self.assertEqual(self.post(body, request_id="retry-1"), (200, original))
        self.assertEqual((self.root / "user.js").read_bytes(), before)
        status, changed = self.post({"items": [dict(ITEM, text="Different")]}, request_id="retry-2")
        self.assertEqual(status, 200)
        self.assertEqual(changed["batch"]["id"], "a2")
        self.assertEqual(server.read_user(self.root)["nextAnswerId"], 3)
        waiter = self.start("--wait-answers")
        output, errors = waiter.communicate(timeout=3)
        self.assertEqual(waiter.returncode, 0, errors)
        self.assertEqual(json.loads(output), {"answers": [original["batch"], changed["batch"]]})

    def test_concurrent_request_id_retries_save_one_batch(self):
        body = {"items": [ITEM]}
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.post(body, request_id="concurrent-1"), range(8)))
        self.assertEqual([status for status, _ in results], [200] * 8)
        self.assertEqual([response["batch"]["id"] for _, response in results], ["a1"] * 8)
        self.assertEqual(server.read_user(self.root)["answers"], [results[0][1]["batch"]])
        self.assertEqual(server.read_user(self.root)["nextAnswerId"], 2)

    def test_reused_request_id_with_different_answers_leaves_file_unchanged(self):
        self.assertEqual(self.post({"items": [ITEM]}, request_id="same-id")[0], 200)
        before = (self.root / "user.js").read_bytes()
        status, response = self.post({"items": [dict(ITEM, text="Changed")]}, request_id="same-id")
        self.assertEqual(status, 400)
        self.assertEqual(response, {"ok": False, "error": "Request id already used for different answers"})
        self.assertEqual((self.root / "user.js").read_bytes(), before)

    def test_invalid_request_id_leaves_file_unchanged(self):
        before = (self.root / "user.js").read_bytes()
        for request_id in ("", "bad id", "x" * 81):
            with self.subTest(request_id=request_id):
                status, response = self.post({"items": [ITEM]}, request_id=request_id)
                self.assertEqual(status, 400)
                self.assertEqual(response, {"ok": False, "error": "Bad request id"})
                self.assertEqual((self.root / "user.js").read_bytes(), before)

    def test_legacy_answer_requests_still_create_separate_batches(self):
        self.assertEqual(self.post()[1]["batch"]["id"], "a1")
        self.assertEqual(self.post()[1]["batch"]["id"], "a2")
        self.assertEqual([answer["items"] for answer in server.read_user(self.root)["answers"]], [[ITEM], [ITEM]])

    def test_large_frontier_persists_and_reaches_waiter(self):
        items = [dict(ITEM, question=f"q{i}") for i in range(1000)]
        status, response = self.post({"items": items})
        self.assertEqual(status, 200)
        self.assertEqual(response["batch"]["items"], items)
        self.assertEqual(server.read_user(self.root)["answers"], [response["batch"]])
        waiter = self.start("--wait-answers")
        output, errors = waiter.communicate(timeout=3)
        self.assertEqual(waiter.returncode, 0, errors)
        self.assertEqual(json.loads(output), {"answers": [response["batch"]]})

    def test_oversized_answer_request_leaves_file_unchanged(self):
        before = (self.root / "user.js").read_bytes()
        status, body = self.request("api/answers", "POST", b"{}", {
            "Content-Type": "application/json", "Content-Length": str(server.MAX_BODY + 1)})
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body), {"ok": False, "error": "Body too large"})
        self.assertEqual((self.root / "user.js").read_bytes(), before)

    def legacy_server(self, root, port=0):
        code = """import sys
sys.path.insert(0, sys.argv.pop(1))
import server
class LegacyHandler(server.BoardHandler):
    def dispatch(self):
        if self.path.partition("?")[0] == "/api/ping" and self.command == "GET":
            self.json_response(200, {"ok": True, "board": 1})
        else:
            super().dispatch()
server.BoardHandler = LegacyHandler
sys.exit(server.main())
"""
        process = subprocess.Popen(
            [sys.executable, "-c", code, str(SERVER_PATH.parent), str(root),
             "--serve", "--port", str(port)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(timeout=5), "Legacy server did not start")
        url = process.stdout.readline().strip()
        self.assertRegex(url, r"^http://127\.0\.0\.1:[0-9]+/$")
        return url

    def test_launch_reuses_own_legacy_server_and_preserves_state(self):
        self.processes[0].terminate()
        self.processes[0].communicate(timeout=3)
        self.url = self.legacy_server(self.root)
        before = (self.root / "server.json").read_bytes()
        launch = self.start()
        output, errors = launch.communicate(timeout=8)
        self.assertEqual(launch.returncode, 0, errors)
        self.assertEqual(output.strip(), self.url)
        self.assertEqual((self.root / "server.json").read_bytes(), before)
        self.assertEqual(self.post()[0], 200)
        self.assertEqual([answer["items"] for answer in server.read_user(self.root)["answers"]],
                         [[{"question": "q1", "option": "a", "text": ""}]])
        self.assertEqual(list(self.root.glob("grill-probe-*")), [])

    def test_launch_preserves_and_reuses_own_slow_server(self):
        self.processes[0].terminate()
        self.processes[0].communicate(timeout=3)
        code = """import sys, time
sys.path.insert(0, sys.argv.pop(1))
import server
class SlowHandler(server.BoardHandler):
    def dispatch(self):
        if self.path.partition("?")[0] == "/api/ping":
            time.sleep(1.3)
        super().dispatch()
server.BoardHandler = SlowHandler
sys.exit(server.main())
"""
        process = subprocess.Popen(
            [sys.executable, "-c", code, str(SERVER_PATH.parent), str(self.root),
             "--serve", "--port", "0"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(timeout=5), "Slow server did not start")
        self.url = process.stdout.readline().strip()
        before = (self.root / "server.json").read_bytes()
        popen = subprocess.Popen
        def tracked_start(*args, **kwargs):
            child = popen(*args, **kwargs)
            self.processes.append(child)
            return child
        output = io.StringIO()
        with patch.object(server.subprocess, "Popen", tracked_start), redirect_stdout(output):
            result = server.launch(self.root, SimpleNamespace(port=0, idle_minutes=30))
        self.assertEqual(result, 0)
        self.assertEqual(output.getvalue().strip(), self.url)
        self.assertEqual((self.root / "server.json").read_bytes(), before)
        self.assertEqual(len(self.processes), 2, "Launch must not start another server")
        self.assertEqual(self.post()[0], 200)

    def test_launch_times_out_when_live_server_has_lost_its_state(self):
        (self.root / "server.json").unlink()
        launch = self.start()
        output, errors = launch.communicate(timeout=7)
        self.assertEqual(launch.returncode, 1)
        self.assertEqual(output, "")
        self.assertIn("Could not verify existing board server within 5 seconds", errors)
        self.assertFalse((self.root / "server.json").exists())
        self.assertEqual(self.post()[0], 200, "The existing server must remain running")

    def test_launch_times_out_when_own_server_is_unresponsive(self):
        # Suspend only the server started by this test; its socket and lock stay held.
        import signal
        process = self.processes[0]
        before = (self.root / "server.json").read_bytes()
        process.send_signal(signal.SIGSTOP)
        try:
            launch = self.start()
            output, errors = launch.communicate(timeout=7)
            self.assertEqual(launch.returncode, 1)
            self.assertEqual(output, "")
            self.assertIn("Could not verify existing board server within 5 seconds", errors)
            self.assertEqual((self.root / "server.json").read_bytes(), before)
        finally:
            process.send_signal(signal.SIGCONT)

    def test_launch_reuses_same_folder_with_different_letter_case(self):
        alias = self.root.with_name(self.root.name.swapcase())
        if alias == self.root or not alias.exists() or not alias.samefile(self.root):
            self.skipTest("Case-insensitive filesystem required")
        before = (self.root / "server.json").read_bytes()
        launch = subprocess.run([sys.executable, str(SERVER_PATH), str(alias)],
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(launch.returncode, 0, launch.stderr)
        self.assertEqual(launch.stdout.strip(), self.url)
        self.assertEqual((self.root / "server.json").read_bytes(), before)
        self.assertEqual(self.post()[0], 200)
        self.assertEqual([answer["items"] for answer in server.read_user(alias)["answers"]],
                         [[{"question": "q1", "option": "a", "text": ""}]])

    def test_restart_saves_to_requested_session_when_old_port_is_reused(self):
        self.restart_with_reused_port(legacy=False)

    def test_restart_rejects_another_sessions_legacy_ping(self):
        self.restart_with_reused_port(legacy=True)

    def restart_with_reused_port(self, legacy):
        crashed = self.processes[0]
        crashed.kill()
        crashed.communicate(timeout=3)
        other = self.root / "other"
        other.mkdir()
        port = self.url.split(":")[2].rstrip("/")
        if legacy:
            self.assertEqual(self.legacy_server(other, port), self.url)
        else:
            listener = subprocess.Popen(
                [sys.executable, str(SERVER_PATH), str(other), "--serve", "--port", port],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.processes.append(listener)
            with selectors.DefaultSelector() as ready:
                ready.register(listener.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(timeout=5), "Other server did not start")
            self.assertEqual(listener.stdout.readline().strip(), self.url)

        # Keep handles to the real detached children so cleanup stops only our servers.
        popen = subprocess.Popen
        def tracked_start(*args, **kwargs):
            process = popen(*args, **kwargs)
            self.processes.append(process)
            return process
        output = io.StringIO()
        with patch.object(server.subprocess, "Popen", tracked_start), redirect_stdout(output):
            result = server.launch(self.root, SimpleNamespace(port=0, idle_minutes=30))
        self.assertEqual(result, 0)
        self.url = output.getvalue().strip()
        self.assertEqual(self.post()[0], 200)
        self.assertEqual([answer["items"] for answer in server.read_user(self.root)["answers"]],
                         [[{"question": "q1", "option": "a", "text": ""}]])
        self.assertEqual(server.read_user(other)["answers"], [])
        self.assertEqual(list(self.root.glob("grill-probe-*")), [])

    def test_missing_header_leaves_file_unchanged(self):
        before = (self.root / "user.js").read_bytes()
        self.assertEqual(self.post(header=False)[0], 403)
        self.assertEqual((self.root / "user.js").read_bytes(), before)

    def test_unknown_body_key_leaves_file_unchanged(self):
        before = (self.root / "user.js").read_bytes()
        self.assertEqual(self.post({"items": [ITEM], "extra": True})[0], 400)
        self.assertEqual((self.root / "user.js").read_bytes(), before)

    def test_waiter_receives_post(self):
        waiter = self.start("--wait-answers")
        self.waiting(waiter)
        status, response = self.post()
        self.assertEqual(status, 200)
        output, errors = waiter.communicate(timeout=3)
        self.assertEqual(waiter.returncode, 0, errors)
        self.assertEqual(json.loads(output), {"answers": [response["batch"]]})
        self.assertEqual(json.loads(output)["answers"][0]["items"],
                         [{"question": "q1", "option": "a", "text": ""}])

    def test_waiter_after_a1_times_out(self):
        self.assertEqual(self.post()[0], 200)
        waiter = self.start("--wait-answers", "--after", "a1", "--timeout-minutes", "0.02")
        output, errors = waiter.communicate(timeout=3)
        self.assertEqual(waiter.returncode, 2, errors)
        self.assertEqual(json.loads(output), {"answers": [], "timeout": True})

    def test_second_waiter_exits_three(self):
        first = self.start("--wait-answers")
        self.waiting(first)
        second = self.start("--wait-answers")
        output, errors = second.communicate(timeout=3)
        self.assertEqual(second.returncode, 3, errors)
        self.assertEqual(json.loads(output), {"answers": [], "alreadyWaiting": True})
        self.assertIsNone(first.poll())


class ExampleContractTests(unittest.TestCase):
    def test_demo_user_loads(self):
        data = server.read_user(ROOT / "examples/demo")
        self.assertEqual([ref["id"] for ref in data["refs"]], ["u1", "u2"])
        self.assertEqual(data["nextId"], 3)
        self.assertEqual(data["answers"], [])
        self.assertEqual(data["nextAnswerId"], 1)

    def test_skill_session_ids(self):
        text = (ROOT / "skills/grillboard/SKILL.md").read_text()
        code = re.search(r"```js\n(.*?)\n```", text, re.S).group(1)
        session = json.loads(code.removeprefix("window.__GRILL__ = ").strip().removesuffix(";"))
        self.assertGreater(len(session["questions"]), 0)
        for question in session["questions"]:
            self.assertIsNotNone(server.ITEM_ID.fullmatch(question["id"]))
            self.assertGreater(len(question["options"]), 0)
            for option in question["options"]:
                self.assertIsNotNone(server.ITEM_ID.fullmatch(option["id"]))


if __name__ == "__main__":
    unittest.main()
