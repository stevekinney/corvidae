<script lang="ts">
  import Button from '../button/button.svelte';
  import StaleRegion from '../stale-region/stale-region.svelte';
  import PageHeader from './page-header.svelte';
  import type { PageHeaderStatusPlacement } from './page-header.types.ts';

  let {
    error = false,
    stale = false,
    createHref,
    onCreate,
    statusPlacement,
    withStatus = false,
    withActions = false,
    withCreate = true,
    title = 'Agents',
    titleText,
  }: {
    error?: boolean;
    stale?: boolean;
    createHref?: string;
    onCreate?: () => void;
    statusPlacement?: PageHeaderStatusPlacement;
    withStatus?: boolean;
    withActions?: boolean;
    withCreate?: boolean;
    title?: string;
    titleText?: string;
  } = $props();
</script>

{#snippet statusSnippet()}
  <span class="harness-status">Waiting on you</span>
{/snippet}

{#snippet actionsSnippet()}
  <Button variant="primary">Add a memory</Button>
  <Button variant="danger">Delete</Button>
{/snippet}

{#snippet markdownTitle()}<em>{title}</em>{/snippet}

<StaleRegion {stale}>
  <PageHeader
    title={titleText === undefined ? title : markdownTitle}
    {...titleText === undefined ? {} : { titleText }}
    description="Agents run your chats, goals and schedules."
    {error}
    {...withStatus ? { status: statusSnippet } : {}}
    {...statusPlacement === undefined ? {} : { statusPlacement }}
    {...withActions ? { actions: actionsSnippet } : {}}
    {...withCreate
      ? {
          createAction: {
            label: 'New agent',
            ...(createHref === undefined ? {} : { href: createHref }),
            ...(onCreate === undefined ? {} : { onclick: onCreate }),
          },
        }
      : {}}
  />
</StaleRegion>
