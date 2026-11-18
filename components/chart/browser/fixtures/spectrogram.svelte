<script lang="ts">
  import { default as Spectrogram } from '@lostgradient/chart/components/spectrogram/index.ts';
</script>

<Spectrogram label="Voice spectrogram" frames={[]} height={220}>
  {#snippet empty()}
    No audio analyzed yet.
  {/snippet}
</Spectrogram>
