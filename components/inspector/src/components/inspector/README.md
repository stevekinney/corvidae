# Inspector

<!-- generated:a11y-record:required -->

`Inspector` groups the properties of one record as quiet rows, for a detail page. Each `InspectorRow` is a muted label in a fixed 140px column, the value in the default text colour, and a trailing affordance; an editable row becomes an editor when it is activated, and a read-only row draws no affordance, so the two never look the same. At desktop width the group is a right rail on one tinted surface with separators inset to the text. Below 700px each label stacks above its value and the group reads as a grouped list on the raised surface a `GroupedList` uses. Every row is at least 44px tall.

## Usage

```svelte
<script lang="ts">
  import { Inspector, InspectorRow } from '@lostgradient/cinder';

  let status = $state('open');
  let title = $state('Spring menu launch');
</script>

<Inspector header="Details">
  <InspectorRow
    label="Title"
    kind="text"
    current={title}
    onCommit={(next) => (title = String(next))}
  >
    {#snippet value()}{title}{/snippet}
  </InspectorRow>
  <InspectorRow
    label="Status"
    kind="select"
    current={status}
    options={[
      { value: 'open', label: 'Open' },
      { value: 'closed', label: 'Closed' },
    ]}
    onCommit={(next) => (status = String(next))}
  >
    {#snippet value()}{status === 'open' ? 'Open' : 'Closed'}{/snippet}
  </InspectorRow>
  <InspectorRow label="Created">
    {#snippet value()}Nov 10, 2026{/snippet}
  </InspectorRow>
</Inspector>
```

## Right rail and phone layout

Put the inspector in a narrow column beside the page content for a right rail. Below 700px the label of each row stacks above its value and the group sits on the raised surface of a grouped list, so the same markup is the properties section of a phone page. Give it a `header` to name the group.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-inspector`. |
| `header` | `string` | no | — | A header drawn above the group, outside its surface, in small muted text. It also names the group. |
| `children` | `(opaque)` | no | — | The rows: InspectorRow elements. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
