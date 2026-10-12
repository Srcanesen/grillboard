#!/usr/bin/env python3
"""Replay the Recipe box board; requires Python Playwright, Chrome and ffmpeg."""

import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


# Each stage derives its cards from examples/demo/session.js. Closing answers are
# illustrative replay data, not claims about what the sample's user decided.
# Add a stage or an action here without changing the recording loop.
STAGES = [
    {"name": "Idea", "round": 0, "pause": 2},
    {"name": "First round", "round": 1, "asking": ["q1", "q2", "q3"],
     "pause": 4, "actions": [{"type": "focus", "ids": ["q1", "q2", "q3"]}]},
    {"name": "Answers and research", "round": 2,
     "asking": ["q4", "q5", "q6", "q8"], "research": "running", "refs": True,
     "pause": 5, "steps": [
         "Reading: SQLite appropriate uses for a small web app",
         "Reading: SQLite WAL mode and concurrent readers",
         "Comparing: deployment limits and backup requirements"],
     "actions": [{"type": "focus", "ids": ["q8"]},
                 {"type": "wait", "seconds": 1},
                 {"type": "focus", "ids": ["q2"]},
                 {"type": "wait", "seconds": 0.4},
                 {"type": "click", "selector": ".research-chip"},
                 {"type": "focus", "ids": ["q2"]}]},
    {"name": "First sketch", "round": 2,
     "asking": ["q4", "q5", "q6", "q8"], "research": "running", "refs": True,
     "sketch": True, "pause": 4,
     "actions": [{"type": "focus", "ids": ["sketch:k1"]}]},
    {"name": "Settled decisions", "round": 3, "research": "done",
     "refs": True, "sketch": True, "pause": 4,
     "answers": {
         "q4": [None, "Members sign in with a shared family passcode."],
         "q5": ["b", "Anyone in the family can edit a recipe, with history."],
         "q6": [None, "The app runs on one host with persistent storage."],
         "q8": ["b", "The home screen is a grid of recipe photos."],
         "q7": ["a", "A public link shares a recipe outside the family."]},
     "actions": [{"type": "focus", "ids": ["q2", "report:s1", "q5"]}]},
    {"name": "Spec", "inherit": True, "pause": 5,
     "actions": [{"type": "click", "selector": "#spec-toggle"},
                 {"type": "focus", "ids": ["q1", "q4", "q7"]}]},
]

ROOT = Path(__file__).resolve().parents[1]
FFMPEG = "/opt/homebrew/bin/ffmpeg"


def read_assignment(path):
    return json.loads(path.read_text().split("=", 1)[1].strip().removesuffix(";"))


def write_assignment(path, variable, data):
    pending = path.with_suffix(".tmp")
    pending.write_text(variable + " = " + json.dumps(data, indent=2) + ";\n")
    pending.replace(path)


def session_for(final, stage, previous):
    if stage.get("inherit"):
        return copy.deepcopy(previous)
    data = copy.deepcopy(final)
    data["status"] = "done" if stage.get("answers") else "active"
    data["questions"] = [q for q in data["questions"] if q["round"] <= stage["round"]]
    for q in data["questions"]:
        q.pop("reopened", None)
        if q["id"] in stage.get("asking", []):
            q.update(status="asking", answer=None, decision="")
        if q["id"] in stage.get("answers", {}):
            option, decision = stage["answers"][q["id"]]
            q.update(status="settled", answer={"option": option, "text": decision}, decision=decision)
    data["architecture"] = data["architecture"] if stage["round"] >= 2 else []
    data["refs"] = data["refs"] if stage.get("refs") else []
    data["sketches"] = data["sketches"] if stage.get("sketch") else []
    data["research"] = data["research"][:1] if stage.get("research") else []
    if data["research"]:
        data["research"][0]["status"] = stage["research"]
        if stage["research"] == "running":
            data["research"][0].update(finding="", sources=[], report="")
    return data


class Recording:
    """Capture full viewport frames at 10 fps, without browser video padding."""

    def __init__(self, page, folder):
        self.page, self.folder, self.frames = page, folder, 0
        folder.mkdir()

    def pause(self, seconds):
        started = time.monotonic()
        for index in range(round(seconds * 10)):
            self.page.screenshot(path=str(self.folder / f"frame-{self.frames:05d}.png"))
            self.frames += 1
            remaining = started + (index + 1) / 10 - time.monotonic()
            if remaining > 0:
                self.page.wait_for_timeout(remaining * 1000)


def action(page, item, recording):
    if item["type"] == "click":
        page.locator(item["selector"]).click()
    elif item["type"] == "scroll":
        page.mouse.wheel(item.get("x", 0), item.get("y", 300))
    elif item["type"] == "wait":
        recording.pause(item["seconds"])
    elif item["type"] == "focus":
        # Use the board's camera, leaving its content and layout untouched.
        page.evaluate("ids => focusView(true, ids)", item["ids"])
    else:
        raise ValueError("Unknown page action: " + item["type"])


