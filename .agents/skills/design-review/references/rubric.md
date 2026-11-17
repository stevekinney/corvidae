# The review rubric

The lenses the `design-reviewer` applies to every screen. Each is distilled from its source, so a finding can name the principle it violates. Apply them in this order, because a page with the wrong information architecture cannot be fixed with spacing.

## The owner's complaints

These are the owner's words (2026-11-11), and they are the lens for every review. A general rubric approved a chat gallery that the owner then marked up by hand in twenty places, so read each screen against this list first and name the complaint a finding answers.

- "The alignment and spacing across different components and spacing. I am constantly having to correct agents for having layouts that are all over the place in terms of alignment and spacing."
- "Typograph, line-heights, and spacing between text and elements on the page."
- "Giant buttons and touch targets on mobile."
- "Using big words that take up a lot of space when an icon with a screen-reader-only label or maybe a tooltip would suffice."
- "Components that push all of the important content to the right and then have a big empty space on the left—this is particularly egregious on mobile."
- "Borders that are inconsistent across components—I currently hate how heavy our borders are. Maybe for like high-contrast mode for interactive elements, but it's kind of jarring right now."
- "Buttons that have a lot of vertical padding, but then weirdly skinny horizontal padding."
- "Sometimes it's real hard to understand the visual hierarchy of things. This is particularly egregious in the chat interface."
- "There are a lot of patterns where it feels like we are re-inventing the wheel."

Three things that review got wrong, which bind every review since:

- **A minimum is not a goal**: that review counted "three 44 x 44 px controls with equal gaps" as an improvement, and the owner's complaint was that those controls were giant and gappy. Meeting a floor (a 44 pixel target, a 3:1 border) is never a reason to praise a screen. The drawn size of a control and the area that takes a tap are two numbers, and only the second has a floor.
- **Start at the smallest phone**: read the 320 by 640 captures first, then 375, then the wider ones. Fixed chrome crowding the content and overlays covering it show there first, and the light captures show some that the dark ones hide.
- **Pieces can pass while the whole fails**: every element can meet its own rule on a screen that is still wrong. After the element checks, judge the state as one thing: what it says, how many times, and in how many shapes.

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
- **Accessibility**: WCAG 2.2 AA contrast (4.5:1 text, 3:1 large text and indicators), visible focus that wraps the whole control, a hit area of at least 24 by 24 CSS pixels (44 by 44 on a touch screen, reached by extending the hit area and never by drawing the control that large), reduced motion honored, and labels that make sense read alone.
- **Writing**: sentence case for labels and titles (Cinder enforces it), verbs on buttons, the person's words rather than system names. "Engine" and "Bureau" are internal names Interborough never shows.

## Craft: the measured rules

A capture measures every page and holds it to the numbers below. The audit reads them from `GEOMETRY_THRESHOLDS` in `applications/interborough/scripts/design-review-geometry.ts` (change a number there and in its line below), and `geometry-report.md` in the capture directory lists what broke them, one line per defect with the captures that show it. These are the defects the owner corrects most often, so they are checked before taste.

Read the geometry report before the screenshots. Confirm each line on a screenshot it names, then report it as a finding whose **Principle** is the rule's name. A confirmed line seen on three or more routes is at least `major`, and it is almost always a Cinder default or token, not a page. Drop a line that is intent rather than error (an indented quotation, the one primary action of a dialog spanning a phone) and say so under Coverage. A threshold cannot see intent, so a line is never a finding until it is confirmed, and a clean report never excuses a screen that looks wrong.

