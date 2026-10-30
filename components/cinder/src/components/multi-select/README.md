# MultiSelect

Multi-value dropdown that presents checkbox options inside an anchored floating list.

## Usage

```svelte
<script lang="ts">
  import { MultiSelect } from '@lostgradient/cinder';

  const items = [
    { id: 'apple', label: 'Apple' },
    { id: 'banana', label: 'Banana' },
    { id: 'cherry', label: 'Cherry' },
    { id: 'mango', label: 'Mango' },
    { id: 'orange', label: 'Orange' },
  ] as const;

  let selected = $state<Array<(typeof items)[number]['id']>>(['banana']);
</script>

<MultiSelect id="fruit" label="Fruits" {items} bind:selectedIds={selected} />
```

## Grouped items

Give items a `group` name to render them under headings. Ungrouped items come first without a heading, and groups follow in order of first appearance. Each heading shows the group name and how many of its items are listed. With `filterable`, typing filters across every group, keeps the headings of groups that still match, and hides the rest. A `selectionFeedback` that moves selected items to the top does so within each group.

```svelte
<script lang="ts">
  import { MultiSelect } from '@lostgradient/cinder';

  const tools = [
    { id: 'read', label: 'Read file', group: 'Built in' },
    { id: 'write', label: 'Write file', group: 'Built in' },
    { id: 'search', label: 'Search the web', group: 'Search server' },
  ];

  let selected = $state<string[]>([]);
</script>

<MultiSelect id="tools" label="Tools" items={tools} filterable bind:selectedIds={selected} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `aria-describedby` | `string` | no | — | External id(s) composed into aria-describedby. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-multi-select`. |
| `description` | `string` | no | — | Helper text displayed below the trigger; wired via aria-describedby. |
| `direction` | `"down"` \| `"up"` | no | — | Open direction for the floating panel. |
| `disabled` | `boolean` | no | — | Disables the control. Inherited from a wrapping FormField when unset. |
| `error` | `string` | no | — | Validation error message; sets aria-invalid="true". |
| `filterable` | `boolean` | no | — | Enables the filter input rendered above the options list. |
| `id` | `string` | yes | — | Unique identifier — required for label association and ARIA wiring. |
| `label` | `string` | no | — | Visible label rendered in a `<label>` associated via `for`. |
| `name` | `string` | no | — | Native form field name. Emits one hidden input per selected id. |
| `placeholder` | `string` | no | — | Placeholder text when nothing is selected. |
| `readonly` | `boolean` | no | — | Prevents changing selection while still allowing viewing current selections. |
| `required` | `boolean` | no | — | Marks the field required and shows the required marker on the label. |
| `selectionFeedback` | `"top"` \| `"fixed"` \| `"top-after-reopen"` | no | — | Selected-option ordering behavior when the menu is open. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px, `lg` 40px, the same heights as a Button of that size. |
| `warning` | `string` | no | — | Warning text rendered below the control and included in aria-describedby. |
| `filter` | `(opaque)` | no | — | Custom option filter callback. Defaults to case-insensitive label/description matching. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | Full option set. The sole inference source for T. Not expressible in JSON Schema; see the component types for the signature. |
| `selectedIds` | `(opaque)` | no | — | Bindable selected IDs. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
