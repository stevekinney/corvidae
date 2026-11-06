<script lang="ts">
  /**
   * The frame every section that edits settings shares: the section navigation, the page header, the
   * settings read from the Bureau (`bureau.settings.get` and `.schema`), and the editor over them.
   * The page subscribes to `bureau.settings.events` over Server-Sent Events (`settings-follower.ts`)
   * and reads the settings again on each event, so a change made elsewhere shows here as it
   * happens. It also reads them again when the window regains focus, which is how it catches up
   * when the stream is down.
   *
   * Owner scoping does not apply: the settings are deployment-wide, and the caller holds the scopes
   * that read and change them (`bureau.settings:read`, `:write`). Whether the Bureau is failing or
   * refusing is the view frame's to say (`app/view-probes.ts`).
   */
  import { Alert, Button, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { CircleCheck } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, type Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import { RETRY_LABEL, SETTINGS_COPY, VIEW_COPY } from '../../app/copy.ts';
  import {
    getSettings,
    getSettingsSchema,
    type SettingsSchema,
    type SettingsSnapshot,
  } from '../../lib/bureau-settings.ts';
  import { queryKeys } from '../../lib/query.ts';
  import SettingsSectionNav from './settings-section-nav.svelte';
  import { SettingsFollower } from './settings-follower.ts';
  import { SettingsReader } from './settings-reader.ts';

  interface Props {
    /** The page's heading. */
    title: string;
    /** The sentence under the heading. */
    intro: string;
    /** Names the page for tests and the responsive specification. */
    page: string;
    /**
     * The section's settings. It draws straight into the page's grid, so it places what it draws
     * in the grid areas `banner` (a sticky notice over the whole page) and `content` (the reading
     * column); a section saves each setting as it is left. `setHeaderStatus` puts a status at the
     * right of the heading ("Saved just now"), or takes it away when given nothing.
     */
    body: Snippet<
      [
        {
          schema: SettingsSchema;
          snapshot: SettingsSnapshot;
          setHeaderStatus: (status: string | undefined) => void;
        },
      ]
    >;
  }

  let { title, intro, page, body }: Props = $props();

  /** Whether the section navigation sits beside the content: 640px and wider. */
  const wide = new MediaQuery('(min-width: 40rem)', true);
  const queryClient = useQueryClient();
  /** Whether the person gave up on a read that took longer than usual. */
  let canceled = $state(false);
  /** The status a section put at the right of the heading, if any. */
  let headerStatus = $state<string | undefined>(undefined);

  /** What the page is showing: the settings, a failed read, a read given up on, or the placeholders. */
  const phase = $derived.by(() => {
    if (
      (schema.isError && schema.data === undefined) ||
      (snapshot.isError && snapshot.data === undefined)
    ) {
      return 'error' as const;
    }
    if (schema.data === undefined || snapshot.data === undefined) {
      return canceled ? ('canceled' as const) : ('loading' as const);
    }
    return 'ready' as const;
  });

  function cancelLoading(): void {
    canceled = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.settings.schema() });
    void queryClient.cancelQueries({ queryKey: queryKeys.settings.snapshot() });
  }

  function tryAgain(): void {
    canceled = false;
    void schema.refetch();
    void snapshot.refetch();
  }

  const schema = createQuery(
    () => ({
      queryKey: queryKeys.settings.schema(),
      queryFn: ({ signal }) => getSettingsSchema({ signal }),
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    }),
    undefined,
  );

  const snapshot = createQuery(
    () => ({
      queryKey: queryKeys.settings.snapshot(),
      queryFn: ({ signal }) => getSettings({ signal }),
      retry: false,
    }),
    undefined,
  );

  // A refetch of a query that holds no data joins the fetch in flight, which may have read the
  // settings before the change; the reader reads again when the read it got is not known to be new
  // enough (`settings-reader.ts`).
  const reader = new SettingsReader({
    read: async () => {
      const joined = snapshot.isFetching && snapshot.data === undefined;
      const result = await snapshot.refetch();
      return result.isSuccess ? { revision: result.data.revision, fresh: !joined } : undefined;
    },
  });

  // A change made elsewhere reaches the page as an event; the settings are read again on each one,
  // and once the Bureau accepts the subscription, so none is missed in between.
  onMount(() => {
    const follower = new SettingsFollower({
      onChange: (revision) => void reader.notify(revision),
    });
    void follower.start();
    return () => follower.dispose();
  });
