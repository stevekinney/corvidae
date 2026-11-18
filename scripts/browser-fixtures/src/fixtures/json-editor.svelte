<script lang="ts">
  import { FormSection, JsonEditor, Tabs } from '@lostgradient/cinder';

  let value = $state('{\n  "region": "us-west-2",\n  "dryRun": true\n}');

  // COR-2432, row 66f: the editor mounted as the workflow builder mounts it, drawn only behind a
  // query parameter so the default fixture, its baselines and its axe sweep stay as they are: a
  // Builder and a JSON tab (`?builder=json` opens on JSON, `?builder=builder` on Builder), the
  // 18-row editor under its label and description, and a file whose comma is missing at the end
  // of line 11 with the parser stopping at line 12, as Order refund's is.
  const builder = new URLSearchParams(globalThis.location.search).get('builder');
  let tab = $state<string>(builder === 'builder' ? 'builder' : 'json');
  let text = $state(`{
  "name": "order-refund",
  "description": "Looks up an order, waits for a person to approve, then issues the refund.",
  "trigger": { "kind": "schedule", "name": "Weekly refund audit", "spec": "0 11 * * 1", "timezone": "America/Chicago" },
  "steps": [
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "tool-runner",
        "message": "Look up the order and propose a refund." } },
    { "kind": "await-signal", "signal": "approval", "review": true },
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "tool-runner"
        "message": "Issue the approved refund." } }
  ]
}
`);
</script>

{#if builder === null}
  <JsonEditor
    id="payload"
    label="Request payload"
    description="Enter the JSON body sent with the request."
    {value}
    onValueChange={(nextValue) => (value = nextValue)}
  />
{:else}
  <div id="example-mount-builder" class="fixture-builder">
    <Tabs bind:value={tab}>
      <Tabs.List label="How to edit the workflow">
        <Tabs.Trigger value="builder">Builder</Tabs.Trigger>
        <Tabs.Trigger value="json">JSON</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel value="builder">
        <FormSection heading="Steps">
          <p>The steps of the workflow.</p>
        </FormSection>
      </Tabs.Panel>
      <Tabs.Panel value="json">
        <div class="fixture-builder__json">
          <JsonEditor
            id="workflow-editor-text"
            label="Workflow file"
            description="Every field the builder writes is here, including the schedule trigger, each title and the Input and Output schemas."
            rows={18}
            value={text}
            invalidStatusLabel="Invalid JSON"
            parserStopVisible
            onValueChange={(next) => (text = next)}
          />
        </div>
      </Tabs.Panel>
    </Tabs>
  </div>
{/if}

<style>
  .fixture-builder {
    max-inline-size: 45rem;
    margin-block-start: 15rem;
  }
</style>
