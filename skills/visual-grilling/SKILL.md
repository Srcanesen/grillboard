---
name: visual-grilling
description: Grill the user about a plan, decision, or idea while a live board in their browser draws the design tree, the references and the spec as it settles. Use when the user asks for a visual grill, or wants to see the decisions while being grilled.
---

Interview the user relentlessly until you reach a shared understanding, and keep a live **board** in their browser where they watch the idea take shape: each settled decision becomes a piece of the tree, each open question a gap still to fill, and the spec grows beside it.

Hold the whole session in the language the user opened it in: the chat, every text you put on the board, and `lang`.

## The interview

Map the topic as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question, offer two to four concrete options where the decision has them, and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so. Question numbers run on across rounds, so `Q4` in the chat is `q4` on the board; in the chat, write the letter in the session's language, as the board does (`S4` in Turkish). List the options as lettered lines (`a)`, `b)`, `c)`), the same letters as the option ids on the board, and have the recommendation name its option and give the reason in a few words:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including the options>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round.

Finding _facts_ is your job. When a frontier question needs a fact from the environment (filesystem, tools, the web), dispatch a sub-agent to find it (see Research) and keep going: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Act on the result only after the user confirms you have reached a shared understanding.

## The board

The board is `viewer.html` (beside this file) reading a **session file**. It re-reads the session file about once a second, so every save shows up without a reload. `server.py` (also beside this file) serves the board and lets the user paste and drop references onto it.

**Start**, once, before round 1:

1. Create `.grill/<slug>/` in the working directory, where `<slug>` is a short kebab-case name for the topic.
2. Copy `viewer.html` there as `index.html`.
3. Write `.grill/<slug>/session.js` with the idea alone: the board opens on the idea, and the nodes arrive as the interview goes.
4. Run `python3 <this skill's folder>/server.py .grill/<slug>`. It prints the board URL and keeps serving in the background. Open that URL where the user can watch it beside the chat (a browser or preview pane tool when you have one, otherwise the OS opener: `open`, `xdg-open`, `start`) and give the user the URL. Without Python 3, open `index.html` from disk: the board still updates live, and adding references is off.

**Every round**: save the session file first, then send the round in the chat, so the board and the chat always show the same state. When a reply arrives:

1. Read `.grill/<slug>/user.js` for references the user added (see References).
2. Mark each answered question `settled`, with its `answer` and a one-sentence `decision`.
3. Add the new frontier as `asking`, and any question you can already see coming as `waiting`, so the user sees the open branches ahead.
4. Rewrite `architecture` to match the decisions so far.
5. Update the sketch (see Sketch).

Edit the changed questions in place; leave the rest of the file as it is.

**Finish**: when the user confirms the shared understanding, wait for the running research to land (see Research), then set `"status": "done"` and write `.grill/<slug>/spec.md` with the title, the idea, the decisions, the architecture, and each research finding under the decision it serves.

## Sketch

The **sketch** is a rough picture of the thing itself, redrawn as decisions settle, so the user sees the idea take shape instead of imagining it from text. The board hangs each sketch off the idea as a node.

- **Choose the picture that shows the idea**: the screens of a site or app, the panel of a plugin, a palette and type sample for a visual language, a box-and-arrow diagram for something with no screen. Several sketches are fine (one per page, say).
- **Keep it a sketch**: plain boxes and real labels in the session's language, drawn as one self-contained HTML file with inline CSS and no scripts, under `.grill/<slug>/sketch/`. It is done when the user could point at any part and name the decision behind it.
- **Draw it fluid**: the user can drag a sketch wider, narrower or taller on the board, and the page inside reflows like a browser window. Lay it out with flexible widths (percentages, flex, grid, `max-width`) and give `body` no fixed width or height, so the sketch still reads at other sizes.
- **Show the gaps**: where a part is still undecided, leave a dashed placeholder labelled with the question it waits on (`Q6`), so an open question on the tree and a hole in the sketch are the same thing seen twice.
- **Bring it in when the interview turns visual**: the first sketch enters the board in the round that first asks how the thing looks or is laid out, drawn from the decisions settled so far. After each later round, edit the parts the new decisions touched, raise that sketch's `rev`, and say in `note` what changed.

List sketches in `sketches` in the session file.

## References

A **reference** is a picture or a link pinned to a question, to one option, or to the board as a whole.

**Yours.** When a decision is easier to make by looking (a layout, a style, a mood), give each option a picture. Put the file under `.grill/<slug>/refs/` (a screenshot, a sketch you write as SVG, a generated image) and list it in `refs` in the session file. `target` is a question id (`q2`), an option (`q2:a`), `idea` for the idea itself, or empty for a reference left unattached.

**The user's.** They paste or drop pictures and links onto the board, and the board records them in `user.js`, in the same shape as your `refs` plus a `note` in the user's words. `user.js` is the board's file: you only read it. Look at each new picture (open the file under `refs/`), let it shape the next round, and say in the chat what you took from it.

## Research

A **research note** marks something that has to be looked up, pinned to the decision it serves. List them in `research` in the session file. The spec is only as good as the context under it, so a note is how a gap becomes visible instead of being guessed over.

Research runs **live**: a sub-agent starts on a note the moment it appears, the board shows its steps while it works, and its report lands on the board as a node the user can open.

Add a note when:

