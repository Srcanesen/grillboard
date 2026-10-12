# GrillBoard

An agent interviews a person about an idea, and a live board shows the idea taking shape. These are the words the skill, the board and the server share.

## Language

### The interview

**Session**:
One interview about one idea, from the first question to the spec.
_Avoid_: project, run, conversation

**Idea**:
The thing being designed, in the person's own words. The root of the design tree.
_Avoid_: topic, prompt

**Design tree**:
The decisions of a session, each hanging under the decision that opened it.
_Avoid_: graph, mind map

**Question**:
One decision put to the person. It is asking, settled, researching or waiting.
_Avoid_: node, card (a card is how the board draws a question)

**Round**:
The questions asked together in one turn.
_Avoid_: step, batch (a batch is a set of answers)

**Frontier**:
Every question whose prerequisites are settled, so it can be asked now.

**Option**:
One of the concrete choices offered with a question.
_Avoid_: choice, alternative

**Recommendation**:
The answer the agent would pick, given with the question.

**Decision**:
The settled answer of a question, written as one sentence that stands on its own.
_Avoid_: result, outcome

**Spec**:
The decisions, the architecture and the research findings of a session, read as one document.
_Avoid_: summary, PRD

### What the board shows

**Board**:
The page where the person watches the session and answers it.
_Avoid_: canvas, viewer, dashboard

**Sketch**:
A rough picture of the thing itself, redrawn as decisions settle.
_Avoid_: mockup, wireframe, preview

**Variant sketch**:
A sketch of one option of a question, shown so the person chooses by looking.
_Avoid_: option preview

**Reference**:
A picture or a link pinned to a question, an option or the idea, by the agent or by the person.
_Avoid_: attachment, asset

**Research note**:
Something that has to be looked up, pinned to the decision it serves, with its finding once found.
_Avoid_: task, todo

**Target**:
What a reference or a research note is pinned to: a question, one option of a question, or the idea.

### Answering

**Answer**:
The person's reply to one question: an option, their own words, or both.

**Draft**:
An answer chosen on the board and not yet sent.

**Answer batch**:
The answers the person sent from the board in one press.
_Avoid_: submission, round (a round is the questions)

**Pending answer**:
An answer that was sent and that the agent has not applied yet.
_Avoid_: sent answer, unprocessed answer

**Waiter**:
The command that waits for the next answer batch and wakes the agent with it.
_Avoid_: listener, watcher, poller

### Looking at the board

**View**:
The part of the board on screen: a position and a zoom.
_Avoid_: camera position, viewport (the viewport is the browser window)

**Fit**:
Moving the view so the whole design tree is on screen.

**Focus**:
Moving the view to some questions, by default the frontier.

**Far view**:
The zoomed-out look in which a question shows only its title.
