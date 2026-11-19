<script lang="ts">
  /**
   * A list page's empty state: the one layout every list page uses when it has nothing in it yet
   * (owner report, 2026-11-19). It is Cinder's `EmptyState`, whose one layout owns the
   * alignment, the measure and the buttons; this adds the two things Interborough
   * decides: the icon is the one the page's sidebar item shows (`destinationIcon`), and the create
   * action is the primary, with a leading "+", in the header's verb ("New goal", never "Create a
   * goal"). A page passes only its view, its words and its actions.
   *
   * The words say what the thing is and what to do, with no paths, tool ids or file formats; where
   * the files matter, the page puts a `FileLocationDetail` in `children`, which stays closed.
   */
  import type { Snippet } from 'svelte';

  import { EmptyState, type EmptyStateAction, type EmptyStateKind } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';

  import { destinationIcon } from './shell/destinations.ts';
  import type { ViewName } from './views.ts';

  interface ListPageEmptyProps {
    /** The view whose list is empty, which names the icon. */
    view: ViewName;
    title: string;
    description: string;
    /** The page's create action, drawn primary with a "+"; it changes something, so it is held while stale. */
    create?: EmptyStateAction | undefined;
    /** At most a secondary or two after it, such as "Ask an agent". */
    secondary?: readonly EmptyStateAction[];
    /** `done` for a list that is empty because the work is finished (Reviews). */
    kind?: EmptyStateKind;
    /** Under a page heading the state's own heading is level two. */
    headingLevel?: 1 | 2 | 3;
    /** Supporting content under the buttons, such as where the files live. */
    children?: Snippet;
    'data-testid'?: string;
  }

  let {
    view,
    title,
    description,
    create,
    secondary = [],
    kind = 'first-use',
    headingLevel = 2,
    children,
    'data-testid': testId,
  }: ListPageEmptyProps = $props();

  const Icon = $derived(destinationIcon(view));
  const actions = $derived<EmptyStateAction[]>([
    ...(create === undefined
      ? []
      : [{ icon: plus, mutating: true, ...create, variant: 'primary' as const }]),
    ...secondary.map((action) => ({ ...action, variant: 'secondary' as const })),
  ]);
</script>

{#snippet plus()}<Plus aria-hidden="true" />{/snippet}

{#snippet pageIcon()}
  {#if Icon}<Icon aria-hidden="true" />{/if}
{/snippet}

<EmptyState
  {kind}
  {headingLevel}
  {title}
  {description}
  {actions}
  {...children === undefined ? {} : { children }}
  {...Icon === undefined ? {} : { icon: pageIcon }}
  data-list-empty={view}
  data-testid={testId}
/>