- **A decision waits on a fact.** The question is `researching`; the rest of the frontier goes on.
- **A settled decision leaves open _how_ it is done**: an unfamiliar tool, an API, a file format.
- **The user names a product, tool or term you cannot place.**
- **The user asks for one** ("research Q4").

**Run it.** In the turn you add a note, start a background sub-agent on it and set the note `running`. Keep at most three running; further notes wait as `todo` and start as one finishes. The sub-agent sees none of this conversation, so its brief carries:

- the topic, the decision it serves, what is already settled around it, and the session's language;
- the budget: a quick study of about ten searches and pages that ends in a report of at most sixty lines. It answers what the decision needs; a deeper study is a follow-up the user asks for;
- the steps file, `.grill/<slug>/research/<id>.log`: before each search and each page it reads, it appends one line under 80 characters saying what it is doing, so the user watches it work;
- the report, `.grill/<slug>/research/<id>.md`: the answer in the first lines, then what to use and how, the limits worth knowing, what it could not confirm, and the sources it actually opened as links;
- its reply to you: the finding in two to four sentences, and the sources.

**Land it.** When a sub-agent reports, save the session file at once, also while a round is waiting for the user's answers: the note becomes `done` with its `finding`, `sources` and `report`. Then let the finding work on the interview:

- a `researching` question it unblocks joins the next round as `asking`;
- a settled decision it contradicts is reopened (see Reopening);
- the chat gets one line saying what was found.

Where sub-agents cannot run in the background, do the research yourself between rounds and write the same two files.

## Session file

`session.js` assigns one object. The board shows a warning when the file stops parsing, so keep it valid JavaScript.

```js
window.__GRILL__ = {
  "version": 1,
  "lang": "en",
  "title": "Recipe box",
  "idea": "A small app where a family keeps and shares its recipes.",
  "status": "active",
  "architecture": [
    "One SQLite file holds recipes and members."
  ],
  "sketches": [
    { "id": "k1", "title": "Home", "src": "sketch/home.html", "rev": 2, "width": 390, "height": 760, "note": "Added the recipe list from Q1." }
  ],
  "refs": [
    { "id": "r1", "src": "refs/home-list.svg", "target": "q2:a", "caption": "" }
  ],
  "research": [
    {
      "id": "s1",
      "target": "q1",
      "topic": "How does SQLite run behind a small web app?",
      "status": "done",
      "finding": "SQLite is a library: the app opens the file directly. Turn on WAL mode so reads do not wait for writes.",
      "sources": [{ "title": "SQLite: appropriate uses", "url": "https://sqlite.org/whentouse.html" }],
      "report": "research/s1.md"
    }
  ],
  "questions": [
    {
      "id": "q1",
      "round": 1,
      "title": "Where do recipes live?",
      "body": "",
      "dependsOn": [],
      "status": "settled",
      "options": [
        { "id": "a", "label": "Plain files" },
        { "id": "b", "label": "SQLite" }
      ],
      "recommended": "b",
      "recommendation": "",
      "answer": { "option": "b", "text": "" },
      "decision": "Recipes are stored in one SQLite file."
    },
    {
      "id": "q2",
      "round": 2,
      "title": "How does the home screen look?",
      "body": "",
      "dependsOn": ["q1"],
      "status": "asking",
      "options": [
        { "id": "a", "label": "A plain list" },
        { "id": "b", "label": "A grid of photos" }
      ],
      "recommended": "a",
      "recommendation": "",
      "answer": null,
      "decision": ""
    }
  ]
};
```

- `lang`: the session's language code. The board ships `en` and `tr`; for another language add a `labels` object (the keys are in the `LABELS` block at the top of `viewer.html`).
- `sketches`: `width` and `height` are the size the sketch opens at (390 × 760 for a phone screen, 1280 × 800 for a desktop one); the board scales it to fit, and the user can resize it from there.
- `refs`: your references. `src` is a path under the session folder or a full URL; `caption` is optional.
- `research`: the research notes. `target` is a question id, or empty for the whole board; `status` is `todo`, `running` or `done`; `finding`, `sources` and `report` (the path of the report file) stay empty until it is `done`.
- `body`: the context of the question in a sentence or two. The board draws `options` itself, so keep them out of `body`.
- `dependsOn`: the ids of the questions whose answers opened this one, the main one first: the board hangs the card under that one and shows the rest as a note. Empty for a question that hangs straight off the idea.
- `status`:
  - `asking`: in the current round.
  - `settled`: answered.
  - `researching`: a sub-agent is finding the fact this question needs.
  - `waiting`: visible already, but a question in `dependsOn` is still open. Give it the round you expect to ask it in; its options can come when it reaches the frontier.
- `options` and `recommended`: the choices you offered and the id of the one you recommend. For an open question leave `options` empty and put your recommendation in `recommendation`.
- `answer`: `option` is the id the user picked (the recommended id when they accept your recommendation), or `null` when they answered in their own words; `text` carries those words or any note they added.
- `decision`: one short sentence that stands on its own as a line of the spec, without the question beside it. It becomes the headline of the settled card, so the tree reads as the idea itself.
- `architecture`: three to six short lines that describe the shape of the thing as decided so far; empty until the first decisions land.
- **Reopening**: when an answer overturns an earlier decision, set that question back to `asking`, add `"reopened": true`, and clear its `answer` and `decision`. Questions that hung off it go back to `waiting`.
