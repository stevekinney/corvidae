<script lang="ts" module>
  export const title = 'Save status, failure and lock';
  export const description =
    'A setting saves when you leave the field and says where it has got to on its own row: Saving, Saved, Applies after restart, Saved waiting for a restart. An invalid value fails at its field and nothing is saved; a failed save keeps the value and offers a quiet Retry; a locked setting says why with a lock glyph. Below a container width the control stacks under the label.';
</script>

<script lang="ts">
  import { DurationField, Input, SettingRow } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: 1rem; max-inline-size: 44rem;">
  <SettingRow
    id="row-idle"
    label="Timeout"
    identifier="example.key"
    description="A value as last saved."
  >
    {#snippet control()}
      <DurationField id="row-idle" value={30_000} unit="s" unitSelectable={false} />
    {/snippet}
  </SettingRow>
  <SettingRow
    id="row-saving"
    label="Workflow claim renew interval"
    identifier="engine.workflowClaimRenewInterval"
    description="How often a worker renews its claim on a running workflow."
    status="saving"
  >
    {#snippet control()}
      <DurationField id="row-saving" value={45_000} unit="s" unitSelectable={false} />
    {/snippet}
  </SettingRow>
  <SettingRow
    id="row-saved"
    label="Timeout"
    identifier="example.key"
    description="Saved when you left the field."
    status="saved"
  >
    {#snippet control()}
      <DurationField id="row-saved" value={45_000} unit="s" unitSelectable={false} />
    {/snippet}
  </SettingRow>
  <SettingRow
    id="row-restart"
    label="Max concurrent runs"
    identifier="engine.maxConcurrentRuns"
    description="The most workflow runs that execute at the same time. Static until you change it."
    status="restart"
  >
    {#snippet control()}<Input id="row-restart" value="4" />{/snippet}
  </SettingRow>
  <SettingRow
    id="row-saved-restart"
    label="Max concurrent runs"
    identifier="engine.maxConcurrentRuns"
    description="Saved, and not in effect until the host restarts."
    status="saved-restart"
  >
    {#snippet control()}<Input id="row-saved-restart" value="4" />{/snippet}
  </SettingRow>
  <SettingRow
    id="row-invalid"
    label="Delete after"
    identifier="retention.runs"
    description="How long finished runs are kept."
    error="Enter a number from 1 to 3650. Nothing was saved."
  >
    {#snippet control()}<Input id="row-invalid" value="9999" />{/snippet}
  </SettingRow>
  <SettingRow
    id="row-failed"
    label="Timeout"
    identifier="example.key"
    description="The change was typed and the field left, but the save didn’t go through."
    error="Couldn’t save. Your value is still in the field."
    onRetry={() => undefined}
  >
    {#snippet control()}<Input id="row-failed" value="45" />{/snippet}
  </SettingRow>
  <SettingRow
    id="row-locked"
    label="Storage backend"
    identifier="storage.backend"
    managed={{
      message:
        'Locked by your deployment (remote mode). Change it in the deployment’s configuration.',
    }}
  >
    {#snippet control()}<Input id="row-locked" value="Postgres" readonly />{/snippet}
  </SettingRow>
</div>
