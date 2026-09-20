# FindBar

Docked find-in-document controls for a host-provided search backend.

## Usage

```svelte
<script lang="ts">
  import { FindBar } from '@corvidae/cinder';

  const documents = ['Terminal output', 'Terminal settings', 'Build logs', 'Command history'];
  let open = $state(true);
  let query = $state('terminal');
  let matches = $state(documents.filter((document) => document.toLowerCase().includes(query)));
  let activeIndex = $state(0);

  function search(nextQuery: string) {
    query = nextQuery;
    matches = documents.filter((document) => document.toLowerCase().includes(query.toLowerCase()));
    activeIndex = 0;
  }
</script>

{#if open}
  <FindBar
    bind:value={query}
    bind:activeIndex
    matchCount={matches.length}
    onQueryChange={search}
    onPrevious={() => (activeIndex = (activeIndex - 1 + matches.length) % matches.length)}
    onNext={() => (activeIndex = (activeIndex + 1) % matches.length)}
    onDismiss={() => (open = false)}
  />
{/if}
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `activeIndex` | `number` | no | `0` | Index of the active match within the host-provided results. Bindable. Defaults to `0`. |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `debounceMs` | `number` | no | `250` | Debounce interval, in milliseconds, before `onQueryChange` fires. Defaults to `250`. |
| `label` | `string` | no | `"Find"` | Accessible label for the find controls. Defaults to `'Find'`. |
| `matchCount` | `number` \| `null` | no | `null` | Number of matches for the current query, or `null` when the host has not searched yet. Defaults to `null`. |
| `minQueryLength` | `number` | no | `3` | Minimum query length before the host should search. Defaults to `3`. |
| `value` | `string` | no | `""` | Current query text. Bindable. Defaults to `''`. |
| `onDismiss` | `(opaque)` | no | — | Called when the user dismisses the find bar. Not expressible in JSON Schema; see the component types for the signature. |
| `onNext` | `(opaque)` | no | — | Called when the user requests the next match. Not expressible in JSON Schema; see the component types for the signature. |
| `onPrevious` | `(opaque)` | no | — | Called when the user requests the previous match. Not expressible in JSON Schema; see the component types for the signature. |
| `onQueryChange` | `(opaque)` | no | — | Called with the debounced query text as the user types. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
