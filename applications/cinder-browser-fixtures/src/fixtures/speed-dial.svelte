<script lang="ts">
  import { SpeedDial } from '@repo/cinder';
  let lastAction = $state('None');
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-overview-preview-rendered="">
    <div style="min-height: 12rem; display: grid; place-items: center;">
      <SpeedDial aria-label="Quick actions">
        {#snippet trigger()}<span aria-hidden="true">+</span>{/snippet}
        <SpeedDial.Action label="Create" onclick={() => (lastAction = 'Create')}
          >{#snippet icon()}C{/snippet}</SpeedDial.Action
        >
        <SpeedDial.Action label="Share" onclick={() => (lastAction = 'Share')}
          >{#snippet icon()}S{/snippet}</SpeedDial.Action
        >
        <SpeedDial.Action label="Archive" disabled>{#snippet icon()}A{/snippet}</SpeedDial.Action>
      </SpeedDial>
    </div>
  </div>
</section>
<p>Last action: {lastAction}</p>
