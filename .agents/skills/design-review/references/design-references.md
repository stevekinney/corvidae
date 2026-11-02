# Design references

A design is the subject of a design critique and the standard of an implementation review; a sweep uses one when it exists. The reviewer cannot open URLs, so the coordinator turns the design into local images and text before every dispatch.

## A Claude Design canvas artifact

The Interborough UI revision canvas is `https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw`. Its Main board is an index of changes (id, area, text, status: Prototyped, Decided, or Options), and the old states are on its Before page. Owners may name another canvas.

- `Artifact` with `action: "read"` returns the canvas's HTML, not a render. Use it to extract the index rows and their status, which tell the reviewer which designs are decided and which are options still open.
- To give the reviewer pictures, open the canvas in Chrome (load the `claude-in-chrome` skill), screenshot each board for the areas under review, and save them under `<capture directory>/design-references/<area>-<board>.png`.
- Save each board's source with `Artifact` `action: "read"` and `path: "project/<Board>.dc.html"` as `boards/<board>.dc.html`, and its render as `boards/<board>.png`. Render locally, with no browser session or sign-in: save the canvas runtime once per canvas (`Artifact` read of the canvas with `path: "artifact-type/dc-runtime.js"`) as `boards/support.js`; a canvas never ships it with its boards, and a runtime from another canvas may not match, which each board's `<script src="./support.js">` loads, then run `bun scripts/design-review-render-boards.ts --boards <boards directory>` from `applications/interborough`. It renders every `.dc.html` at its own `$preview` width beside its source, slices any board taller than 1,400 pixels into `<board>--part<n>.png` (a tall board scaled into one image is unreadable, so send the reviewer the slices), and exits 1 naming any board that logged an error or never mounted. Screenshotting the canvas in a browser is the fallback. A board whose render cannot be taken is still reviewed from its HTML, and the reviewer marks a row `unverified` when its visual treatment is the question.
- For an implementation review or a drift audit, write the index rows as a rows file (`row-id | board | requirement text`, [findings](findings.md) "Row verdicts") and name each board image after the board stem the rows use. Keep the index's status beside each row in the requirement text (`[Decided]`, `[Superseded by 11c]`), so the reviewer sees which rows are a contract.
- Pass the reviewer the images and the index rows for its area. Only rows marked Decided are a standard to match; Prototyped and Options rows are input to weigh, not a contract.

## Shared rules boards

Canvas boards are usually drawn at one desktop width in light mode. Rather than draw every page again at phone width and in dark mode, a canvas carries one shared rules board (named, for example, `ResponsiveAndDark`) that states how every page behaves below 640 pixels and in dark mode: navigation behind the menu button, tables scrolling in their wrapper or becoming cards, side rails stacking under the content, and how surfaces, borders and status colors map in dark mode. Page boards inherit it.

Give the reviewer the shared rules board with every critique, implementation review and drift audit. A page board that needs something the rules cannot give it draws that state itself. Without a shared rules board, every omitted phone or dark state is a finding.

## A claude.ai/design project

The Cinder design-system project lives at claude.ai/design, project `3e8bc53b-41d7-4dc8-99c0-6181feb05c38`. The `DesignSync` tool reads it, but it needs design-system authorization that a non-interactive session cannot grant: ask the owner up front to run `/design-login` in an interactive `claude` terminal, and keep working meanwhile. Do not promise a comparison until a `list_files` call succeeds.

## None

Without a reference, the reviewer judges against the rubric alone and says so in its coverage section.
