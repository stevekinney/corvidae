# The review rubric

The lenses the `design-reviewer` applies to every screen. Each is distilled from its source, so a finding can name the principle it violates. Apply them in this order, because a page with the wrong information architecture cannot be fixed with spacing.

## The task and the information

- What is this page for, and who arrives here wanting what? Name the primary task in one sentence before judging anything. If you cannot, that is the first finding.
- Does the first viewport answer the arriving question? On an index, that is "what needs me, and what is the state of things?"; on a detail page, "what is this, is it healthy, and what can I do?"; on a form, "what am I making, and what is required?".
- Is the order of the page the order of the task? Primary content and its primary action first; metadata, history and configuration after.
- Is every element earning its space? Remove a label that repeats a heading, a card that frames one value, a section that is empty most of the time.

## Edward Tufte: data and evidence

From _The Visual Display of Quantitative Information_, _Envisioning Information_, _Visual Explanations_ and _Beautiful Evidence_.

- **Data-ink ratio**: most of the ink should present information. Borders, fills, dividers, shadows and icon chrome that carry nothing are candidates to erase. Prefer whitespace and alignment to boxes.
- **Chartjunk**: decoration that does not inform (gradient fills, 3-D, heavy gridlines, ornamental icons beside every label) is a defect.
- **Smallest effective difference**: make distinctions as quiet as they can be while still legible. A status should not be louder than the thing it describes.
- **Layering and separation**: one heavy visual layer at a time. When everything is emphasized, nothing is; watch for 1 + 1 = 3 effects where two adjacent borders create a third shape.
- **Small multiples and adjacency**: things a person compares (runs, agents, revisions) sit side by side in the same frame and scale, not on separate pages or in tabs.
- **Data density and micro/macro readings**: a list should reward both a glance (the overall pattern) and a close read (one row's detail). Low-density tables with large padding and one value per row waste the screen; sparklines and inline indicators belong in rows.
- **Integrate words, numbers and images**: put the explanation next to the value it explains. Units, time zones and denominators are shown with the number, not in a legend elsewhere.
- **Show causality and time**: for runs, schedules and agents, the question is usually "what happened, in what order, and why?". A timeline or sequence beats a status badge.

## Apple's Human Interface Guidelines

From the current HIG (foundations: hierarchy, harmony, consistency; layout; typography; color; accessibility; and its patterns).

- **Hierarchy**: one clear entry point per screen. Type size, weight and color establish order; use few sizes and weights, consistently.
- **Harmony and consistency**: the same thing looks and behaves the same everywhere. A list on Agents and a list on Workflows share structure; a destructive action is styled and placed the same on every page.
- **Deference**: chrome recedes and content leads. The shell, toolbars and navigation should be quieter than the page's content.
- **Layout**: align to a grid; group related controls; use a consistent spacing scale; keep line length readable (roughly 45–90 characters for prose); respect safe areas and keep the phone layout a real layout, not a squeezed desktop.
- **Color**: semantic and sparing; never the only carrier of meaning; dark mode is designed, not inverted, and both schemes keep their contrast.
- **Feedback**: every action acknowledges itself; progress is visible for anything over a moment; errors say what happened and what to do next, near where it happened.
- **Progressive disclosure**: show the common case, put the advanced case one step away, and never hide something the person needs to decide.
- **Empty states teach**: say what will appear here, why it is empty, and the one action that fills it.
- **Destructive actions**: confirm what cannot be undone, name the thing being destroyed, and prefer undo to confirmation where the operation allows it.
- **Accessibility**: WCAG 2.2 AA contrast (4.5:1 text, 3:1 large text and indicators), visible focus that wraps the whole control, targets at least 24 by 24 CSS pixels (44 on touch layouts), reduced motion honored, and labels that make sense read alone.
- **Writing**: sentence case for labels and titles (Cinder enforces it), verbs on buttons, the person's words rather than system names. "Engine" and "Bureau" are internal names Interborough never shows.

## Craft: the measured rules

A capture measures every page and holds it to the numbers below. The audit reads them from `GEOMETRY_THRESHOLDS` in `applications/interborough/scripts/design-review-geometry.ts` (change a number there and in its line below), and `geometry-report.md` in the capture directory lists what broke them, one line per defect with the captures that show it. These are the defects the owner corrects most often, so they are checked before taste.

Read the geometry report before the screenshots. Confirm each line on a screenshot it names, then report it as a finding whose **Principle** is the rule's name. A confirmed line seen on three or more routes is at least `major`, and it is almost always a Cinder default or token, not a page. Drop a line that is intent rather than error (an indented quotation, the one primary action of a dialog spanning a phone) and say so under Coverage. A threshold cannot see intent, so a line is never a finding until it is confirmed, and a clean report never excuses a screen that looks wrong.

- **Alignment** (`edge-near-miss`): content starts on shared left edges. Two edges between 1 and 4 pixels apart are a mistake, not a decision. Name the padding or inset that differs and the token both should use.
- **Spacing scale** (`gap-off-scale`): every gap between siblings is a step of Cinder's spacing scale. A gap of 18 pixels means someone typed a number or stacked two margins.
- **Rhythm** (`gap-uneven`): siblings of one kind sit at one distance from each other. Related things sit closer than unrelated things, so a label is nearer its own field than the field above.
- **Leading edge** (`leading-space`): a row's content starts at its leading edge. A row whose content starts more than a quarter of the way across, with nothing before it, leaves the side a person reads first empty; on a phone that is most of the screen. Start the content at the leading edge and let the trailing side take the slack.
- **Button proportions** (`button-padding-ratio`): a label has at least 1.5 times the room beside it as above it, and two times is the target. A tall button with a label squeezed between its sides is the defect.
- **Phone controls** (`target-oversized`, `button-stretched`): a single-line control is drawn no taller than 48 pixels on a phone, and a short label does not span the screen unless it is the one primary action of a form or dialog. A touch target grows through its hit area, never its drawn size.
- **Words or an icon** (`button-wordy`): a phone button's label is 16 characters or fewer. A longer one, and any label that crowds a toolbar or a row, is a candidate for an icon with an accessible name and a tooltip. Keep the word when the action is destructive, unfamiliar, or the primary action of the page.
- **Target size** (`target-undersized`): a control is at least 24 by 24 pixels, or extends its hit area that far (WCAG 2.5.8); 44 on a touch layout, through the hit area.
- **Type scale** (`type-sizes`, `text-tiny`): a page sets text in at most 6 sizes, none below 11 pixels. A seventh size is a missing token or a one-off.
- **Line height** (`line-height`, `line-height-mixed`): wrapped text up to 20 pixels has a line height between 1.3 and 1.7 times its size, and one size uses at most two line heights on a page.
- **Border weight** (`border-heavy`, `border-thick`, `border-mixed`): a border between a surface and its content reads at no more than 1.5:1 against the surface outside it, a control's border at no more than 4.5:1, every border is 1 pixel, and a page draws its structural borders in at most three weights.

Three rules the capture cannot measure, which the reviewer judges on every screen:

- **Hierarchy at a squint**: blur the screenshot in your mind. Three levels should survive: the one thing the page is about, what supports it, and what can be ignored. If everything survives or nothing does, that is the finding. In Chat, the levels are who spoke, what the agent did, and what needs the person: a tool call must not read as loudly as the answer it produced, and a request for approval must read louder than both.
- **One pattern per job**: before accepting a list, a header, a toolbar, an empty state, a key and value pair, or a status, find the Cinder component for that job (`components/cinder/documentation/interface-guide.md`) and check that the screen uses it. The same job done two ways on two screens is a finding even when each looks fine alone, and hand-built markup that fakes a component is one too.
- **Text and its neighbors**: a heading sits closer to what it introduces than to what came before it, and help text is closer to its field than to the next field. Judge it where the gap rules above pass but the grouping still reads wrong.

## Agentic applications

Current patterns and research on interfaces where software acts on a person's behalf: human-in-the-loop design, trust calibration, and the interaction patterns established by agent products from 2024 onward.

- **Legible autonomy**: the person can see what the agent is doing now, what it did, and what it will do next. A run or chat shows its plan or steps, not just a spinner.
- **Interruptibility and steering**: long work can be stopped, paused, or redirected from where it is shown, and the controls stay reachable while output streams.
- **Approval gates**: a request for approval states the action, its target, its risk and its reversibility, shows the exact change (a diff, a command, the arguments), and offers approve, deny and edit. It is findable from anywhere (a notification, a reviews inbox) and from the run it blocks.
- **Provenance**: agent-authored content is distinguishable from the person's, tool calls and their results can be expanded, and claims cite their source. Every durable change records who or what made it.
- **Streaming and partial states**: output appears as it is produced, partial results are marked as partial, and a reload or reconnect resumes where it was rather than losing the work.
- **Long-running and background work**: work that outlives the page has a home (Runs, Health), a notification when it needs the person, and a clear terminal state: succeeded, failed with a reason and a retry, or cancelled.
- **Trust calibration**: show uncertainty and limits honestly; never present an agent's guess with the same weight as a recorded fact; show cost, duration and model when they affect a decision.
- **Recovery**: failures name the step, the cause in the person's terms, and the next action (retry, edit input, open the log). A failed tool call inside a successful run is visible, not swallowed.
- **Structured questions**: when the agent asks, the answer has the right shape (a choice, a date, a form), not a free-text box for everything.
- **Configuration that reads as intent**: agents, schedules and hooks are described in plain sentences ("Every weekday at 9:00 in Chicago, run…") as well as fields.

## Interborough and Cinder context

- **Read before judging**: `components/cinder/documentation/interface-guide.md` (Cinder's patterns), `components/cinder/documentation/tokens.md`, `components/cinder/documentation/focus-ring-policy.md`, and the README of any component a screen uses (`components/cinder/src/components/<name>/README.md`). `applications/interborough/scripts/check-interface-rules.ts` lists the copy and style rules the redesign already enforces.
- **Recorded owner decisions**: borders are too heavy and too inconsistent today, so structural borders stay quiet hairlines and a finding never asks for a heavier one (whether a control's border drops below 3:1 outside `prefers-contrast: more` is an open owner question, so raise it as one); phone controls are drawn compact and reach touch size through their hit area, never by growing; an icon with an accessible name and a tooltip replaces a label that crowds its row; focus rings should be quieter and wrap the whole composite control; required fields get a small red dot, not an asterisk; loading, error and offline states are critical, not polish; Interborough v1 is single-user, so no user or API key management surfaces. Do not contradict a recorded decision; if you think one is wrong, say so separately as a question.
- **Cinder first**: route every finding with the decision table in [findings](findings.md). Interborough never gets a bespoke component.