def main():
    (ROOT / "docs").mkdir(exist_ok=True)
    server = None
    with tempfile.TemporaryDirectory(prefix="visual-grilling-demo-") as temporary:
        work = Path(temporary)
        session = work / "session"
        shutil.copytree(ROOT / "examples/demo", session)
        shutil.copyfile(ROOT / "skills/visual-grilling/viewer.html", session / "index.html")
        final = read_assignment(session / "session.js")
        user = read_assignment(session / "user.js")
        initial = session_for(final, STAGES[0], None)
        write_assignment(session / "session.js", "window.__GRILL__", initial)
        write_assignment(session / "user.js", "window.__GRILL_USER__", {"version": 1, "refs": []})
        (session / "research/s1.log").write_text("")
        try:
            server = subprocess.Popen(
                [sys.executable, str(ROOT / "skills/visual-grilling/server.py"),
                 str(session), "--serve"], stdout=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 10
            while not (session / "server.json").exists():
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Board server did not start")
                time.sleep(0.05)
            url = json.loads((session / "server.json").read_text())["url"]
            with urlopen(url + "api/ping") as response:
                assert json.load(response)["ok"] is True
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    context = browser.new_context(
                        viewport={"width": 1280, "height": 800}, color_scheme="light")
                    page = context.new_page()
                    page.goto(url)
                    page.locator(".idea-card").wait_for()
                    page.locator("#spec-toggle").click()  # start with the board unobstructed
                    page.wait_for_timeout(250)
                    recording = Recording(page, work / "frames")
                    previous = initial
                    for stage in STAGES:
                        data = session_for(final, stage, previous)
                        write_assignment(session / "session.js", "window.__GRILL__", data)
                        write_assignment(session / "user.js", "window.__GRILL_USER__",
                                         user if stage.get("refs") or stage.get("inherit") else {"version": 1, "refs": []})
                        signature = {
                            "questions": [[q["id"], q["status"]] for q in data["questions"]],
                            "sketches": len(data["sketches"]),
                            "research": [n["status"] for n in data["research"]],
                        }
                        page.wait_for_function("""expected => currentSession &&
                            JSON.stringify(currentSession.questions.map(q => [q.id, q.status])) === JSON.stringify(expected.questions) &&
                            currentSession.sketches.length === expected.sketches &&
                            JSON.stringify(currentSession.research.map(n => n.status)) === JSON.stringify(expected.research)
                        """, arg=signature)
                        for item in stage.get("actions", []):
                            action(page, item, recording)
                        steps = stage.get("steps", [])
                        for line in steps:
                            with (session / "research/s1.log").open("a") as log:
                                log.write(line + "\n")
                            recording.pause(stage["pause"] / len(steps))
                        if not steps:
                            recording.pause(stage["pause"])
                        if stage["name"] == "First round":
                            assert page.locator(".question-card.asking").count() == 3
                        if steps:
                            assert page.locator(".research-step").count() > 0
                        if stage.get("sketch"):
                            assert page.locator(".sketch-card iframe").count() > 0
                        print(stage["name"], flush=True)
                        previous = data
                    duration = recording.frames / 10
                    assert 20 <= duration <= 35, duration
                    assert page.locator("#spec-toggle").get_attribute("aria-expanded") == "true"
                    assert "The home screen is a grid" in page.locator("#spec-content").inner_text()
                    assert not page.locator("#warning").is_visible()
                    # Still: the entire board, with the spec collapsed so all nodes fit.
                    page.locator("#spec-toggle").click()
                    page.get_by_role("button", name="Fit to screen", exact=True).click()
                    page.wait_for_timeout(500)
                    page.screenshot(path=str(work / "board.png"))
                    context.close()
                finally:
                    browser.close()
            video = str(work / "recording.mkv")
            subprocess.run([FFMPEG, "-v", "error", "-y", "-framerate", "10", "-i",
                            str(work / "frames/frame-%05d.png"), "-c:v", "ffv1", video], check=True)
            filters = "fps=10,scale=960:-1:flags=lanczos"
            subprocess.run([FFMPEG, "-v", "error", "-y", "-i", video, "-vf",
                            filters + ",palettegen=stats_mode=diff", str(work / "palette.png")], check=True)
            subprocess.run([FFMPEG, "-v", "error", "-y", "-i", video, "-i", str(work / "palette.png"),
                            "-lavfi", f"[0:v]{filters}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
                            "-loop", "0", str(work / "demo.gif")], check=True)
            size = (work / "demo.gif").stat().st_size
            assert size <= 8_000_000, f"GIF exceeds 8 MB: {size}"
            shutil.copyfile(work / "demo.gif", ROOT / "docs/demo.gif")
            shutil.copyfile(work / "board.png", ROOT / "docs/board.png")
            print(f"Chrome; {duration:.1f} seconds; {size:,} bytes; 960 × 600 at 10 fps")
        finally:
            if server is not None and server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == "__main__":
    main()
