# Design references

A design is the subject of a design critique and the standard of an implementation review; a sweep uses one when it exists. The reviewer cannot open URLs, so the coordinator turns the design into local images and text before every dispatch.

## A Claude Design canvas artifact

The Interborough UI revision canvas is `https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw`. Its Main board is an index of changes (id, area, text, status: Prototyped, Decided, or Options), and the old states are on its Before page. Owners may name another canvas.

- `Artifact` with `action: "read"` returns the canvas's HTML, not a render. Use it to extract the index rows and their status, which tell the reviewer which designs are decided and which are options still open.
- To give the reviewer pictures, open the canvas in Chrome (load the `claude-in-chrome` skill), screenshot each board for the areas under review, and save them under `<capture directory>/design-references/<area>-<board>.png`.
- Save each board's source with `Artifact` `action: "read"` and `path: "project/<Board>.dc.html"` as `boards/<board>.dc.html`, and its render as `boards/<board>.png`: open the canvas on that board in the built-in browser or Chrome and screenshot it. A board whose render cannot be taken is still reviewed from its HTML, and the reviewer marks a row `unverified` when its visual treatment is the question.
- For an implementation review or a drift audit, write the index rows as a rows file (`row-id | board | requirement text`, [findings](findings.md) "Row verdicts") and name each board image after the board stem the rows use. Keep the index's status beside each row in the requirement text (`[Decided]`, `[Superseded by 11c]`), so the reviewer sees which rows are a contract.
- Pass the reviewer the images and the index rows for its area. Only rows marked Decided are a standard to match; Prototyped and Options rows are input to weigh, not a contract.

## A claude.ai/design project

The Cinder design-system project lives at claude.ai/design, project `3e8bc53b-41d7-4dc8-99c0-6181feb05c38`. The `DesignSync` tool reads it, but it needs design-system authorization that a non-interactive session cannot grant: ask the owner up front to run `/design-login` in an interactive `claude` terminal, and keep working meanwhile. Do not promise a comparison until a `list_files` call succeeds.

## None

Without a reference, the reviewer judges against the rubric alone and says so in its coverage section.
