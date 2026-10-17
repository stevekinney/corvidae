# Pagination

Page-navigation control for stepping through multi-page result sets.

## Usage

```svelte
<script lang="ts">
  import { Pagination } from '@lostgradient/cinder';

  let currentPage = $state(1);
</script>

<Pagination bind:currentPage totalPages={10} />
```

When the total page count is unknown, omit `totalPages` and pass the direction availability you know:

```svelte
<script lang="ts">
  import { Pagination } from '@lostgradient/cinder';

  let currentPage = $state(1);
  let hasNextPage = $state(false);
</script>

<Pagination bind:currentPage hasPreviousPage={currentPage > 1} {hasNextPage} />
```

This renders the current page and previous/next controls without implying a fake final page.

### REST Link headers

```svelte
<script lang="ts">
  import { Pagination } from '@lostgradient/cinder';

  let currentPage = $state(1);
  let links = $state<{ prev?: string; next?: string }>({});
</script>

<Pagination
  bind:currentPage
  hasPreviousPage={links.prev !== undefined}
  hasNextPage={links.next !== undefined}
/>
```

### Cursor pagination

Pass `onPrevious` and `onNext` to put the component in callback mode. The caller keeps the offset or cursors and is told when the user asks for the previous or next page; the component never changes `currentPage`.

```svelte
<script lang="ts">
  import { Pagination } from '@lostgradient/cinder';

  let cursors = $state<{ previous?: string; next?: string }>({});

  function loadPage(cursor: string | undefined): void {
    // Fetch the page for this cursor and update `cursors`.
  }
</script>

<Pagination
  currentPage={1}
  hasPreviousPage={cursors.previous !== undefined}
  hasNextPage={cursors.next !== undefined}
  onPrevious={() => loadPage(cursors.previous)}
  onNext={() => loadPage(cursors.next)}
/>
```

### Callback mode

Giving `onPrevious` or `onNext` enables callback mode, which serves offset and cursor paging:

- Activating Previous or Next calls the callback with no arguments and leaves `currentPage` unchanged.
- Previous is enabled by `hasPreviousPage` alone (default `false`) and Next by `hasNextPage` alone, so a list opened partway through can still go back.
- No page-number buttons render. When `totalPages` is given, a "Page N of M" label shows between the buttons, using `currentPage` for N.
- Without either callback, rendering and behavior are unchanged.

### Custom count text

`countLabel` replaces the default "N results" text shown for `totalCount`. It receives the raw count, so format it yourself.

```svelte
<Pagination
  currentPage={1}
  totalPages={3}
  totalCount={1234}
  countLabel={(count) => `${count} runs`}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-pagination`. |
| `currentPage` | `number` | yes | — | Current page number (1-indexed). Bindable. |
| `hasNextPage` | `boolean` | no | `false` | Whether a next page is available. When totalPages is unknown, defaults to false. In callback mode (`onPrevious` or `onNext` given) it alone decides. |
| `hasPreviousPage` | `boolean` | no | — | Whether a previous page is available. When totalPages is unknown, defaults to currentPage > 1. In callback mode (`onPrevious` or `onNext` given) it alone decides, defaulting to false. |
| `totalCount` | `number` | no | — | Optional total record count; formatted with formatNumber when provided. |
| `totalPages` | `number` | no | — | Total number of pages. Omit when only previous/next availability is known. |
| `countLabel` | `(opaque)` | no | — | Formats the `totalCount` text in place of the default "N results". Receives the raw count, so format it with your own locale rules. Not expressible in JSON Schema; see the component types for the signature. |
| `onNext` | `(opaque)` | no | — | Called when the user asks for the next page. Giving this or `onPrevious` puts the component in callback mode: `currentPage` is never changed by the component, Next is enabled by `hasNextPage` alone, and no page-number buttons render. When `totalPages` is given the controls show "Page N of M". Not expressible in JSON Schema; see the component types for the signature. |
| `onPrevious` | `(opaque)` | no | — | Called when the user asks for the previous page. Giving this or `onNext` puts the component in callback mode: `currentPage` is never changed by the component, Previous is enabled by `hasPreviousPage` alone, and no page-number buttons render. Keep the offset or cursor in the caller. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
