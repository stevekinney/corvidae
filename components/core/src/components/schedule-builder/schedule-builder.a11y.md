# ScheduleBuilder accessibility

## Pattern

The root element is `role="group"` labeled by the `label` prop (default `"Schedule"`), `aria-label`, or `aria-labelledby`. Inside it is an ordinary form: a native `Select` labeled "Repeats", a text `Input` labeled "At" that reads and writes a time such as `9:00 AM` (not rendered for an interval or a custom cron), the fields the chosen Repeats needs, and a `Combobox` picker labeled "Time zone" (not rendered for an interval, which counts from its start). Only the fields for the current choice are mounted, so no two visible fields share a label.

## Roles names states

- Repeats and the interval Unit are native `<select>` elements with `<label for>` associations.
- Every text/number/time field (`Input`, `NumberInput`) carries its own `<label for>` association, so `getByLabelText`-style lookup and screen-reader field announcement both work out of the box.
- The Custom days toggles are `Chip` `mode="toggle"` buttons (`aria-pressed`) joined into one `role="group"` labeled `"Days of week"`; a selected day is filled, never marked by colour alone, because `aria-pressed` carries it too. Each chip shows the short day name (`"Mon"`) but carries the full day name (`"Monday"`) as its `aria-label`. The last selected day cannot be cleared, so the choice always runs on at least one day.
- The time zone is a `Combobox` picker (`role="combobox"` button; the open panel has its own "Search time zones" field and a listbox). Typing filters every zone by name, city or IANA id, and an underscore and a space match alike. The footer ("Showing 5 of 418 zones. Type to narrow.") sits outside the listbox. See `combobox.a11y.md`.
- Custom cron shows five labelled `Input`s, each described by its range hint ("0–59"). A field that needs fixing carries `aria-invalid="true"` and is described by one shared error line, placed after the five fields and announced politely, that names the first field to fix. There is no alert and no banner.
- The Runs panel is a visible `"Runs"` label above the read-back sentence, which is `aria-live="polite"`, so a change to any field is announced. With an invalid cron the sentence is replaced by "No preview until the cron expression is valid.", also polite.
- The next-runs preview, when `computeNextFires` is supplied, is a labeled `<ul>` (`aria-labelledby` pointing at a visible `"Next runs"` label) of `<li>` rows keyed by `ScheduleFire.id`. An empty result renders a `"No upcoming runs."` paragraph instead of an empty list. An interval's label reads "Next runs, counting from when you create it".
- The optional overlap and catch-up policies are native `<select>` elements with visible labels, drawn only when their value is set.

## Keyboard

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Move focus between Repeats, the visible fields, the cron fields, Time zone and the policy selects. |
| `ArrowUp` / `ArrowDown` | In Time zone, move through the filtered zones; in a native select, change the choice. |
| `Enter` | In Time zone, commit the active zone. |
| `Space` / `Enter` | Activate a focused day toggle. |
| Native text/number/time entry | Standard browser editing keys apply inside `Input` and `NumberInput`. |

## Mouse / pointer

Choosing a Repeats option shows that choice's fields. Clicking a day toggle flips it. Clicking a time zone in the list commits it. All remaining interaction uses native form-control pointer behavior.

## Hard scope caps

- ScheduleBuilder computes no dates and ships no cron-parsing or scheduling library. The next-fires preview is entirely consumer-supplied via `computeNextFires`; when that prop is omitted, the preview section is not rendered at all (not rendered-but-empty) so the component never implies a capability it doesn't have.
- Cron-field validation is limited to `validateCronField`'s supported grammar (wildcard, step, range, comma list, plain number) — it does not validate cross-field semantics (e.g. day-of-month 31 in February).
- The overlap and catch-up selects only draw and report their values; the builder keeps no policy state, and nothing in its markup implies jitter or backfill windows.
- No autofocus on mount, and no focus management on a Repeats change beyond the browser's default (focus stays on the control that was activated).
