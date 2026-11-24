<script lang="ts">
  import { dehydrate, QueryClient } from '@tanstack/svelte-query';
  import type { CatalogCallOptions, SubscriptionTransport } from '@lostgradient/backchannel/client';
  import { ProbeProvider } from './generated/operation-client.svelte.ts';
  import BrowserChild from './BrowserChild.svelte';
  import { hydrate, onDestroy, unmount } from 'svelte';
  import Ssr from './Ssr.svelte';
  import { SSR_SNAPSHOT } from './ssr-snapshot.ts';
  let scope = $state('a');
  let filter = $state('first');
  let writes = $state(0);
  let hydrationReads = $state(0);
  let aborted = $state(0);
  let lateStarted = $state(false);
  let disconnects = $state(0);
  let cursors = $state<string[]>([]);
  let streamsAborted = $state(0);
  let inspection = $state('');
  let failNext = false;
  let resolveLate: ((value: unknown) => void) | undefined;
  let resolveCommand: ((value: unknown) => void) | undefined;
  const NativeObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class extends NativeObserver {
    override disconnect() {
      disconnects++;
      super.disconnect();
    }
  };
  onDestroy(() => {
    globalThis.IntersectionObserver = NativeObserver;
  });
  const cache = new QueryClient();
  const subscription: SubscriptionTransport = async function* (_name, _input, options) {
    cursors = [...cursors, options?.lastEventId ?? 'start'];
    options?.signal?.addEventListener('abort', () => {
      streamsAborted++;
    });
    yield {
      type: 'event',
      id: '1',
      data: { kind: 'one', cursor: '1', emittedAtMs: 0, payload: {} },
    };
    yield {
      type: 'event',
      id: '2',
      data: { kind: 'two', cursor: '2', emittedAtMs: 0, payload: {} },
    };
  };
  const transport = async (operation: string, input: unknown, options?: CatalogCallOptions) => {
    const value = input as { id?: string; filter?: string; cursor?: string };
    if (operation === 'probe.jobs.cancel') {
      writes++;
      if (value.id === 'ambiguous') throw new Error('lost response');
      if (value.id === 'delayed')
        return new Promise((resolve) => {
          resolveCommand = resolve;
        });
      return { secret: 'synthetic-once-secret' };
    }
    if (value.filter === 'late') {
      lateStarted = true;
      options?.signal?.addEventListener('abort', () => {
        aborted++;
      });
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    }
    if (value.filter === 'fault' || failNext) {
      failNext = false;
      throw new Error('read failed');
    }
    return { jobs: [{ id: `${scope}-${value.filter}`, tenant: scope }], next: null, total: 1 };
  };
  function hydrateSeed(target: HTMLDivElement) {
    target.innerHTML = SSR_SNAPSHOT;
    const hydrated = hydrate(Ssr, { target, props: { onRead: () => hydrationReads++ } });
    return () => {
      void unmount(hydrated);
    };
  }
</script>

<button onclick={() => (filter = 'second')}>Change input</button>
<button onclick={() => (filter = 'fault')}>Initial fault</button>
<button onclick={() => (failNext = true)}>Fail next refresh</button>
<button onclick={() => (filter = 'late')}>Start late read</button>
<button
  onclick={() => resolveLate?.({ jobs: [{ id: 'stale', tenant: 'a' }], next: null, total: 1 })}
  >Resolve late read</button
>
<button onclick={() => (scope = 'b')}>Change scope</button>
<button onclick={() => resolveCommand?.({ secret: 'stale-secret' })}>Resolve delayed command</button
>
<button
  onclick={() =>
    (inspection = JSON.stringify({
      dehydrated: dehydrate(cache),
      mutations: cache.getMutationCache().getAll(),
      local: { ...localStorage },
      session: { ...sessionStorage },
      ssr: SSR_SNAPSHOT,
    }))}>Inspect state</button
>
<output data-testid="writes">{writes}</output>
<output data-testid="aborted">{aborted}</output>
<output data-testid="late-started">{lateStarted}</output>
<output data-testid="observer-disconnects">{disconnects}</output>
<output data-testid="cursors">{cursors.join(',')}</output>
<output data-testid="streams-aborted">{streamsAborted}</output>
<output data-testid="inspection">{inspection}</output>
<output data-testid="hydration-reads">{hydrationReads}</output>
<div data-testid="hydration" {@attach hydrateSeed}></div>
<ProbeProvider {scope} {cache} {transport} {subscription}><BrowserChild {filter} /></ProbeProvider>
