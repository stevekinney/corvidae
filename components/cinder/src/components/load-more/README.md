# LoadMore

Sentinel-based infinite-scroll trigger with an always-visible button fallback and accessible status states.

Use `LoadMore` to fetch the next page of results as the reader reaches the end of a growing list. Use [`VirtualList`](../virtual-list/README.md) to window rows that are already loaded when rendering every row would be expensive.

`onLoadMore` should be provided in real usage. When omitted, the component falls back to a no-op handler.

## Usage

```svelte
<script lang="ts">
  import { LoadMore } from '@lostgradient/cinder';

  let loading = $state(false);
  let hasMore = $state(true);

  async function fetchNext() {
    loading = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    loading = false;
    hasMore = false;
  }
</script>

<LoadMore onLoadMore={fetchNext} bind:loading bind:hasMore />
```

## Footer with a count

Pass `loadedCount` and `totalCount` and the footer reads "Showing 10 of 19" beside its button, in one centered row. When `onLoadMore` rejects, the footer keeps the count and says what went wrong in words, with a "Try again" button: "Couldn’t load more runs. Showing 10 of 19." Name what the list holds with `itemLabel` ("runs"), or replace the whole message with `errorMessage`.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `buttonLabel` | `string` | no | `"Load more"` | Visible label for the load-more button. |
| `class` | `string` | no | — | Custom class merged with `.cinder-load-more`. |
| `countNoun` | `string` | no | — | What the count counts, said after it: "waiting tasks" gives "Showing 3 of 12 waiting tasks". Without it the footer reads "Showing 3 of 12". |
| `endOfListMessage` | `string` | no | `"End of list"` | Politely announced when the end of the list is reached. |
| `errorMessage` | `string` | no | — | Replaces the whole failure message shown after `onLoadMore` rejects. By default it reads "Couldn’t load more {itemLabel}." followed by the count when `loadedCount` and `totalCount` are set. |
| `hasMore` | `boolean` | no | — | Whether more items are available. Bindable. |
| `itemLabel` | `string` | no | `"items"` | What the list holds, in the plural, for the failure message: "runs" gives "Couldn’t load more runs." |
| `loadedCount` | `number` | no | — | How many items the list shows now. With `totalCount` the footer reads "Showing 10 of 19" next to its button, and keeps that count when a load fails. |
| `loading` | `boolean` | no | — | Whether a load is in progress. Bindable. |
| `maxRetries` | `number` | no | `5` | Maximum consecutive sentinel-triggered requests before auto-loading pauses. |
| `retryLabel` | `string` | no | `"Try again"` | Visible label for the retry button after a load error. |
| `rootMargin` | `string` | no | — | rootMargin passed to IntersectionObserver. Captured at attachment time. |
| `totalCount` | `number` | no | — | How many items exist in all; pairs with `loadedCount`. |
| `onError` | `(opaque)` | no | — | Notified when onLoadMore throws or rejects. Not expressible in JSON Schema; see the component types for the signature. |
| `onLoadMore` | `(opaque)` | no | — | Called when the next page should be loaded. Caller flips `loading` and `hasMore`. Not expressible in JSON Schema; see the component types for the signature. |
| `root` | `(opaque)` | no | — | Scroll container the sentinel is observed within. Pass the scrollable ancestor element when the list scrolls inside a container rather than the viewport. `null`/omitted observes against the viewport. Captured at attachment time. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
