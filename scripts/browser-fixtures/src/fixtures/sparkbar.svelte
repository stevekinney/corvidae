<script lang="ts">
  import { Sparkbar } from '@lostgradient/cinder';
</script>

<div class="example-frame gap-3">
  <Sparkbar value={0.31} label="Draft weekly changelog" trailing="$0.31" />
  <Sparkbar value={0.64} label="Summarize review comments" trailing="$0.64" variant="success" />
  <Sparkbar value={0.88} label="Refresh screenshot gallery" trailing="$0.88" variant="warning" />
</div>

<style>
  .example-frame {
    display: grid;
    max-width: 28rem;
  }
</style>
