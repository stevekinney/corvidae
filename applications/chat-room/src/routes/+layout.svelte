<script lang="ts">
  // The package root loads the base cascade before component styles.
  import * as cinderCascade from '@corvidae/cinder';
  import favicon from '../lib/assets/favicon.svg';

  void cinderCascade;
  let { children } = $props();
  // Hydration beacon for Playwright: effects run only in the browser, after
  // the tree mounts, so this marks the moment SSR-rendered controls have
  // live handlers. Tests wait for it before their first interaction —
  // clicking earlier lands on dead DOM and flakes under parallel workers.
  $effect(() => {
    document.body.dataset['hydrated'] = 'true';
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
