<script lang="ts" module>
  export const title = 'Model select: loading and error';
  export const description =
    'While models load the trigger shows its placeholder ("Loading models") and does not open. A listbox select takes the same error prop as the native one: red message, aria-invalid and aria-describedby.';
</script>

<script lang="ts">
  import { Select } from '@lostgradient/cinder';

  const models = [
    { value: 'sonnet', label: 'Claude Sonnet 5.5', group: 'anthropic' },
    { value: 'opus', label: 'Claude Opus 5.5', group: 'anthropic' },
  ];
  let loadingValue = $state('');
  let errorValue = $state('');
</script>

<div class="example-preview-column">
  <Select
    id="model-loading"
    label="Model"
    presentation="listbox"
    placeholder="Loading models"
    options={[]}
    bind:value={loadingValue}
  />
  <Select
    id="model-error"
    label="Model"
    presentation="listbox"
    placeholder="Choose a model"
    options={models}
    error="Choose a model before you start."
    bind:value={errorValue}
  />
</div>
