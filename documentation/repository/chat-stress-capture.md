# Chat stress capture

The Cinder Chat board (COR-2289) is proved against the real `@lostgradient/chat` component, never a copy of it. Three committed pieces carry the proof.

## The fixture

`scripts/browser-fixtures/src/fixtures/chat-stress.svelte` is registered in `src/app-fixture-declarations.ts` as `chat-stress`. It is served by case: `/page/chat-stress?case=NN`, where `NN` is 1 to 80. The Chromium component sweep leaves it out, because `capture-chat-stress.ts` owns its images.

- `chat-stress.json` holds the 80 cases: the scenario each builds, its parameters, the design rows it shows, the real interactions the capture performs, and its variants.
- `chat-stress/stress-scenarios.ts` turns a scenario into the conversation and plain props for one real `Chat`. A scenario seeds only what a person finds on arrival. Typing, Send now instead, choosing an option and answering are steps the capture presses through the page's controls, so no seeded receipt or preselected answer stands in for an interaction.
- A host operation a person cannot perform (a dropped connection, a token arriving, a source taken away) is a `hook` step that calls `window.corvidaeChatStress`.
- `chat-stress.rows.txt` is the rows file of the design-review skill, one `row-id | board | text` line per row. Every row is shown by at least one case, and a case that cannot show its row says so in its `deferred` field.
- The original 80 definitions were lost. A case an issue names is marked `issue-named` with the sentence that names it; every other case is `derived` from the row it shows.

## The capture

```bash
bun run capture:chat-stress -- [--out <dir>] [--cases 9,10,14-15] [--profiles 320-dark]
```

The script holds one host slot while it runs ([host admission](host-admission.md)); running `scripts/browser-fixtures/scripts/capture-chat-stress.ts` directly takes none. Set `CHAT_STRESS_SUPPLEMENTAL=1` to add the 390 dark phone profile. The tool builds the host into the run's own directory, writes `source-identity.json`, serves that build on a port the system chooses, and only then draws the cases at 1440 light, 768 dark, 390 light and 320 dark (touch and a coarse pointer below 500 px). Each run gets a fresh `real-chat-captures-` directory, so no run overwrites another. One deadline, the awake-time hang guard, bounds every wait, and the tool never sleeps.

Images are named `<width>-<theme>-<case>.png` for a primary and `<width>-<theme>-<case>-<variant>.png` for a variant: `33-expanded`, `59-collapsed`, `68-option2`, `68-something-else`, `69-question-2-of-3`, `71-live`, `71-folded`, `72-scrolled`, and `73-focus-<index>` for each stop of case 73's tab sweep. A complete run holds 320 primaries and 32 fixed variants plus the focus stops. `manifest.jsonl`, the files on disk and `gallery.html` must agree, and `summary.json` names every failure by case, profile and measurement. A failed gallery says Failed at its top and never reads as a pass.

`scripts/chat-stress-plan.ts` holds the pure parts (profiles, names, counts, measurement rules, the gallery) and is covered by `chat-stress-plan.test.ts` and `chat-stress-cases.test.ts` in the default lane.
