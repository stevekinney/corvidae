<script lang="ts">
  import { Breadcrumbs } from '@lostgradient/cinder';

  // COR-2327 B2: a trail whose current page is a popover trigger (a chat's title switcher) is drawn
  // only behind a query parameter, as the chat fixture gates its attachment scenario, so the
  // default fixture, its baselines and its axe sweep stay as they are.
  const popoverTrail = new URLSearchParams(globalThis.location.search).get('popover') === '1';
</script>

<Breadcrumbs
  items={[
    { label: 'Home', href: '/' },
    { label: 'Projects', href: '/projects' },
    { label: 'Cinder', href: '/projects/cinder' },
    { label: 'Settings' },
  ]}
/>

{#if popoverTrail}
  <div data-testid="popover-trail">
    <Breadcrumbs
      items={[
        { label: 'Chat', href: '/chats' },
        { label: 'Please refund order 4471, it arrived damaged.', popover: true },
      ]}
    />
  </div>
{/if}
