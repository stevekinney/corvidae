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
  import { createQuery } from '@tanstack/svelte-query';
  import { onMount, type Snippet } from 'svelte';

  import { RETRY_LABEL, SETTINGS_COPY, VIEW_COPY } from '../../app/copy.ts';
  import { getSettings, getSettingsSchema } from '../../lib/bureau-settings.ts';
  import { queryKeys } from '../../lib/query.ts';
  import SettingsEditor from './settings-editor.svelte';
  import SettingsSectionNav from './settings-section-nav.svelte';
  import { SettingsFollower } from './settings-follower.ts';
  import { SettingsReader } from './settings-reader.ts';
  import type { SettingsSectionId } from './settings-controls.ts';

  interface Props {
    /** Which settings this section edits. */
    section: SettingsSectionId;
    /** The page's heading. */
    title: string;
    /** The sentence under the heading. */
    intro: string;
    /** Names the page for tests and the responsive specification. */
    page: string;
    /** What follows the editor. */
    after?: Snippet;
  }

  let { section, title, intro, page, after }: Props = $props();

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

<section class="weft-settings" aria-label={title} data-page={page}>
  <SettingsSectionNav />
  <PageHeader {title} description={intro} />

  <!-- A read that fails while the page holds the settings leaves the form as it is, edits and all. -->
  {#if (schema.isError && schema.data === undefined) || (snapshot.isError && snapshot.data === undefined)}
    <Alert variant="danger">
      <p class="weft-settings__alert-title">{VIEW_COPY.settings.error.title}</p>
      <p class="weft-settings__alert-body">{VIEW_COPY.settings.error.description}</p>
      <Button
        variant="secondary"
        size="sm"
        onclick={() => {
          void schema.refetch();
          void snapshot.refetch();
        }}>{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if schema.data === undefined || snapshot.data === undefined}
    <div role="status" aria-busy="true" aria-label={VIEW_COPY.settings.loading.title}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else}
    {#if !snapshot.data.persisted}
      <Alert variant="info" data-testid="settings-not-persisted">
        <p class="weft-settings__alert-body">{SETTINGS_COPY.notPersisted}</p>
      </Alert>
    {/if}
    {#if snapshot.isError}
      <Alert variant="warning" data-testid="settings-refresh-failed">
        <p class="weft-settings__alert-title">{SETTINGS_COPY.refreshFailed.title}</p>
        <p class="weft-settings__alert-body">{SETTINGS_COPY.refreshFailed.description}</p>
      </Alert>
    {/if}
    <SettingsEditor schema={schema.data} snapshot={snapshot.data} {section} />
  {/if}

  {@render after?.()}
</section>

<style>
  .weft-settings {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .weft-settings__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-settings__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
