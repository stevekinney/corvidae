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
| `activeIndex` | `number` | no | `0` | Index of the active match within the host-provided results. Bindable, but not input-only: the component resets it to `0` itself whenever the user edits the query, and clamps it into `[0, matchCount - 1]` whenever `matchCount` changes—a parent binding this prop should expect it to be overwritten in both cases, not treat it as a preserved selection. Defaults to `0`. |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `debounceMs` | `number` | no | `250` | Debounce interval, in milliseconds, before `onQueryChange` fires for an eligible query. Does not apply to the synchronous `''` notification `onQueryChange` sends when a previously eligible query shrinks below `minQueryLength`—see that prop. Defaults to `250`. |
| `label` | `string` | no | `"Find"` | Accessible label for the find controls. Defaults to `'Find'`. |
| `matchCount` | `number` \| `null` | no | `null` | Number of matches for the current query, or `null` when the host has not searched yet. Bindable—the component resets it to `null` itself whenever the user starts a new search, so bind it rather than mirror `onQueryChange` manually to stay in sync with that reset. Defaults to `null`. |
| `minQueryLength` | `number` | no | `3` | Minimum trimmed query length before the host should search—eligibility is checked against `value.trim().length`, not `value.length`, so whitespace-only or whitespace-padded input doesn't count toward it (e.g. `' a '` stays ineligible at `minQueryLength={3}`). Defaults to `3`. |
| `value` | `string` | no | `""` | Current query text. Bindable. Defaults to `''`. |
| `onDismiss` | `(opaque)` | no | — | Called when the user dismisses the find bar. Not expressible in JSON Schema; see the component types for the signature. |
| `onNext` | `(opaque)` | no | — | Called when the user requests the next match. Not expressible in JSON Schema; see the component types for the signature. |
| `onPrevious` | `(opaque)` | no | — | Called when the user requests the previous match. Not expressible in JSON Schema; see the component types for the signature. |
| `onQueryChange` | `(opaque)` | no | — | Called with the debounced query text once user typing (the `input` event) reaches `minQueryLength`. Also called immediately with `''`, bypassing the debounce, the moment a previously eligible query shrinks below `minQueryLength`—handle the empty-string case as a synchronous reset, not just the debounced value. Only that ineligible-transition case is notified when triggered externally: assigning an eligible `value` via `bind:value`, or lowering `minQueryLength` so the current `value` becomes eligible, does not itself call this callback—a host that restores or sets `value` programmatically must trigger its own search rather than rely on this firing. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
