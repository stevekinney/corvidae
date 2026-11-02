# Findings and verdicts

## Where a finding goes

Decide the target by asking, in order, which is the lowest layer whose change fixes every instance:

| The problem is… | Target | Name in the finding |
| --- | --- | --- |
| a color, spacing step, radius, type size, shadow, motion or contrast value that is wrong wherever it appears | Cinder token | the token and its file under `components/cinder/src/tokens/` or `components/cinder/src/styles/tokens*.css` |
| a component's default look, density, state (hover, focus, disabled, loading, empty, error), or behavior | Cinder component | the component directory under `components/cinder/src/components/` |
| a missing variant, prop or slot that pages work around | Cinder component | the component, and the variant it needs |
| a pattern pages hand-build that no component provides (the same markup on two or more pages, or one page faking a component) | new Cinder component | the proposed component name and the pages it would replace |
| shell, outlet padding, page width or density shared by every page | Cinder (shell styles, `components/cinder/src/styles/shell.css`) or Interborough's view table (`applications/interborough/src/app/views.ts`), whichever owns the value | the file |
| what a page shows, its order, its grouping, its primary action, or which component it picked | Interborough page | the route file under `applications/interborough/src/routes/` |
| words: labels, titles, empty-state copy, error messages | Interborough copy | `applications/interborough/src/app/copy.ts` or the route file |
| the data a page has to show is missing or wrong | Interborough data | the route and the request it makes |

Before routing to Interborough, grep `components/cinder/src` for the pattern. If Cinder has a component that would do and the page does not use it, the finding is "use the Cinder component" on the page; if Cinder's component is why the page looks wrong, the finding is on the component.

## A finding

Each finding has these fields, in this order:

- **Where**: the route, state, tab, width and scheme, and the screenshot path from the manifest. List every place a shared root cause shows up.
- **Severity**: `critical` (blocks the task, loses data, hides an error, or fails accessibility), `major` (slows the task, misleads, or breaks consistency in a way a person notices), or `minor` (polish).
- **Problem**: what a person experiences, in one or two sentences. Not "padding is 24px" but "the run's status sits below the fold at 375 pixels, so a person opening a failed run sees its input first".
- **Principle**: the rubric item it violates, by name.
- **Target**: one row of the table above, with the file or component.
- **Change**: the specific, actionable change. For a token, the new value or relationship; for a component, the new default or variant; for a page, the new order or component. A finding without a concrete change is a question, and goes under Questions.
- **Design reference**: when a reference image covers the screen, whether the screen matches it, and the exact difference if it does not.

Do not report: taste without a principle, a change a recorded owner decision rules out, or a defect visible only in the pathological seed data (unless the page breaks on it: overflow, clipping without an ellipsis, a layout that collapses).

## The sweep report

One Markdown report per area:

- One paragraph: what the area is for and what works well. Lead with what is genuinely strong.
- Findings grouped by target (Cinder tokens, Cinder components, new Cinder components, Interborough pages, copy, data), each group ordered by severity.
- Questions: places where the right answer turns on a product decision, with a recommendation.
- Coverage: the screens reviewed, and anything you were asked to review but could not judge (missing state, pathological data only, no design reference).

## Row verdicts

Implementation review and drift audit judge agreed design rows one at a time. Both read a rows file and write a verdicts file, each pipe-separated with one row per line and no header; a literal `|` inside text becomes `/`.

```text
rows file:      row-id | board | requirement text
verdicts file:  row-id | verdict | evidence
```

