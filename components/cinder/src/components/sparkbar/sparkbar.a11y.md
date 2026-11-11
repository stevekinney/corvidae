# Sparkbar accessibility

## Pattern

Sparkbar communicates a bounded measurement in a compact labeled row.

Purpose: Inline meter for dense cost, token, budget, or quota breakdowns where a full chart would be too heavy.

## Use when

- Showing a bounded value next to a visible label and optional trailing value.
- Comparing several compact usage or spend rows in a summary surface.

## Avoid when

- Reporting task completion over time such as uploads/imports — use progress.
- Rendering axes, scales, or multiple series — use bar-chart.

## Keyboard and focus

Sparkbar is non-interactive and does not enter the tab order by default. Do not add keyboard handlers unless the surrounding composition introduces a real interactive control with visible focus and matching semantics.

## Names, roles, and state

Sparkbar renders `role="meter"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext`. The accessible name defaults to the visible label plus percentage; pass `ariaLabel` when the surrounding context needs a more specific name.

With `points`, Sparkbar renders a trend line instead. A trend has no bounded value, so it is `role="img"`, not a meter: its accessible name is `label` (or `ariaLabel`), which should be a full sentence naming the metric, the window and where it ended up, and everything drawn inside (the line, the dot, the axis labels) is `aria-hidden`. Keep the figure and the window in visible text next to the line, so the sentence repeats what sighted people read and adds the direction.

Do not rely on fill color alone to communicate meaning. Use the visible label, trailing value, and surrounding copy to identify what is being measured.

## Verification

- Render Sparkbar in the playground or a focused test fixture.
- Inspect the accessible name, `meter` role, and value state in browser accessibility tools.
- Check forced-colors mode when using variant colors.

Related components: `meter`, `progress`, `bar-chart`.

## Rendering review (2026-08-10)

The implementation review retained Sparkbar as the compact meter beside Meter and BarChart. Browser review in light mode confirmed palette-driven accent fill, readable inherited text, and clear positional magnitude. Success and warning variants keep their semantic tokens, while the visible label, trailing value, meter role, and value attributes ensure color is never the only channel.
