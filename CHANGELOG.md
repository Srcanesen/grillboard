# Changelog

What changed for people who use GrillBoard, newest first.

## Unreleased

- Added an interactive browser demo that replays a recorded session from the first round through the spec.
- Drag with the middle mouse button anywhere on the board to pan the view.

## 0.3.0 - 2026-11-18

The sketch stays with you while you answer, and the drawing and the decisions now point at each other.

### Added

- **The working sketch sits beside the questions being asked.** It used to stay above the idea and drift out of view as the tree grew. It now moves next to the current round and keeps clear of other cards. A position you drag it to still wins until the next round.
- **Minimize the sketch.** A button on the sketch folds it into a small chip with its title; click the chip to open it again. The board remembers your choice per session. On a phone the sketch starts minimized and opens at a readable width.
- **A revised sketch tells you so without opening.** When the agent redraws a minimized sketch, the chip pulses and carries a "New" label until you open it.
- **Click a part of the sketch to reach its decision.** A region the agent marks with `data-q="<question id>"` takes you to that question's card and rings it.
- **"Show in sketch" on a question card.** Cards whose question appears in the working sketch get this button; it opens the sketch and outlines the matching regions. Hovering the card outlines them while the sketch is open.

### Changed

- With several sketches, the working sketch is the most recently revised one.
- `SKILL.md` asks the agent to mark sketch regions with `data-q`. Sketches drawn without it work as before, without the links.

### Fixed

- Clicking or tabbing to a card that was partly off screen no longer leaves the board scrolled and cards cut off.
- On narrow screens the reference error message sits above the answers bar.
- A stalled answer response no longer locks rounds that were already acknowledged, and a malformed answer no longer locks its question.
- A reference dropped on the idea attaches to it. Retrying a reference add returns the original instead of a duplicate.
- Saved card positions are kept per session.
- A widened report no longer overlaps its neighbours, and Fit shows very deep trees.
- Sessions in a custom language set the page language, update animations respect reduced motion, and the server writes its output as UTF-8 in any locale.

Tried with Claude Code on macOS. Windows has not been tried yet.

## 0.2.0 - 2026-11-17

- Added a ready-to-install zip for people without Node.js or git.
- Answers no longer land in the wrong session, and a retried send returns the original batch instead of a duplicate.
- The board stays writable when a server ping hangs or times out, and recovers when the original server returns.
- Reference notes keep their draft while the board updates; a failed reference transfer stays visible with its reason and a Retry where retrying can help.
- Reference links without a file extension are recognized as images.
- Sketches keep keyboard focus and typing, and reload only when their content changes.
- Very deep design trees lay out without crashing.
- Smaller fixes to focus handling in dialogs, the spec panel and low-zoom readability.

## 0.1.0 - 2026-10-13

First public release.
