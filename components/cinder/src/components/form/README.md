# Form

Form is a thin native form root that exposes asynchronous submission state to its child snippet and ignores duplicate submissions while the current handler is pending.

Use native validation and form controls as usual. The component owns only submit coordination; it does not replace native serialization, validation, or reset behavior.

## Usage

```svelte
<script lang="ts">
  import { Form } from '@corvidae/cinder';
  import { Input } from '@corvidae/cinder';
  import { Button } from '@corvidae/cinder';
</script>

<Form onSubmit={() => undefined}>
  {#snippet children({ submitting })}
    <Input id="form-name" name="name" label="Name" value="" disabled={submitting} />
    <Button type="submit" disabled={submitting}>Save</Button>
  {/snippet}
</Form>
```

`onSubmit` may return a promise. While it is pending, the child snippet receives `{ submitting: true }`; duplicate submits are ignored until the handler settles. Native form serialization, constraint validation, reset behavior, and the submit event remain the browser's responsibility. If the handler rejects, catch it in the host and keep the controls mounted so the user can correct and resubmit.
