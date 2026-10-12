# No build step and no dependencies

The board is one self-contained `viewer.html` and the server is one `server.py` that uses only the Python standard library. The agent copies the board into every session folder, and the skill has to work on a machine where nothing can be installed, also when the board is opened straight from disk. So the board is not split into files that need bundling, and neither file takes a third-party package.

## Consequences

- Structure inside `viewer.html` comes from `<script id="...">` blocks: logic that needs no page lives in its own block, defines one global, and is tested by loading that block in Node (`tests/board`).
- A refactor that needs a bundler, a package manager or a second shipped file reopens this decision; it is not a cleanup.
