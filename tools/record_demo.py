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
    {"name": "Idea", "round": 0, "pause": 1.5},
    {"name": "First round", "round": 1, "asking": ["q1", "q2", "q3"],
     "pause": 0, "actions": [
         {"type": "focus", "ids": ["q1"]}, {"type": "wait", "seconds": 0.6},
         {"type": "click", "selector": '[data-question-id="q1"] [data-answer-option="b"] .option-label'},
         {"type": "wait", "seconds": 1},
         {"type": "focus", "ids": ["q3"]}, {"type": "wait", "seconds": 0.4},
         {"type": "fill", "question": "q3", "text": "Several photos per recipe, grandma's handwritten cards matter."},
         {"type": "wait", "seconds": 0.5},
         {"type": "click", "selector": '#round-bar button[aria-label="Pick the recommendations"]'},
         {"type": "focus", "ids": ["q2"]}, {"type": "wait", "seconds": 0.7},
         {"type": "send", "expected": {
             "q1": {"option": "b", "text": ""}, "q2": {"option": "b", "text": ""},
             "q3": {"option": None, "text": "Several photos per recipe, grandma's handwritten cards matter."}}}]},
    {"name": "Answers and research", "round": 2,
     "asking": ["q4", "q5", "q6", "q8"], "research": "running", "refs": True,
     "pause": 3.9, "steps": [
         "Reading: SQLite appropriate uses for a small web app",
         "Reading: SQLite WAL mode and concurrent readers",
         "Comparing: deployment limits and backup requirements"],
     "actions": [{"type": "focus", "ids": ["q2"]},
                 {"type": "wait", "seconds": 0.4},
                 {"type": "click", "selector": ".research-chip"},
                 {"type": "focus", "ids": ["q2"]}]},
    {"name": "First sketch", "round": 2,
     "asking": ["q4", "q5", "q6", "q8"], "research": "running", "refs": True,
     "sketch": True, "pause": 3,
     "actions": [{"type": "focus", "ids": ["sketch:k1"]}]},
    {"name": "Choose a layout", "inherit": True, "pause": 0, "actions": [
         {"type": "focus", "ids": ["q8"]}, {"type": "wait", "seconds": 3},
         {"type": "click", "selector": '[data-question-id="q8"] [data-answer-option="b"] .option-label'},
         {"type": "wait", "seconds": 1.2},
         {"type": "focus", "ids": ["q6"]}, {"type": "wait", "seconds": 0.4},
         {"type": "fill", "question": "q6", "text": "One host with persistent storage."},
         {"type": "wait", "seconds": 0.5},
         {"type": "focus", "ids": ["q5"]}, {"type": "wait", "seconds": 0.4},
         {"type": "click", "selector": '[data-question-id="q5"] [data-answer-option="b"] .option-label'},
         {"type": "wait", "seconds": 0.4},
         {"type": "click", "selector": '#round-bar button[aria-label="Pick the recommendations"]'},
         {"type": "focus", "ids": ["q8"]}, {"type": "wait", "seconds": 0.6},
         {"type": "send", "expected": {
             "q4": {"option": None, "text": "A shared family passcode; accounts are more than a family needs."},
             "q5": {"option": "b", "text": ""},
             "q6": {"option": None, "text": "One host with persistent storage."},
             "q8": {"option": "b", "text": ""}}}]},
    {"name": "Next round", "round": 3, "asking": ["q7"], "research": "done",
     "refs": True, "sketch": True, "pause": 0, "actions": [
         {"type": "focus", "ids": ["q7"]}, {"type": "wait", "seconds": 0.6},
         {"type": "click", "selector": '[data-question-id="q7"] [data-answer-option="a"] .option-label'},
         {"type": "wait", "seconds": 0.7},
         {"type": "send", "expected": {"q7": {"option": "a", "text": ""}}}]},
    {"name": "Settled decisions", "round": 3, "done": True, "research": "done",
     "refs": True, "sketch": True, "pause": 2.5,
     "actions": [{"type": "focus", "ids": ["q2", "report:s1", "q5"]}]},
    {"name": "Spec", "inherit": True, "pause": 4,
     "actions": [{"type": "click", "selector": "#spec-toggle"},
                 {"type": "focus", "ids": ["q1", "q4", "q7"]}]},
]

ROOT = Path(__file__).resolve().parents[1]
DECISIONS = {
    "q4": "Members sign in with a shared family passcode.",
    "q5": "Anyone in the family can edit a recipe, with history.",
    "q6": "The app runs on one host with persistent storage.",
    "q8": "The home screen is a grid of recipe photos.",
    "q7": "A public link shares a recipe outside the family.",
}


def read_assignment(path):
    return json.loads(path.read_text().split("=", 1)[1].strip().removesuffix(";"))


def write_assignment(path, variable, data):
    pending = path.with_suffix(".tmp")
    pending.write_text(variable + " = " + json.dumps(data, indent=2) + ";\n")
    pending.replace(path)


