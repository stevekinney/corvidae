<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';

  const payload = {
    userId: 'u_8f2a3b',
    action: 'checkout',
    cart: {
      items: [
        { id: 'p_001', name: 'Widget', qty: 2, price: 19.99 },
        { id: 'p_002', name: 'Gadget', qty: 1, price: 49.95 },
      ],
      total: 89.93,
    },
    timestamp: '2026-06-11T14:22:00Z',
    flags: { guestCheckout: false, promoApplied: true },
  };

  // A run's input inside the envelope the engine stores it in: the Fields view lays out the input
  // with the envelope's keys in JSON only, and the JSON view shows the stored envelope. Drawn only
  // behind a query parameter, so the default fixture's baselines stay as they are.
  const envelope = new URLSearchParams(globalThis.location.search).get('envelope') === '1';
  const stored = {
    kind: 'schedule',
    scheduleId: 'release-notes-digest',
    input: { branch: 'main' },
    workspaceAuthority: { workspaceId: 'workspace-1', actorId: 'alice' },
  };
</script>

<PayloadInspector value={payload} label="Checkout payload" />

{#if envelope}
  <div data-testid="payload-envelope" style="inline-size: 20rem;">
    <PayloadInspector
      value={stored}
      fieldsValue={{
        branch: 'main',
        kind: stored.kind,
        scheduleId: stored.scheduleId,
        workspaceAuthority: stored.workspaceAuthority,
      }}
      jsonOnly={['kind', 'scheduleId', 'workspaceAuthority']}
      label="Input"
    />
  </div>
{/if}
