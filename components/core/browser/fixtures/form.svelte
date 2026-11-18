<script lang="ts">
  import { Button, Form, Input } from '@lostgradient/cinder';
</script>

<Form onSubmit={() => undefined}>
  {#snippet children({ submitting })}
    <Input id="form-name" label="Name" value="Ada Lovelace" disabled={submitting} />
    <Button type="submit" disabled={submitting}>Save</Button>
  {/snippet}
</Form>