def session_for(final, stage, previous, applied, answered):
    if stage.get("inherit"):
        return copy.deepcopy(previous)
    data = copy.deepcopy(final)
    data["status"] = "done" if stage.get("done") else "active"
    data["answered"] = answered
    data["questions"] = [q for q in data["questions"] if q["round"] <= stage["round"]]
    for q in data["questions"]:
        q.pop("reopened", None)
        if q["id"] in stage.get("asking", []):
            q.update(status="asking", answer=None, decision="")
        if q["id"] in applied:
            q.update(status="settled", answer=applied[q["id"]],
                     decision=DECISIONS.get(q["id"], q["decision"]))
    data["architecture"] = data["architecture"] if stage["round"] >= 2 else []
    data["refs"] = data["refs"] if stage.get("refs") else []
    data["sketches"] = data["sketches"] if stage.get("sketch") else []
    if "q8" in applied:
        for sketch in data["sketches"]:
            sketch["rev"] += 1
            sketch["note"] = "Applied Q8's grid layout, family sign-in and editing decisions."
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


def action(page, item, recording, session, answered):
    if item["type"] == "click":
        page.locator(item["selector"]).click()
    elif item["type"] == "scroll":
        page.mouse.wheel(item.get("x", 0), item.get("y", 300))
    elif item["type"] == "wait":
        recording.pause(item["seconds"])
    elif item["type"] == "focus":
        # Use the board's camera, leaving its content and layout untouched.
        page.evaluate("ids => focusView(true, ids)", item["ids"])
    elif item["type"] == "fill":
        page.locator(f'[data-answer-question="{item["question"]}"]').fill(item["text"])
    elif item["type"] == "send":
        command = [sys.executable, str(ROOT / "skills/visual-grilling/server.py"),
                   str(session), "--wait-answers"]
        if answered:
            command.extend(["--after", answered])
        waiter = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
        try:
            page.get_by_role("button", name="Send answers", exact=True).click()
            page.locator(".question-card.pending").first.wait_for()
            batch = read_assignment(session / "user.js")["answers"][-1]
            actual = {answer["question"]: {"option": answer["option"], "text": answer["text"]}
                      for answer in batch["items"]}
            assert actual == item["expected"], (actual, item["expected"])
            recording.pause(1.2)  # show Sent before the next stage plays the agent
            output, _ = waiter.communicate(timeout=3)
            assert waiter.returncode == 0 and json.loads(output)["answers"] == [batch]
            if "q8" in actual:
                # Play the agent's sketch update in the copy, using the clicked variant.
                current = read_assignment(session / "session.js")
                question = next(q for q in current["questions"] if q["id"] == "q8")
                option = next(o for o in question["options"] if o["id"] == actual["q8"]["option"])
                sketch = (session / option["sketch"]).read_text()
                sketch = sketch.replace('class="open"', 'class="box"')
                sketch = sketch.replace("Sign-in is not decided yet", "Sign in with the family passcode")
                sketch = sketch.replace("Who can edit a recipe?", "Family members can edit; changes keep a history.")
                (session / current["sketches"][0]["src"]).write_text(sketch)
            print(f'Applied board batch {batch["id"]}: {", ".join(actual)}', flush=True)
            return batch
        finally:
            if waiter.poll() is None:
                waiter.terminate()
                waiter.wait(timeout=5)
    else:
        raise ValueError("Unknown page action: " + item["type"])


def main():
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise SystemExit("Cannot record demo: ffmpeg was not found on PATH.")
    (ROOT / "docs").mkdir(exist_ok=True)
    server = None
    with tempfile.TemporaryDirectory(prefix="visual-grilling-demo-") as temporary:
        work = Path(temporary)
        session = work / "session"
        shutil.copytree(ROOT / "examples/demo", session)
        shutil.copyfile(ROOT / "skills/visual-grilling/viewer.html", session / "index.html")
        final = read_assignment(session / "session.js")
        applied, answered = {}, ""
        initial = session_for(final, STAGES[0], None, applied, answered)
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
                        data = session_for(final, stage, previous, applied, answered)
                        write_assignment(session / "session.js", "window.__GRILL__", data)
                        signature = {
                            "questions": [[q["id"], q["status"]] for q in data["questions"]],
                            "sketches": len(data["sketches"]),
                            "research": [n["status"] for n in data["research"]],
                            "answered": data["answered"],
                        }
                        page.wait_for_function("""expected => currentSession &&
                            JSON.stringify(currentSession.questions.map(q => [q.id, q.status])) === JSON.stringify(expected.questions) &&
                            currentSession.sketches.length === expected.sketches &&
                            JSON.stringify(currentSession.research.map(n => n.status)) === JSON.stringify(expected.research) &&
                            currentSession.answered === expected.answered
                        """, arg=signature)
                        for item in stage.get("actions", []):
                            batch = action(page, item, recording, session, answered)
                            if batch:
                                for answer in batch["items"]:
                                    applied[answer["question"]] = {"option": answer["option"], "text": answer["text"]}
                                answered = batch["id"]
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
                    assert 25 <= duration <= 40, duration
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
            subprocess.run([ffmpeg, "-v", "error", "-y", "-framerate", "10", "-i",
                            str(work / "frames/frame-%05d.png"), "-c:v", "ffv1", video], check=True)
            filters = "fps=10,scale=960:-1:flags=lanczos"
            subprocess.run([ffmpeg, "-v", "error", "-y", "-i", video, "-vf",
                            filters + ",palettegen=stats_mode=diff", str(work / "palette.png")], check=True)
            subprocess.run([ffmpeg, "-v", "error", "-y", "-i", video, "-i", str(work / "palette.png"),
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
