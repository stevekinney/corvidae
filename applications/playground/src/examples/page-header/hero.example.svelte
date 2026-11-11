<script lang="ts" module>
  export const title = 'Hero tones, with and without a focal value';
  export const description =
    'A full-bleed hero band in each tone: plain, a tinted indigo wash, a saturated indigo gradient and a near-black night band. It looks finished without media; art adds one faint glyph, and a focal value replaces it.';
</script>

<script lang="ts">
  import { Button, KeyFacts, Meter, PageHeader } from '@lostgradient/cinder';
  import Martini from '@lucide/svelte/icons/martini';

  const tones = ['plain', 'tint', 'accent', 'night'] as const;
</script>

<div style="display: grid; gap: 1.5rem;">
  {#each tones as tone (tone)}
    <PageHeader
      headingLevel={2}
      variant="hero"
      {tone}
      eyebrow="Denver"
      title="Poor Decisions"
      titleSoft=", made easier"
      description="Happy hours near you, open right now."
    >
      {#snippet facts()}
        <KeyFacts items={[{ value: 'LoDo' }, { value: '14 open now' }, { value: 'Until 7 PM' }]} />
      {/snippet}
      {#snippet actions()}
        <Button variant="primary">Find a spot</Button>
        <Button>See the map</Button>
      {/snippet}
      {#snippet art()}<Martini aria-hidden="true" />{/snippet}
    </PageHeader>

    <PageHeader
      headingLevel={2}
      variant="hero"
      {tone}
      eyebrow="Run 4471"
      title="Refund order 4471"
      description="Waiting on your approval to issue the refund."
    >
      {#snippet decisions()}
        <Button variant="primary">Approve</Button>
        <Button>Deny</Button>
      {/snippet}
      {#snippet focal()}
        <span>$84.20</span>
        <small>Refund amount</small>
        <Meter value={62} ariaLabel="Share of the order refunded" />
      {/snippet}
    </PageHeader>
  {/each}
</div>
