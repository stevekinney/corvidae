<script lang="ts" module>
  export const title = 'Ghost variant in a bordered row';
  export const description =
    'variant="ghost" has no border or fill at rest, a neutral tint on hover and while open, the quiet focus ring around the whole control, and keeps its chevron. Inside a bordered container the controls align to the composer’s 10px text inset and read as one surface. At phone width the row wraps, and a control that still does not fit shortens its value with an ellipsis instead of running past the border.';
</script>

<script lang="ts">
  import { Select } from '@lostgradient/cinder';

  const models = [
    { value: 'sonnet', label: 'Claude Sonnet 5.5' },
    { value: 'opus', label: 'Claude Opus 5.5' },
    { value: 'haiku', label: 'Claude Haiku 5.5' },
  ];
  const efforts = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];
  const permissions = [
    { value: 'asks', label: 'On changes asks' },
    { value: 'all', label: 'Allow all' },
  ];

  let model = $state('sonnet');
  let effort = $state('medium');
  let permission = $state('asks');
</script>

<div
  style="display: flex; flex-direction: column; gap: var(--cinder-space-2); padding: var(--cinder-space-2) var(--cinder-pad-control); border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-lg); inline-size: 34rem; max-inline-size: 100%"
>
  <div style="padding-block: var(--cinder-space-2); color: var(--cinder-text-muted)">
    Message the agent…
  </div>
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: var(--cinder-space-1)">
    <Select
      id="ghost-model"
      label="Model"
      labelVisible={false}
      presentation="listbox"
      variant="ghost"
      size="sm"
      valuePrefix="Model"
      options={models}
      bind:value={model}
    />
    <Select
      id="ghost-effort"
      label="Effort"
      labelVisible={false}
      presentation="listbox"
      variant="ghost"
      size="sm"
      valuePrefix="Effort"
      options={efforts}
      bind:value={effort}
    />
    <Select
      id="ghost-permissions"
      label="Permissions"
      labelVisible={false}
      presentation="listbox"
      variant="ghost"
      size="sm"
      options={permissions}
      bind:value={permission}
    />
  </div>
</div>

<div style="margin-block-start: var(--cinder-space-4)">
  <Select
    id="ghost-native"
    label="Native ghost"
    labelVisible={false}
    variant="ghost"
    options={efforts}
    bind:value={effort}
  />
</div>
