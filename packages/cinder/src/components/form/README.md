# Form

Form is a thin native form root that exposes asynchronous submission state to its child snippet and ignores duplicate submissions while the current handler is pending.

Use native validation and form controls as usual. The component owns only submit coordination; it does not replace native serialization, validation, or reset behavior.

## Usage

```svelte
<script lang="ts">
  import { Form } from '@repo/cinder';
  import { Input } from '@repo/cinder';
  import { Button } from '@repo/cinder';
</script>

<Form onSubmit={() => undefined}>
  {#snippet children({ submitting })}
    <Input id="form-name" name="name" label="Name" value="" disabled={submitting} />
    <Button type="submit" disabled={submitting}>Save</Button>
  {/snippet}
</Form>
```
