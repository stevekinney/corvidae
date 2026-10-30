# DescriptionList

Semantic dl/dt/dd list for term–description pairs such as metadata or attributes.

## Usage

```svelte
<script lang="ts">
  import { DescriptionList } from '@lostgradient/cinder';
  import type { DescriptionListItem } from '@lostgradient/cinder';

  const items: DescriptionListItem[] = [
    { term: 'Component', definition: 'DescriptionList' },
    { term: 'Status', definition: 'Stable' },
    { term: 'Version', definition: '1.0.0' },
    { term: 'License', definition: 'MIT' },
    { term: 'Maintainer', definition: 'Cinder team' },
  ];
</script>

<DescriptionList {items} />
```

The `two-column` variant sets a muted term on the left and the value on the right, with no row dividers.

### Formatted values

A definition can be a value the list formats, so every list shows timestamps, IDs and tags the same way:

- `{ type: 'timestamp', value }`: a readable date and time, with the exact time (full date, seconds and zone) on hover.
- `{ type: 'identifier', value }`: an ID or hash, shortened and set in small monospace, with an icon-only copy button that copies the whole value.
- `{ type: 'tags', tags, systemTagCount, onAddTag }`: read-only tags, with system tags counted instead of listed and an _Add a tag_ action that calls `onAddTag`.

```svelte
<script lang="ts">
  import { DescriptionList } from '@lostgradient/cinder';
  import type { DescriptionListItem } from '@lostgradient/cinder';

  const items: DescriptionListItem[] = [
    {
      term: 'Run ID',
      definition: { type: 'identifier', value: '3f2b9c1a-7d4e-4a86-9b0c-1e5d6f7a8b90' },
    },
    { term: 'Started', definition: { type: 'timestamp', value: '2026-10-30T14:15:07Z' } },
    {
      term: 'Tags',
      definition: {
        type: 'tags',
        tags: ['billing', 'nightly'],
        systemTagCount: 3,
        onAddTag: () => console.log('add a tag'),
      },
    },
  ];
</script>

<DescriptionList {items} variant="two-column" />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-description-list` root element. |
| `variant` | `"default"` \| `"striped"` \| `"two-column"` \| `"narrow"` | no | — | Controls the visual layout: - `default`: stacked rows with visible terms. - `striped`: alternating row backgrounds. - `two-column`: a muted term on the left and the value on the right, with no row dividers; collapses to stacked at narrow widths. - `narrow`: `<dt>` is visually hidden via `.cinder-sr-only`. Only appropriate when surrounding context already labels the value. NOT a general compact mode. |
| `actions` | `(opaque)` | no | — | Optional snippet rendered once per row. Receives the full `DescriptionListItem` so consumers can build disambiguated `aria-label` strings (e.g. `aria-label="Edit ${item.term}"`). Any interactive element in `actions` MUST set an unambiguous `aria-label`. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
