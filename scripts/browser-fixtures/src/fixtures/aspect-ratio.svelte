<script lang="ts">
  import { AspectRatio } from '@lostgradient/cinder';
</script>

<AspectRatio>
  <div class="example-frame rounded-medium text-default">16:9</div>
</AspectRatio>

<style>
  .example-frame {
    display: grid;
    place-items: center;
    inline-size: 100%;
    block-size: 100%;
    border: 1px dashed var(--cinder-border-muted);
    background: linear-gradient(
      135deg,
      color-mix(in oklch, var(--cinder-accent-solid), transparent 84%),
      color-mix(in oklch, var(--cinder-status-info-background), transparent 20%)
    );
    font-size: var(--cinder-text-md);
  }
</style>
