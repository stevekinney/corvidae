<script lang="ts">
  import { Spectrogram } from '@repo/cinder';
</script>

<Spectrogram label="Voice spectrogram" frames={[]} height={220}>
  {#snippet empty()}
    No audio analyzed yet.
  {/snippet}
</Spectrogram>
