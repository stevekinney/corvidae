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
  hasPreviousPage={cursors.previous !== undefined}
  hasNextPage={cursors.next !== undefined}
  onPrevious={() => loadPage(cursors.previous)}
  onNext={() => loadPage(cursors.next)}
/>
```

### Callback mode

Giving `onPrevious` or `onNext` enables callback mode, which serves offset and cursor paging:

- Activating Previous or Next calls the callback with no arguments and leaves `currentPage` unchanged.
- Previous is enabled when `onPrevious` is given and `hasPreviousPage` is true, and Next when `onNext` is given and `hasNextPage` is true, so a list opened partway through can still go back. A direction with no callback stays disabled.
- No page-number buttons render. When `totalPages` is given, a "Page N of M" label shows between the buttons, using `currentPage` (default 1) for N; cursor paging without a total can omit `currentPage`.
- Without either callback, rendering and behavior are unchanged.

### Custom count text

`countLabel` replaces the default "N results" text shown for `totalCount`. It receives the raw count, so format it yourself.

```svelte
<Pagination totalPages={3} totalCount={1234} countLabel={(count) => `${count} runs`} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-pagination`. |
| `currentPage` | `number` | no | `1` | Current page number (1-indexed). Bindable. In callback mode it only feeds the "Page N of M" label, so cursor paging can omit it. |
| `hasNextPage` | `boolean` | no | `false` | Whether a next page is available. When totalPages is unknown, defaults to false. In callback mode (`onPrevious` or `onNext` given) Next is enabled only when `onNext` is given and this is true. |
| `hasPreviousPage` | `boolean` | no | — | Whether a previous page is available. When totalPages is unknown, defaults to currentPage > 1. In callback mode (`onPrevious` or `onNext` given) Previous is enabled only when `onPrevious` is given and this is true. |
| `totalCount` | `number` | no | — | Optional total record count; formatted with formatNumber when provided. |
| `totalPages` | `number` | no | — | Total number of pages. Omit when only previous/next availability is known. |
| `countLabel` | `(opaque)` | no | — | Formats the `totalCount` text in place of the default "N results". Receives the raw count, so format it with your own locale rules. Not expressible in JSON Schema; see the component types for the signature. |
| `onNext` | `(opaque)` | no | — | Called when the user asks for the next page. Giving this or `onPrevious` puts the component in callback mode: `currentPage` is never changed by the component, Next is enabled when this is given and `hasNextPage` is true, and no page-number buttons render. When `totalPages` is given the controls show "Page N of M". Not expressible in JSON Schema; see the component types for the signature. |
| `onPrevious` | `(opaque)` | no | — | Called when the user asks for the previous page. Giving this or `onNext` puts the component in callback mode: `currentPage` is never changed by the component, Previous is enabled when this is given and `hasPreviousPage` is true, and no page-number buttons render. Keep the offset or cursor in the caller. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
