# ChoiceGrid

Responsive grid of large selectable choices with roving keyboard focus, selection state, and optional correct/incorrect/pending feedback for quiz and assessment surfaces.

## Usage

```svelte
<script lang="ts">
  import { ChoiceGrid } from '@lostgradient/cinder';

  let selected = $state<string | null>(null);
</script>

<ChoiceGrid ariaLabel="Choose a difficulty" bind:value={selected}>
  <ChoiceGrid.Item value="easy">Easy</ChoiceGrid.Item>
  <ChoiceGrid.Item value="medium">Medium</ChoiceGrid.Item>
  <ChoiceGrid.Item value="hard">Hard</ChoiceGrid.Item>
</ChoiceGrid>
```

## Guidance

### Use When

- Presenting a small fixed set of large selectable answers where all options should stay visible (quiz or assessment surfaces).
- Building a touch-friendly selector grid with stable cell dimensions that must not shift when feedback states are applied.

### Avoid When

- Selecting from a long dynamic list — use combobox or select instead.
- Choosing one of two to five short values in a compact inline context — use segmented-control instead.

## Card variant

`variant="card"` on `<ChoiceGrid>` draws each item as a left-aligned card instead of a centered quiz tile: a radio indicator (a checkbox indicator when `multiple`), an optional icon before the title, and an optional one-sentence description under it. Use it when each choice needs a sentence of explanation, such as the type of source being connected. The item's children are the title; `description` is a string and `icon` is a snippet. The selected card takes the accent border and tint, and the indicator carries the selection too, so it never rests on color alone. The grid still owns selection, roving focus and the radiogroup or group roles, and `description` is linked to the item with `aria-describedby`.

```svelte
<ChoiceGrid variant="card" columns={2} ariaLabel="What are you connecting?" bind:value={source}>
  <ChoiceGrid.Item
    value="mcp"
    description="A server that offers tools, such as GitHub or a database."
  >
    {#snippet icon()}<ServerIcon />{/snippet}
    MCP server
  </ChoiceGrid.Item>
  <ChoiceGrid.Item value="openapi" description="A web API described by an OpenAPI 3 file.">
    {#snippet icon()}<GlobeIcon />{/snippet}
    OpenAPI spec
  </ChoiceGrid.Item>
</ChoiceGrid>
```

`size` applies to tiles only; the card variant sizes itself from its content.

## Compact size

`size="sm"` on `<ChoiceGrid>` propagates to every `<ChoiceGrid.Item>` through context — there is no separate `size` prop on the item itself, so a grid's cells always size consistently. Omitting `size` (the default) keeps the current appearance exactly.

```svelte
<ChoiceGrid ariaLabel="Choose a root note" size="sm">
  <ChoiceGrid.Item value="c">C</ChoiceGrid.Item>
  <ChoiceGrid.Item value="c-sharp">C#</ChoiceGrid.Item>
  <!-- … -->
</ChoiceGrid>
```

**Sizing contract:**

- **Fine pointer (the default outside `(pointer: coarse)`):** cells match Cinder's `button` `sm` scale — `block-size: var(--cinder-button-height-sm)` (28px), plus the `sm` padding and font-size tokens. All three shrink together: a fixed 28px cell isn't achievable by changing height alone, since the item's 2px border plus its normal (non-compact) padding already exceeds 28px on its own.
- **Coarse pointer:** cells floor at a 44×44 CSS pixel minimum touch target instead of the 28px fine-pointer height. This floor applies to every `size="sm"` cell regardless of `columns` — whether fixed (`1 | 2 | 3 | 4`) or `"responsive"` — because a minimum touch target is an accessibility requirement, not a layout-mode-conditional feature.
- **States never change dimensions:** selected, hover, focus, disabled, and the correct/incorrect/pending feedback states are color-only changes at every size, exactly as they are at the default size.
- `columns="responsive"` defaults `minColumnWidth` to `"6rem"` under `size="sm"` (`"10rem"` otherwise) — chosen so a 320px content-box-width container (`<ChoiceGrid>`'s own inline size, not an outer viewport before page padding or grid gaps are subtracted) fits a dense set of choices, such as 12 note names or 6 open strings, without horizontal overflow. Pass `minColumnWidth` explicitly and it always wins over either default.
- `size` is compact-only for now — only `"sm"` is defined. The type is its own alias (`ChoiceGridSize`) rather than an inline literal, so widening it to include `"md"` / `"lg"` later is additive for existing `"sm"` consumers, not a breaking change.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaLabel` | `string` | no | — | Accessible label for the grid (required unless `ariaLabelledby` is set). |
| `ariaLabelledby` | `string` | no | — | Id of an external element that labels this grid. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-choice-grid`. |
| `columns` | `"responsive"` \| `1` \| `2` \| `3` \| `4` | no | — | Column layout. - `'responsive'` — `auto-fill` at a minimum cell width (default). - `1 \| 2 \| 3 \| 4` — fixed number of columns. |
| `disabled` | `boolean` | no | — | Disables all items in the grid. |
| `minColumnWidth` | `string` | no | — | Minimum cell width for `columns="responsive"`. Accepts any CSS `<length>` (e.g. `"12rem"`, `"200px"`). Default: `"10rem"`, or `"6rem"` when `size="sm"` — passing `minColumnWidth` explicitly always wins over either default. |
| `multiple` | `boolean` | no | — | When true the grid allows multiple simultaneous selections and reads/writes `values` instead of `value`. The ARIA role switches to `group` (items become `checkbox`); single-select uses `radiogroup` (items become `radio`). |
| `size` | `"sm"` | no | — | Compact-only size variant. Omitting it (the default) keeps the current appearance. `"sm"` shrinks each item's block-size to Cinder's `button` `sm` height under a fine pointer, and to a 44×44 CSS pixel minimum touch target under a coarse pointer; it does not change selection, hover, focus, or feedback-state styling. See the ChoiceGrid README's "Compact size" section for the full sizing contract. |
| `value` | `string` \| `null` | no | — | The currently selected value (single-select mode). Bindable. Pass `null` or omit to start with no selection. |
| `values` | `string`[] | no | — | Currently selected values (multi-select mode). Bindable. Only used when `multiple` is `true` — set `multiple` explicitly to switch modes; binding `values` alone does NOT enable multi-select. |
| `variant` | `"tile"` \| `"card"` | no | `"tile"` | How items are drawn. `'tile'` (the default) keeps the centered quiz tile; `'card'` draws a left-aligned card with a radio (or checkbox when `multiple`) indicator, so each choice can carry an icon and a one-sentence description. Selection, roving focus and ARIA roles are identical in both. `size` applies to tiles only. |
| `children` | `(opaque)` | yes | — | `ChoiceGridItem` children. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
