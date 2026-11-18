<script lang="ts">
  import JsonSchema from './schema-form/json-schema.svelte';
  import LongSecret from './schema-form/long-secret.svelte';

  // `?fixture=long-secret` draws a long chosen secret key in a narrow column (R10-13); every other
  // name, `assertion` included, draws the JSON Schema form.
  const fixtureName = new URLSearchParams(window.location.search).get('fixture');
</script>

{#if fixtureName === 'long-secret'}
  <div id="example-mount-long-secret"><LongSecret /></div>
{:else}
  <div id="example-mount-json-schema"><JsonSchema /></div>
{/if}
