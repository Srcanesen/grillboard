"""Server contracts and real HTTP/waiter entry points, using only stdlib."""

import fcntl
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
from urllib.error import HTTPError
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
        self.reject([], "Expected 1–50 answers")

    def test_too_many_items(self):
        self.reject([dict(ITEM, question=f"q{i}") for i in range(51)], "Expected 1–50 answers")

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

    def post(self, body=None, header=True):
        headers = {"Content-Type": "application/json"}
        if header:
            headers["X-Grill-Board"] = "1"
        request = Request(self.url + "api/answers", method="POST", headers=headers,
                          data=json.dumps(body if body is not None else {"items": [ITEM]}).encode())
        opener = build_opener(ProxyHandler({}))
        try:
            response = opener.open(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.code, json.load(response)

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

    def test_post_persists_batch(self):
        status, response = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(response["ok"], True)
        data = server.read_user(self.root)
        self.assertEqual(len(data["answers"]), 1)
        self.assertEqual(data["answers"][0]["id"], "a1")
        self.assertEqual(data["answers"][0]["items"], [{"question": "q1", "option": "a", "text": ""}])
        self.assertEqual(data["answers"], [response["batch"]])

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
