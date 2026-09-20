# PolicyLock

PolicyLock explains why a setting is managed, names the policy source when available, and displays the policy scope as a Badge. Use it with SettingRow when a setting is visible but not locally editable.

## Usage

```svelte
<script lang="ts">
  import { PolicyLock } from '@corvidae/cinder';
</script>

<PolicyLock id="retention-policy" reason="Managed by your organization" source="Security policy" />
```

`reason` is the required explanation; `source` and `scope` add context when the host can name the policy that applies. PolicyLock is explanatory UI, not an authorization check and not a disabled form control. Pair it with [`SettingRow`](../setting-row/README.md), keep the setting visible, and let the host decide whether a request-access or retry action is available.
