# KeyFacts

<!-- generated:a11y-record:required -->

`KeyFacts` is a row of typed facts, each an icon and a value, such as a kind, a neighbourhood and a price band. Facts are separated by space; no separator glyph is drawn between them. The row wraps only between facts, so a fact never breaks across two lines, and a value longer than its row is cut with an ellipsis.

Each fact takes an optional icon, a value and an optional `href` that makes the value a link. The icon is decorative; give a fact a `label` such as "Neighborhood" to name its kind for assistive technology.

## Usage

```svelte
<script lang="ts">
  import { KeyFacts } from '@lostgradient/cinder';
</script>

<KeyFacts
  label="Details"
  items={[
    { label: 'Kind', value: 'Cocktail bar' },
    { label: 'Neighborhood', value: 'LoDo', href: '/neighborhoods/lodo' },
    { label: 'Price', value: '$$' },
  ]}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-key-facts`. |
| `label` | `string` | no | — | Accessible name of the list, such as "Details". Left unset, the list is unnamed. |
| `items` | `(opaque)` | yes | — | The facts in reading order. A fact wraps to the next line as a whole, and no separator glyph is drawn between facts. Not expressible in JSON Schema; see the component types for the signature. |

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
