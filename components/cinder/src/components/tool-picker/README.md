# ToolPicker

<!-- generated:a11y-record:required -->

`ToolPicker` is a dialog for choosing tools and skills from a list grouped by source. Each row carries the human name, the identifier once in monospace, a one-line description and two trailing facts: a short word such as how risky the tool is (`meta`) and the level it starts at (`detail`). The level is read-only here; changing it happens wherever the chosen tools are listed once they are added. A skill follows the tools it uses, so it is listed with no checkbox (`selectable: false`) and says so in the trailing column.

The title's line carries a counter ("3 of 9 tools chosen"), a search field sits under it, and the list scrolls inside the dialog under sticky group headers ("Built in · 6", "GitHub · 3 · none chosen", "Skills · 2 · they follow the tools they use"). The picker edits a copy: Done writes the choices back to `selected` and calls `onDone`; Cancel, Escape and a click outside leave `selected` alone.

## Usage

```svelte
<script lang="ts">
  import { Button, ToolPicker } from '@lostgradient/cinder';
  import type { ToolPickerGroup, ToolPickerItem } from '@lostgradient/cinder';

  let open = $state(false);
  let selected = $state<string[]>(['lookup-order']);

  const groups: ToolPickerGroup[] = [
    { name: 'Built in' },
    { name: 'Skills', note: 'they follow the tools they use' },
  ];

  const items: ToolPickerItem[] = [
    {
      value: 'lookup-order',
      label: 'Lookup order',
      code: 'lookup-order',
      description: 'Looks an order up by its ID',
      group: 'Built in',
      meta: 'Reads',
      detail: 'Never (default)',
    },
    {
      value: 'issue-refund',
      label: 'Issue refund',
      code: 'issue-refund',
      description: 'Refunds an order to the original card',
      group: 'Built in',
      meta: 'Dangerous',
      detail: 'Always (default)',
    },
    {
      value: 'release-notes',
      label: 'Release notes',
      code: 'release-notes',
      suffix: 'Skill',
      description: 'Drafts release notes from merged pull requests',
      group: 'Skills',
      detail: 'Follows its tools',
      selectable: false,
    },
  ];
</script>

<Button onclick={() => (open = true)}>Add tools and skills</Button>
<ToolPicker bind:open bind:selected {items} {groups} />
```

## States

- **Loading**: `loading` keeps the title and a live search field and draws three skeleton rows after 300 ms, so a quick load never flashes a placeholder. Done waits until the list is there.
- **Filtered to nothing**: the search keeps what was typed, and the list says `No tools match “invoice”` with "Try a shorter word." and one action, Clear search. `noMatchTitle` takes a string or a function of the query.
- **Forty or more tools**: from `collapseFrom` selectable items (40 by default) the counter reads the total ("42 tools"; "42 tools · 3 chosen" once something is chosen), the group headers become buttons ("Built in 6 tools") and every group but the first starts collapsed. Searching opens every group that has a match.

## Choices and order

`selected` holds item `value`s. Done writes them in the order of `items`, followed by any value that no item names, so a choice the catalogue no longer offers is not silently dropped. A newly checked item's starting level is the consumer's to decide: give a dangerous tool a `detail` of "Always (default)" and the form that lists the chosen tools starts it there.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `cancelLabel` | `string` | no | `"Cancel"` | Label of the button that closes the picker and drops the choices made in it. |
| `class` | `string` | no | — | Additional CSS classes applied to the dialog. |
| `clearSearchLabel` | `string` | no | `"Clear search"` | Label of the button in the empty state that clears the search. |
| `collapseFrom` | `number` | no | `40` | How many selectable items it takes to switch to the long-list layout: the counter reads the total ("42 tools"), and every group but the first starts collapsed under its sticky header. |
| `doneLabel` | `string` | no | `"Done"` | Label of the button that closes the picker and keeps the choices. |
| `emptyLabel` | `string` | no | `"No tools to choose from."` | The line shown when there is nothing at all to choose from (no search involved). |
| `emptyMetaLabel` | `string` | no | `"No risk word"` | Names the trailing column of an item with no `meta`, which draws an em dash. |
| `itemNoun` | `string` | no | `"tools"` | What the items are called, plural, in the counter, the group counts and the empty state ("tools"). The counter reads "3 of 9 tools chosen". |
| `loading` | `boolean` | no | `false` | Draw the loading state: three skeleton rows, after 300 ms, under the title and a live search field. Nothing can be chosen until it is false. |
| `loadingLabel` | `string` | no | `"Loading tools and skills"` | Announced politely when the loading placeholder appears. |
| `noMatchHint` | `string` | no | `"Try a shorter word."` | The line under the empty state's heading. |
| `noneChosenLabel` | `string` | no | `"none chosen"` | Words on a group's header, after its count, when none of its items is chosen and something else is. Skills and other groups that cannot be chosen from show their `note` instead. |
| `open` | `boolean` | yes | — | Whether the picker is open. Bindable. It closes itself on Done and Cancel, on Escape and on a click outside, and opens with the chosen items as `selected` says. |
| `query` | `string` | no | `""` | The text in the search field. Bindable. It is cleared when the picker closes, so it opens empty unless the page sets it before opening, such as to open on a search that matches nothing. |
| `searchLabel` | `string` | no | `"Search tools and skills"` | Accessible name and placeholder of the search field. |
| `selected` | `string`[] | no | — | The values of the chosen items. Bindable. The picker works on a copy while it is open: Done writes it back (in the order of `items`, keeping any value no item names), and Cancel and dismissing leave it alone. |
| `title` | `string` | no | `"Add tools and skills"` | Heading of the dialog. |
| `groups` | `(opaque)` | no | — | The groups, in the order they should appear, with a note for a group that cannot be chosen from. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | Everything that can be listed, in the order it should read within each group. Not expressible in JSON Schema; see the component types for the signature. |
| `noMatchTitle` | `(opaque)` | no | — | The heading of the empty state, given what was typed. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | Called when the picker is closed without keeping its choices: Cancel, Escape or a click outside. Not expressible in JSON Schema; see the component types for the signature. |
| `onDone` | `(opaque)` | no | — | Called with the chosen values when Done is pressed, after `selected` is updated. Not expressible in JSON Schema; see the component types for the signature. |
| `triggerRef` | `(opaque)` | no | — | The element focus returns to when the picker closes, usually the button that opened it. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->

Before publishing this component, complete the live [component authoring pre-flight](../../../README.md#component-authoring-checklist).
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
