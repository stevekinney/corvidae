<script lang="ts">
  /**
   * The banner every page shows after a startup where a plugin did not load: how many did not, what
   * that means for agents and workflows, and a link to Settings › Plugins. The count is the plugins
   * the host lists `skipped` plus the folders it could not load a plugin from (`didNotLoadCount`).
   *
   * It is dismissible until the next startup. The host does not report a start of its own, so the
   * client's only sign of one is the connection: a restart makes the host unreachable, and the
   * dismissal is forgotten then, so a startup that still has plugins that did not load shows the
   * banner again. A reload of the page forgets it too. A host that does not answer, or answers
   * with something unreadable, has no banner: the Plugins page says why.
   */
  import { Banner, Button } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getPlugins, didNotLoadCount } from '../../lib/host-plugins.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { PLUGINS_COPY } from '../copy.ts';

  interface Props {
    /** Whether the host is known not to answer, which is what a restart looks like from here. */
    unreachable: boolean;
  }

  let { unreachable }: Props = $props();

  const copy = PLUGINS_COPY.startupBanner;
  const path = '/settings/plugins';

  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      // A banner that cannot be read says nothing; it does not retry behind the person's back.
      retry: false,
    }),
    undefined,
  );

  let dismissed = $state(false);

  // The host stopped answering: it is restarting, and what comes back is a new startup.
  $effect(() => {
    if (unreachable) dismissed = false;
  });

  const count = $derived(plugins.data === undefined ? 0 : didNotLoadCount(plugins.data));

  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if count > 0 && !dismissed}
  <Banner
    variant="warning"
    aria-label={copy.label}
    data-testid="plugins-startup-banner"
    onDismiss={() => (dismissed = true)}
  >
    {copy.message(count)}
    {#snippet actions()}
      <Button variant="secondary" size="sm" href={router.href(path)} onclick={open}
        >{copy.action}</Button
      >
    {/snippet}
  </Banner>
{/if}
