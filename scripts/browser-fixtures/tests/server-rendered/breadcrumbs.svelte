<!--
  The `breadcrumbs` fixture's default trail, server-renderable: it reads no browser globals, so
  `breadcrumbs-first-paint.playwright.ts` renders it with the real server runtime and serves the
  HTML with JavaScript off (COR-2770). Keep the items equal to `src/fixtures/breadcrumbs.svelte`,
  whose hydrated layout the first paint is compared with.
-->
<script lang="ts">
  import { Breadcrumbs } from '@lostgradient/cinder';
</script>

<Breadcrumbs
  items={[
    { label: 'Home', href: '/' },
    { label: 'Projects', href: '/projects' },
    { label: 'Cinder', href: '/projects/cinder' },
    { label: 'Settings' },
  ]}
/>
