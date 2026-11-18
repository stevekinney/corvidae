<script lang="ts">
  import { Button, HoverCard } from '@lostgradient/cinder';
  let arrowOpen = $state(false);
  let controlledOpen = $state(false);
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-overview-preview-rendered="">
    <Button onclick={() => (arrowOpen = true)}>Show arrow probe</Button><Button
      onclick={() => (arrowOpen = false)}>Hide arrow probe</Button
    >
    <HoverCard bind:open={arrowOpen} arrowVisible
      >{#snippet trigger()}<Button variant="ghost">Arrow probe</Button>{/snippet}<strong
        >Arrow probe</strong
      >
      <p>Fixed-open panel with its arrow visible for pixel sampling.</p></HoverCard
    >
    <HoverCard
      >{#snippet trigger()}<Button variant="ghost">Ada Lovelace</Button>{/snippet}<strong
        >Ada Lovelace</strong
      >
      <p>Mathematician, writer, and early computing collaborator.</p></HoverCard
    >
    <div id="example-mount-controlled">
      <Button onclick={() => (controlledOpen = true)}>Show</Button><Button
        onclick={() => (controlledOpen = false)}>Hide</Button
      >
      <HoverCard bind:open={controlledOpen}
        >{#snippet trigger()}<Button variant="ghost">CIN-14</Button>{/snippet}<strong>CIN-14</strong
        >
        <p>Track down the intermittent double-submit on the settings form.</p></HoverCard
      >
    </div>
    <div id="example-mount-instant-reopen">
      <HoverCard openDelay={0}
        >{#snippet trigger()}<Button variant="ghost">CIN-99</Button>{/snippet}<strong>CIN-99</strong
        >
        <p>Reopen this card while its exit transition is active.</p></HoverCard
      >
    </div>
  </div>
</section>
