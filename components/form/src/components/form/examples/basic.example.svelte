<script lang="ts" module>
  export const title = 'Basic form';
  export const description = 'Native form submission with Cinder controls.';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/button';
  import { Form } from '@lostgradient/form';
  import { Input } from '@lostgradient/input';
</script>

<Form onSubmit={() => undefined}>
  {#snippet children({ submitting })}
    <Input id="form-name" label="Name" value="" disabled={submitting}>
      {#snippet leading()}{/snippet}
      {#snippet trailing()}{/snippet}
    </Input>
    <Button type="submit" disabled={submitting}>Save</Button>
  {/snippet}
</Form>
