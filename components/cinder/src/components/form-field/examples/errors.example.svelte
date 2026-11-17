<script lang="ts" module>
  export const title = 'Error with an action, and a trailing Try again';
  export const description =
    'The error is the field’s own: a danger ring, a glyph and the message directly under the control. errorAction adds a link after the message in the accent colour (Open GitHub, with the circle glyph for a conflict), and trailing puts a button beside the field (Try again after a failed test).';
</script>

<script lang="ts">
  import { Button, FormField, Input } from '@lostgradient/cinder';

  const uid = $props.id();
  let connected = $state('https://github.example/mcp');
  let unreachable = $state('https://tools.example/mcp');
  let spec = $state('https://api.example/openapi.json');
</script>

<div style="display: grid; gap: 1.25rem; max-inline-size: 30rem;">
  <FormField
    id={`${uid}-connected`}
    label="Server URL"
    error="This URL is already connected as GitHub."
    errorGlyph="error"
  >
    {#snippet errorAction()}<a href="#github">Open GitHub</a>{/snippet}
    <Input id={`${uid}-connected`} bind:value={connected} />
  </FormField>
  <FormField
    id={`${uid}-unreachable`}
    label="Server URL"
    error="Couldn't reach the server. It didn't answer; check the address, and that the server is running."
  >
    {#snippet trailing()}<Button variant="secondary">Try again</Button>{/snippet}
    <Input id={`${uid}-unreachable`} bind:value={unreachable} />
  </FormField>
  <FormField
    id={`${uid}-spec`}
    label="Spec address"
    error="Couldn't fetch the spec. The address answered 404. Check it, or upload the file instead."
  >
    {#snippet trailing()}<Button variant="secondary">Try again</Button>{/snippet}
    <Input id={`${uid}-spec`} bind:value={spec} />
  </FormField>
</div>
