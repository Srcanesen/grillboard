# The agent and the board talk through files

The agent writes `session.js`; the server writes `user.js` for the person; each side only reads the other's file. The board polls both about once a second, and the agent is woken by a waiter command that exits when a new answer batch appears. We chose files over a socket or an agent-facing HTTP interface because every coding agent can write a file and run a command, while few can hold a connection open, and because the board then still shows a session when no server runs.

## Consequences

- The server never parses `session.js`, so it cannot check an answer against the questions; the agent does that when it applies a batch.
- The same rule can exist once per language (the board in JavaScript, the server in Python). Each side keeps its copy in one place, and the examples in `SKILL.md` and `examples/demo` are run through both by the tests.
