<script lang="ts" module>
  export const title = 'Loading: label, width and spinner';
  export const description =
    'Press "Start" to put every button in flight. When the label stays (Save), the width does not move; shorter words (Testing…) keep the width; longer words (Creating…) take the width they need so they never spill over the border. A page that dims the button while it works sets --cinder-button-loading-opacity (Connecting…).';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';

  let inFlight = $state(false);
</script>

<div class="example-preview-column">
  <div class="example-preview-row">
    <Button
      variant="secondary"
      data-testid="loading-toggle"
      label={inFlight ? 'Reset' : 'Start'}
      onclick={() => (inFlight = !inFlight)}
    />
  </div>
  <div class="example-preview-row">
    <Button variant="primary" label="Save" loading={inFlight} loadingStatus="Saving…" />
    <Button variant="primary" size="sm" label="Save" loading={inFlight} loadingStatus="Saving…" />
  </div>
  <div class="example-preview-row">
    <Button
      variant="primary"
      label={inFlight ? 'Creating…' : 'Create'}
      loading={inFlight}
      loadingStatus="Creating…"
    />
  </div>
  <div class="example-preview-row">
    <Button
      variant="secondary"
      label={inFlight ? 'Testing…' : 'Test connection'}
      loading={inFlight}
      loadingStatus="Testing…"
    />
  </div>
  <div class="example-preview-row">
    <Button
      variant="primary"
      label={inFlight ? 'Connecting…' : 'Connect'}
      loading={inFlight}
      loadingStatus="Connecting…"
      style="--cinder-button-loading-opacity: 0.75"
    />
  </div>
</div>
