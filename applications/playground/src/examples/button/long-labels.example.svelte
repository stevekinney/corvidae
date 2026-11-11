<script lang="ts" module>
  export const title = 'Long labels and the preview row';
  export const description =
    'A label is a short verb phrase. A proposal the person should read sits beside the button, and a label too long for its container truncates with an ellipsis while the full words stay the accessible name.';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';
</script>

<div class="example-preview-column">
  <div class="long-labels-preview-row">
    <p class="long-labels-preview">Move the weekly review to Friday afternoon at four</p>
    <Button variant="primary" label="Apply" />
  </div>
  <div class="long-labels-narrow">
    <Button label="Move the weekly review to Friday afternoon at four" />
  </div>
</div>

<style>
  .long-labels-preview-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-inline-size: 28rem;
  }

  .long-labels-preview {
    flex: 1;
    min-inline-size: 0;
    margin: 0;
  }

  .long-labels-narrow {
    inline-size: 10rem;
  }
</style>