- **Alignment** (`edge-near-miss`, `edge-many`): content starts on shared left edges. Two edges between 1 and 4 pixels apart are a mistake, not a decision. The children of one container start on at most two left edges, and its boxes end on at most two right edges; lists, quotations and code set their own, and a sent message pushed to the trailing side is a placement, not an edge. Name the padding or inset that differs and the token both should use. An alignment finding says which box it means: containers share an edge with the column they sit in, and text inside a bordered or filled container shares one inset from that container's edge. "One left edge for the transcript text and the composer text" got a composer's padding removed, so its text touched its border.
- **Spacing scale** (`gap-off-scale`): every gap between siblings is a step of Cinder's spacing scale. A gap of 18 pixels means someone typed a number or stacked two margins.
- **Rhythm** (`gap-uneven`): siblings of one kind sit at one distance from each other. Related things sit closer than unrelated things, so a label is nearer its own field than the field above.
- **Even insets** (`inset-uneven`): a box has the same room above its content as below it, within 4 pixels. More above is a title row sized by a button's hit area, or two paddings stacked.
- **Leading edge** (`leading-space`): a row's content starts at its leading edge. A row whose content starts more than a quarter of the way across, with nothing before it, leaves the side a person reads first empty; on a phone that is most of the screen. Start the content at the leading edge and let the trailing side take the slack.
- **Button proportions** (`button-padding-ratio`): a label has at least 1.5 times the room beside it as above it, and two times is the target. A tall button with a label squeezed between its sides is the defect.
- **Phone controls** (`target-oversized`, `button-stretched`): on a phone or a touch screen a button is drawn no taller than 36 pixels, and any other single-line control (a row, a tab) no taller than 48. A short label does not span the screen unless it is the one primary action of a form or dialog. A touch target grows through its hit area, never its drawn size: the report gives both numbers for every control it names.
- **Hit areas take no space** (`hit-takes-space`): on a touch screen a button's layout box is its painted face. A transparent border or a `min-block-size` of the touch minimum makes the tap area out of layout, and that one cause produced a 44 pixel icon pitch, a swollen alert title row, dead bands in an approval card and a tall sources row in one gallery. Size and padding are read from the painted face, inside any border that draws nothing, so a compact face in a padded box is still held to the padding ratio.
- **Icon rows** (`icon-pitch`): icon buttons in one row sit at most 2.5 times their glyph apart, center to center. A 14 pixel glyph every 48 pixels reads as a gappy row; let the hit areas meet or overlap invisibly and keep the glyphs a group.
- **Fixed chrome** (`chrome-share`): what stays fixed below the scrolling region (a composer, a docked bar, a drawer) takes at most 35% of a phone's height. Judge it at 320 by 640.
- **Nothing covered** (`occluded`): no control sits partly under a bar, a card or a scroll fade, and no control lies on a line of text. A control is fully in view or fully out. A floating control over scrolling content (a jump-to-latest button) is intent when it covers nothing a person needs at rest; a copy button on the code it copies is not. The capture cannot tell a bar covering the end of a scrolling region from ordinary scrolling, so inside one it reports only fades and controls lying on text: at 320 by 640, look yourself for a composer, drawer or docked card that slices the last message or hides a decision button at rest.
- **Words or an icon** (`button-wordy`): a phone button's label is 16 characters or fewer. A longer one, and any label that crowds a toolbar or a row, is a candidate for an icon with an accessible name and a tooltip. Keep the word when the action is destructive, unfamiliar, or the primary action of the page.
- **Target size** (`target-undersized`): the area that takes a tap is at least 24 by 24 pixels (WCAG 2.5.8), and at least 44 by 44 on a touch screen, text fields aside. A field is an input, a select, or a button that opens a list of values (`aria-haspopup="listbox"`, `role="combobox"`); a button that opens a menu or a dialog is a button and is held to a button’s sizes. The fix is an invisible extension of the hit area, as a compact header button has, never a larger drawn control.
- **Hit areas reached** (`hit-unreached`): on a touch screen a tap 22 pixels from a control's center reaches the control, on every side in view. A compact control's invisible hit area is easy to lose without anyone seeing: a card whose padding is smaller than the overhang clips it, a positioned next row or a list item with `content-visibility: auto` paints over it, a loading bar covers the face's last pixels. Give the parent room for the overhang or stop the cover taking the tap, and keep anything that holds a pending decision at `content-visibility: visible`. This is the opposite failure to `hit-takes-space`, and a fix for one often causes the other.
- **Type scale** (`type-sizes`, `text-tiny`): a page sets text in at most 6 sizes, none below 11 pixels. A seventh size is a missing token or a one-off.
- **Line height** (`line-height`, `line-height-mixed`): wrapped text up to 20 pixels has a line height between 1.3 and 1.7 times its size, and one size uses at most two line heights on a page.
- **Border weight** (`border-heavy`, `border-thick`, `border-mixed`): a border between a surface and its content reads at no more than 1.5:1 against the surface outside it, a control's resting border at under 3:1 (Cinder's `border.control`; the 3:1 `border.contrast` tier is for `prefers-contrast: more` and for indicators with no other boundary), every border is 1 pixel, and a page draws its structural borders in at most three weights, a dashed line counting as one of them. A dashed border means one thing on a page: if queued, expired, streaming and broken all wear one, that is a finding.

Phone captures (480 pixels and narrower) are taken with a touch pointer, so Cinder's `@media (pointer: coarse)` sizes apply, and each is repeated at 320 by 640. Values that come from the fixture (the sample clock, seeded names, a syntax highlighter that had not finished) are not defects; say so under Coverage instead of reporting them.

The rules the capture cannot measure, which the reviewer judges on every screen:

- **Hierarchy at a squint**: blur the screenshot in your mind. Three levels should survive: the one thing the page is about, what supports it, and what can be ignored. If everything survives or nothing does, that is the finding. In Chat, the levels are who spoke, what the agent did, and what needs the person: a tool call must not read as loudly as the answer it produced, and a request for approval must read louder than both.
- **One pattern per job**: before accepting a list, a header, a toolbar, an empty state, a key and value pair, or a status, find the Cinder component for that job (`components/cinder/documentation/interface-guide.md`) and check that the screen uses it. The same job done two ways on two screens is a finding even when each looks fine alone, and hand-built markup that fakes a component is one too. The geometry report's "Pattern inventory" lists each button job asked with more than one label (retry, try again, ask again) or drawn in more than two forms under one pointer; start the inventory there, then do by eye what it cannot see: notices, disclosures, questions, and where an action sits in its row. Take an inventory before judging any one screen: for each intent the screens under review express (ask a question, retry, give notice, disclose more, show a file, show a source), list every form it takes. More than one form for one intent is a finding that names them all. The chat gallery had seven forms of retry, five notice layouts and six disclosures, and each looked fine alone.
- **Text and its neighbors**: a heading sits closer to what it introduces than to what came before it, and help text is closer to its field than to the next field. A row of actions or metadata sits closer to the content it belongs to than that content sits to the next thing: 35 pixels under an answer to its own action row, against 12 inside the message, reads as belonging to nothing. Judge it where the gap rules above pass but the grouping still reads wrong.
- **Say it once**: count the places that state one fact. A waiting approval stated by a heading, a step row, a card and a drawer is four; name the one that owns it and remove the rest. Check each state word (waiting, failed, expired) for a second element in the same turn saying it, and for a status drawn in the danger tone when the state is only waiting. The same goes for two timestamps on one turn and a label row that repeats the title above it.
- **Shape says role**: ask of every element what it is and whether its shape says so. A citation drawn as a pill button reads as something to press, a failed image in a dashed box as a place to drop a file, answer options in plain outlined boxes as neither radios, checkboxes nor buttons. If you have to ask "is that a button or part of the chat?", that is the finding.
- **State louder than its actions**: what happened and what is at stake outranks the buttons beside it. An 11 pixel "Stopped by you" chip beside two large buttons, or "Can't be undone" as the smallest type on a card, has it backwards. Semantic color follows severity: an expired approval in a neutral dashed outline next to a dropped connection in a full alert is a finding.
- **One thing, one container**: a state with its explanation and its choices is one contained unit, not loose elements under the text. For a chat turn, an approval, or interrupted work, compare against how Claude Code and Codex show the same moment, which is the comparison the owner makes.
- **Space is a budget**: ask how many pixels a component spends per line of information. A sheet 260 pixels tall for a title and one link, a 97 pixel header before any content, and a row with 60 pixels of dead space while its name truncates are all "wasted space", the owner's most frequent phrase.

What a screenshot cannot show, which the reviewer checks in the changed source when the change touches it:

- **A condition does not depend on what it shows**: for anything shown "when X is off screen" or "when the list overflows", ask whether showing it changes whether X is on screen. A reminder that appeared when an approval's buttons scrolled away changed the transcript's height, so at the end of the scroll it flickered. The condition is judged against the layout as it would be without the thing, in both states.
- **A remount loses focus and input**: for a `{#key}` block or a changing row id around an interactive row, ask what focus and what unsaved input a remount destroys. Two regressions were an approval row re-created with its ticked "allow for the rest of this chat" gone, and a tool-call group re-created so focus had nowhere to return.
- **A role is a contract**: changing an element's tag or role breaks every consumer that queries by it. Answer choices went from `button` to `role="radio"` and Interborough's number keys stopped working with no error. A component whose parts a consumer must find exports the selector or a data attribute, and a role change names the consumers it checked.

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
- **Recorded owner decisions**: borders are too heavy and too inconsistent today, so structural borders stay quiet hairlines, a control's resting edge is the quiet `border.control` tier (32% of the ink, decided 2026-11-11 from a side-by-side, reversing COR-1814) that becomes the 3:1 `border.contrast` tier only under `prefers-contrast: more`, and a finding never asks for a heavier border at rest; phone controls are drawn compact and reach touch size through their hit area, never by growing (this supersedes design row 04h, which asked for every control to be drawn 44 pixels tall on a touch screen and which Cinder's `foundation.css` still implements); an icon with an accessible name and a tooltip replaces a label that crowds its row; focus rings should be quieter and wrap the whole composite control; required fields get a small red dot, not an asterisk; loading, error and offline states are critical, not polish; Interborough v1 is single-user, so no user or API key management surfaces. Do not contradict a recorded decision; if you think one is wrong, say so separately as a question.
- **Cinder first**: route every finding with the decision table in [findings](findings.md). Interborough never gets a bespoke component.
