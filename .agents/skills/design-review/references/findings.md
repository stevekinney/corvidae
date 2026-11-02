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

## The sign-off verdict

The first line is exactly one of:

- `VERDICT: approve`
- `VERDICT: approve with notes`
- `VERDICT: changes required`

Then, for `changes required`, the blocking items, each a finding as above. A blocking item is a concrete user-facing defect the change introduced or left in the screens it touched: a regression against the before captures, a state that is broken or missing, an accessibility failure, a contradiction of the design reference or a recorded owner decision, or a fix applied in Interborough that belongs in Cinder. Taste, pre-existing problems in untouched screens, and improvements beyond the change's scope never block; list them as notes, marking pre-existing ones as such.

On a re-review, check each previous blocking item first (fixed or not, with the screenshot), then review only what changed since. Never re-raise a note the author answered.
