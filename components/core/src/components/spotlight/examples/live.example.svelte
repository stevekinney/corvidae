<script lang="ts" module>
  export const title = 'Liveness as a status dot';
  export const description =
    'Liveness is a status dot and word above the value, so the value itself stays neutral.';
</script>

<script lang="ts">
  import { Spotlight } from '@lostgradient/cinder';
</script>

<Spotlight value="2 need you" status="online" statusLabel="Live" />
