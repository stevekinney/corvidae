# Takeover run log

Coordinator: Claude session in `/Users/stevekinney/Developer/corvidae` (took over 2026-11-12 from the paused Codex run). This file is the current execution record; `../ideal-state-progress.md` and `../fresh-session-handoff.md` are history.

## Takeover checkpoint, 2026-11-12

- Candidate worktree `/Users/stevekinney/.agent-worktrees/codex/cinder-chat-visual-rebase`, branch `steve/cinder-chat-visual-polish`, HEAD `9615456e2bfee8c9235735f4ea187044fbfa6348`, merge-base `d949d83cd8063d17ecafeefcc8c70f480952a4e0`.
- `origin/main` is now `b93fd1c254cc706c9cbdb3550d782b7e2f1713c5` (#1137). `git merge-tree` is clean; no file overlaps the branch. #1137 retired `validate:batch` and local `bun run validate` as a delivery gate: the gate is `bun scripts/chef/focused-checks.ts`, then pull-request CI. The handoff's validate and validate:batch steps are obsolete.
- Dirty guard edits saved as a patch in the coordinator scratchpad (`dirty-guards-takeover.patch`).
- Coordinator viewed 12 phone frames of the pre-rebase TkbUoT gallery. Much is fixed, but these owner complaints are still visible and need a strict review on fresh captures: wide icon pitch in message action rows (B5), dead bands inside approval cards (A6), two different approval card layouts (cases 53 versus 21: marker and Add a note positions), small Deny/Refund pills, composer height differing between states, tall Sources sheet header.

## Decisions

- One implementation worker at a time, in the existing worktree, one browser process.
- Acceptance rows are given to reviewers phrased as desired outcomes, never as defect descriptions.

## Brief 01 result

- HEAD d88fd83cb84cb44be8bf5e888709ef69ea3e55ea (merge of origin/main b93fd1c25, conflict-free). Commit 9fe191628: guards rewritten (shared readPaintProblems with Range-based clip and two-axis overlap checks, real-CSS controls), plus branch fixes: stress-scenarios.ts exactOptionalPropertyTypes and unused arg, chat-stress.svelte unused ChatTurnLabels import, capture scroller undefined check, chat-stress-plan.test.ts counts 111->115 fixed variants / 485->489 total.
- Post-merge exit codes: three test files 0, typecheck:root 0, lint:root 0, revert-check 0, git status clean.
- Focused capture exit 0: tmp/chat-stress/takeover-focused/real-chat-captures-Tf7cYG/{summary.json,gallery.html}; passed true, complete false (10-case subset by design), errors [], 76 images.
- Full capture FAILED: tmp/chat-stress/takeover-full80/real-chat-captures-CNuxNJ/{summary.json,gallery.html}; passed false, complete true, cases 80, 578 images, 11 errors, deferred empty:
  - case 42 at 1440-light: code highlighting still pending for 1 block(s)
  - case 45 at 1440-light and 768-dark: waitForFunction timeout 120000ms
  - case 61 at 1440-light revealed and 768-dark revealed: attachments toHaveCount expected 3, received 14
  - case 61 at 390-light, 320-dark, 390-dark (and each "revealed"): waiting for button "11 more" timed out
- None of the failures are in the guarded cases (19, 48, 59, 78). Not retried, not investigated.

## Brief 02 result (partial, stopped near the context limit)

- Case 61 FIXED (harness/fixture, not product): 7247541537 predates the attachment shelf; the shelf cap became viewport-dependent (1 at <=480x700, 2 at <=480x860, else 3) in a checkpoint commit, but chat-stress.json still hard-coded the name "11 more" (valid only for cap 3, and the label is "N more below") and, in the "revealed" variant, clicked it before expect-attachment-shelf, which then asserted the collapsed count 3 against an expanded 14. Removed the two hard-coded steps; expect-attachment-shelf (reveal) already asserts the cap, the button and the expansion. `--cases 61` passes at all profiles: tmp/chat-stress/takeover-61b/real-chat-captures-J8saXl (10 images).
- Case 45 NOT FIXED, product regression with contradicting tests. At 1440 and 768 (non-coarse inline chips) focus ends on a remaining source chip (`button.cinder-citation__marker`), never the message action `.chat-message-action-button[data-citation-focus]`. Cause: commit 9615456e2 bound `chipGroup` in message-sources.svelte, which activates its withdrawal effect (moveFocusAfterWithdrawal focuses a remaining chip after tick) and overrides chat-message.svelte's returnSourceFocus(preferAction). In components/chat chat-sources.test.ts two tests disagree: "withdrawing an open inline source ... focuses a message action" (line ~437, withdraw first of two, expects the copy button with data-citation-focus) currently FAILS; "C#11" (line ~638, main's contract, withdraw middle of four, expects remaining[1] chip) currently passes. Skipping the chip move when focus already left the group flips them (437 passes, C#11 fails), so the contract needs an owner decision: after a withdrawal, does focus go to the next chip (main's C#11) or a message action (case 45 title and the branch's test)? Edit tried and reverted. The capture failure message now names the focused element.
- Case 42: not reproduced; `--cases 42 --profiles 1440-light` passes alone (tmp/chat-stress/takeover-42/real-chat-captures-okuLBA). The full-run error is the post-wait measurement reading a pending highlight; cause undetermined, likely load-sensitive ordering between the wait and the measurement. Not fixed.
- Not run: the 42,45,61 combined capture and the second full capture (45 blocks them).

## Brief 03 result

Partial; stopped at the 150K context limit. HEAD dbac5959c0a9ab577826ecfffed73c01ae0dfbe0 (one commit on 600cab8e4).

Done: Button hit area (coarse layout box is the painted 24/28/32/40px; 44px from `::before`; new private `--_cinder-painted-height-*` in foundation.css); button padding tokens (x-sm space-3, x-md space-4, source: tokens/sets/components.tokens.json, regenerated); approval card toggles (`__input-toggle`, `__said-toggle`, `__note-toggle`) use a pseudo-element hit area; expired row button leads and time follows; "Reversible" fact dropped when irreversible; collapsed disclosure chevron mirrors in RTL; decision title uses `--cinder-leading-snug`. Tests: new button-hit-area.test.ts, header-actions.test.ts, approval-card-decision.test.ts and border-tier-non-border-uses.test.ts updated. Cinder tests for button, approval-card, _internal, styles pass (1866).

Not done: irreversible badge placement/12px, row-layout command as CodeBlock, note toggle moved to the action row, command wrap at whitespace, "Why" text-height gap; code block (light inset, Copy transparent/centred/padding, Writing label); choice rows; drawer header; spinner; citation; Callout notice API; other controls using touch-target-min (chip, tabs, citation, code-block, toast, banner, etc.). The required turbo/lint/typecheck/lint:root/prettier commands were NOT run.

Changed defaults the coordinator should capture in Interborough: every Button on coarse pointers (smaller layout, same face), sm/md button side padding, approval-card disclosure and note rows.

## Brief 03 part B result

Done: Callout is the notice (progress snippet, onDismiss/dismissLabel, inline action wraps only when it cannot fit); choice cards (muted rest border, centred label, grid-auto-rows 1fr); drawer sheet header (12px grabber, 28px close, 44px ::after); spinner (track border-control, arc >= quarter); citation (24px hit area, 2px ring, radius-sm); hit areas converted: sortable-list handle, breadcrumbs back, toast action, choice-grid-item sm. Not done: app-bar icon actions, error-state and restart-state summaries, number-input stepper, carousel dot, tabs collapse select (left: painted 44 full-width), full-width rows and docked/modal/tool-call-panel buttons (design paints 44 on purpose). Tests per touched dir: exit 0.

## Brief 03 part A result

HEAD 53e6db86b9c65c08018a5df4eaf648f1644ed174 (one commit). Tests: `cd components/cinder && bun ../../scripts/bun-test.ts --conditions browser --conditions svelte src/components/approval-card src/components/code-block` exit 0 (305 pass); prettier --check on both directories passes. Not run: turbo, lint, typecheck, lint:root, no visual capture.

Done: badge 13px (selector outranks Badge sm), beside the title and wrapping to the line under it (column/order rules removed); row command is CodeBlock; Add a note moved into the decision action row as a muted quiet control; decision-tools row hidden when empty (countdown only); action row margin gives space-3 under metadata (decision and row); negative-margin Why hack removed; command wraps with overflow-wrap break-word and each flag is an atomic inline-block (plain and highlighted; verified in Chromium: flags never split); Copy: transparent at rest, centred on first line (translate), coarse size overrides removed so Button pseudo-element hit area adds no layout; floating strip uses the code surface; Writing label inside padding. Light surface: the command panel outdents by its own padding (approval-card command, decision space-2, row space-1) so text sits on the label column; Shiki contrast forbids an inset fill.

Not verified visually: Copy centring, hit area clipped by the block edge on tight padding, README/schema regeneration diffs (generator output, included). Scroller reserve stays a margin (scrollport shrinks), not padding.

Changed defaults: approval card command panel (outdent), Add a note (muted, in action row), code block wrap, floating Copy.
