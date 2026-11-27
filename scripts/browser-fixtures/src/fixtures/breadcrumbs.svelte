<script lang="ts">
  import { Breadcrumbs } from '@lostgradient/cinder';

  // COR-2327 B2: a trail whose current page is a popover trigger (a chat's title switcher) is drawn
  // only behind a query parameter, as the chat fixture gates its attachment scenario, so the
  // default fixture, its baselines and its axe sweep stay as they are.
  const parameters = new URLSearchParams(globalThis.location.search);
  const popoverTrail = parameters.get('popover') === '1';
  // COR-2770: a trail whose earlier ancestors fold into the "…" menu at every width, behind its own
  // query parameter for the same reason.
  const overflowTrail = parameters.get('overflow') === '1';
</script>

<Breadcrumbs
  items={[
    { label: 'Home', href: '/' },
    { label: 'Projects', href: '/projects' },
    { label: 'Cinder', href: '/projects/cinder' },
    { label: 'Settings' },
  ]}
/>

{#if overflowTrail}
  <div data-testid="overflow-trail">
    <Breadcrumbs
      maxVisible={1}
      items={[
        { label: 'Home', href: '/' },
        { label: 'Agents', href: '/agents' },
        { label: 'Tool runner', href: '/agents/tool-runner' },
        { label: 'Memory' },
      ]}
    />
  </div>
{/if}

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
