<script lang="ts">
  import { Select } from '@repo/cinder';

  const options = [
    { value: 'alpha', label: 'Alpha' },
    { value: 'beta', label: 'Beta' },
  ];
</script>

<div id="example-mount-with-error">
  <Select id="invalid-select" label="Environment" {options} error="Choose an environment." />
</div>