</script>

{#snippet headerStatusLine()}
  <span class="weft-settings__status" role="status" data-testid="settings-header-status">
    <CircleCheck size={14} aria-hidden="true" />
    {headerStatus}
  </span>
{/snippet}

<section class="weft-settings" aria-label={title} data-page={page}>
  <div class="weft-settings__nav"><SettingsSectionNav /></div>
  <div class="weft-settings__title-area">
    <PageHeader
      flush
      title={wide.current ? title : SETTINGS_COPY.general.narrowTitle}
      {...wide.current ? { description: intro } : {}}
      {...headerStatus === undefined ? {} : { actions: headerStatusLine }}
    />
  </div>

  {#if phase === 'ready' && schema.data !== undefined && snapshot.data !== undefined}
    {#if !snapshot.data.persisted}
      <div class="weft-settings__content">
        <Alert variant="info" data-testid="settings-not-persisted">
          <p class="weft-settings__alert-body">{SETTINGS_COPY.notPersisted}</p>
        </Alert>
      </div>
    {/if}
    {@render body({
      schema: schema.data,
      snapshot: snapshot.data,
      setHeaderStatus: (status) => (headerStatus = status),
    })}
  {:else}
    <div class="weft-settings__content">
      {#if phase === 'error'}
        <Alert variant="danger">
          <p class="weft-settings__alert-title">{VIEW_COPY.settings.error.title}</p>
          <p class="weft-settings__alert-body">{VIEW_COPY.settings.error.description}</p>
          <Button variant="secondary" size="sm" onclick={tryAgain}>{RETRY_LABEL}</Button>
        </Alert>
      {:else if phase === 'canceled'}
        <div data-testid="settings-canceled">
          <p class="weft-settings__alert-body">{SETTINGS_COPY.general.loading.canceled}</p>
          <Button variant="secondary" size="sm" onclick={tryAgain}
            >{SETTINGS_COPY.general.loading.tryAgain}</Button
          >
        </div>
      {:else if phase === 'loading'}
        <!-- The navigation and heading are real; the rows are placeholders after 300 ms, then say it is slow (row 14l). -->
        <Skeleton
          variant="card"
          lines={4}
          delay={300}
          stillLoadingAfter={10_000}
          stillLoadingLabel={SETTINGS_COPY.general.loading.stillLoading}
          label={SETTINGS_COPY.general.loading.label}
          onCancel={cancelLoading}
        />
      {/if}
    </div>
  {/if}
</section>

<style>
  /*
   * One page: the section navigation in a 170px column beside one reading column, from 640px up
   * (design rows 05f, 47a). Below it the heading, the section select, a notice and the content
   * stack. A section can add a sticky notice in the `banner` area over the whole page.
   */
  .weft-settings {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
    grid-template-areas:
      'banner banner'
      'nav header'
      'nav content';
    grid-template-rows: auto auto 1fr;
    column-gap: var(--cinder-space-8);
    row-gap: 0;
    align-items: start;
    padding-block: var(--cinder-space-4);
  }

  .weft-settings__nav {
    grid-area: nav;
    min-inline-size: 0;
  }

  .weft-settings__title-area {
    grid-area: header;
    max-inline-size: 46rem;
    min-inline-size: 0;
    margin-block-end: var(--cinder-space-6);
  }

  .weft-settings__content {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    max-inline-size: 46rem;
    min-inline-size: 0;
  }

  .weft-settings__status {
    display: inline-flex;
    gap: var(--cinder-space-1);
    align-items: center;
    color: var(--cinder-status-success-text);
    font-size: var(--cinder-text-sm);
  }

  .weft-settings__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-settings__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  @media (max-width: 39.99rem) {
    .weft-settings {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        'header'
        'nav'
        'banner'
        'content';
      grid-template-rows: auto;
      row-gap: var(--cinder-space-3);
    }

    .weft-settings__title-area {
      margin-block-end: 0;
    }
  }
</style>
