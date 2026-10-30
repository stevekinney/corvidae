# ScheduleBuilder accessibility

## Pattern

The root element is `role="group"` labeled by the `label` prop (default `"Schedule"`), `aria-label`, or `aria-labelledby`. Inside it is an ordinary form: a native `Select` labeled "Repeats", a `TimeField` labeled "At" (not rendered for an interval or a custom cron), the fields the chosen Repeats needs, and a `Combobox` labeled "Time zone". Only the fields for the current choice are mounted, so no two visible fields share a label.

## Roles names states

- Repeats and the interval Unit are native `<select>` elements with `<label for>` associations.
- Every text/number/time field (`Input`, `NumberInput`, `TimeField`) carries its own `<label for>` association, so `getByLabelText`-style lookup and screen-reader field announcement both work out of the box.
- The Custom days chips are `Chip` `mode="toggle"` buttons (`aria-pressed`) inside a `role="group"` labeled `"Days of week"`. Each chip shows the short day name (`"Mon"`) but carries the full day name (`"Monday"`) as its `aria-label`. The last selected day cannot be cleared, so the choice always runs on at least one day.
- The time zone is a `Combobox` (`role="combobox"` with a listbox popup) grouped by region; typing filters it, and an underscore and a space match alike. See `combobox.a11y.md`.
- Custom cron shows one group per cron field. Each begins with a labeled native `Select` for Every, Specific value, Range, Step, or Advanced raw expression. Specific, Range, and Step reveal labeled `NumberInput` controls with native bounds. Structured validation is attached to those visible controls so each error is announced through the associated form field without a duplicate alert. A native disclosure with the standard rotating Lucide chevron provides the labeled raw `Input` escape hatch with its range hint and inline validation. Editing that raw input switches the corresponding pattern selector to Advanced so the structured and raw representations never disagree.
- The read-back is a `<dl>`/`<dt>`/`<dd>` pair (`"Runs"` term, the sentence as the definition) whose definition is `aria-live="polite"`, so a change to any field is announced.
- The next-runs preview, when `computeNextFires` is supplied, is a labeled `<ul>` (`aria-labelledby` pointing at a visible `"Next runs"` label) of `<li>` rows keyed by `ScheduleFire.id`. An empty result renders a `"No upcoming runs."` paragraph instead of an empty list.

## Keyboard

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Move focus between Repeats, the visible fields, the cron pattern selectors and raw disclosures, and Time zone. |
| `ArrowUp` / `ArrowDown` | In Time zone, move through the filtered zones; in a native select, change the choice. |
| `Enter` | In Time zone, commit the active zone. |
| `Space` / `Enter` | Activate a focused day chip; toggle a focused raw-expression disclosure. |
| Native text/number/time entry | Standard browser editing keys apply inside `Input`, `NumberInput`, and `TimeField`; raw cron edits select Advanced mode. |

## Mouse / pointer

Choosing a Repeats option shows that choice's fields. Clicking a day chip toggles it. Clicking a cron pattern selector changes the structured controls shown for that field, and clicking the Advanced raw expression summary opens or closes its disclosure. Clicking a time zone in the list commits it. All remaining interaction uses native form-control pointer behavior.

## Hard scope caps

- ScheduleBuilder computes no dates and ships no cron-parsing or scheduling library. The next-fires preview is entirely consumer-supplied via `computeNextFires`; when that prop is omitted, the preview section is not rendered at all (not rendered-but-empty) so the component never implies a capability it doesn't have.
- Cron-field validation is limited to `validateCronField`'s supported grammar (wildcard, step, range, comma list, plain number) — it does not validate cross-field semantics (e.g. day-of-month 31 in February).
- Overlap policy, jitter, and backfill are explicitly out of scope; nothing in this component's markup implies their presence.
- No autofocus on mount, and no focus management on a Repeats change beyond the browser's default (focus stays on the control that was activated).