- **row-id**: the canvas index id, such as `11a`. The verdicts name every input row exactly once, in input order.
- **board**: the board's file stem under `boards/`, the same stem for both of its files: `<board>.dc.html`, the board's source as the Artifact tool's read returns it (exact copy, structure, and component names), and `<board>.png`, a render of it, with `<board>--part<n>.png` slices when the board is taller than 1,400 pixels. A chef brief saves the `.dc.html`; the review renders the `.png` when it is missing ([design references](design-references.md)). A row on `Main` (the canvas index, which `design-ledger.ts` uses when no board was mapped) has only its requirement text as the standard: judge it from the text, and mark it `unverified` when the text alone cannot settle how it should look.
- **verdict**: one of the following.
  - `matches`: the screens and the code do what the row says, in every state and width the row covers.
  - `drifted`: it is built, but differently from the row (another component, order, copy, or treatment).
  - `partial`: some of the row is built, and some is not, or it is built in some states or widths only.
  - `missing`: nothing in the screens or the code does it.
  - `superseded` (drift audit only): a later decision replaced the row. The evidence cites that decision (a row id or a COR issue).
  - `deferred` (implementation review only): the issue records, with a reason, that this change does not carry the row. The evidence names where.
  - `unverified`: no capture shows the row (the state was not captured, or the flow cannot run on the host), so it cannot be judged. It is never a pass, and the evidence says what would make it checkable.
- **evidence**: semicolon-separated, at most 300 characters, never a `|`: the screenshot path or paths relative to the capture directory, then the source `file:line` where it helps, then, for anything but `matches`, the difference in a short sentence. A `matches` line may leave it empty.

The implementation review's overall verdict follows from its rows: `changes required` when any row is `drifted`, `partial`, `missing` or `unverified`; otherwise `approve`, or `approve with notes` when the report has notes. `bun scripts/design-review-rows.ts` checks the file and prints that verdict. A departure from an agreed row is a defect, not taste, and it blocks.

## The design critique

A critique judges each board on its own, so sign-off can be tracked per board. It has one section per board, in the order given, each headed by a line reading exactly `BOARD: <board>` (the board's file stem), whose next line is exactly one of:

- `VERDICT: ready to build`
- `VERDICT: ready with changes`
- `VERDICT: rethink`

A critique of a single board has one section. After the board sections comes one shared section, headed `SHARED`, holding the Cinder inventory and the questions, because a component or token a design implies usually serves several boards.

Each board section holds:

- What the design gets right, and what it improves over the current screens.
- Findings against the design, in the finding format above, with **Where** naming the board or screen image. Judge every state the design shows and name every state it omits (loading, empty, error, forbidden, offline, streaming, a long value): an omitted state is a finding, because it will otherwise be invented during implementation. Phone width and dark mode are the exception when the canvas has a shared rules board ([design references](design-references.md) "Shared rules boards"): a page board inherits them, and an omission is a finding only when the board needs behavior those rules cannot give it, such as a table that must become cards or a chart whose colors carry meaning.
- Consistency: where the design departs from patterns the rest of the application uses, and whether the departure should spread to the rest or be dropped.

The shared section holds:

- The Cinder inventory: the existing components the design uses (by directory), the variants, defaults and tokens it changes, and the new components it implies, each with the pages that would use it. Flag anything that would become a bespoke Interborough component.
- Questions for the owner, each with a recommendation.

`rethink` means the design does not serve its task (the information architecture or the primary flow is wrong), not that it needs polish.

## The implementation-review verdict

When the dispatch gave rows, return the row lines first, under a line reading exactly `ROWS`, then the verdict and the report. The first line of the report is exactly one of:

- `VERDICT: approve`
- `VERDICT: approve with notes`
- `VERDICT: changes required`

Then, for `changes required`, the blocking items, each a finding as above. A blocking item is a concrete user-facing defect the change introduced or left in the screens it touched: a regression against the before captures, a state that is broken or missing, an accessibility failure, a departure from the agreed design (name the board and the difference) or from a recorded owner decision, or a fix applied in Interborough that belongs in Cinder. Taste, pre-existing problems in untouched screens, and improvements beyond the change's scope never block; list them as notes, marking pre-existing ones as such.

On a re-review, check each previous blocking item first (fixed or not, with the screenshot), then review only what changed since. Never re-raise a note the author answered.
