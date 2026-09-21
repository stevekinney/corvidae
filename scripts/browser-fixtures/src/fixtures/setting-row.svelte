<script lang="ts">
  import { Input, SettingRow } from '@lostgradient/cinder';
</script>

<SettingRow id="display-name" label="Display name" description="Shown to collaborators.">
  {#snippet control()}
    <Input id="display-name" value="Ada Lovelace" placeholder="Ada Lovelace" />
  {/snippet}
</SettingRow>
