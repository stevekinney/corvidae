<script lang="ts" module>
  export const title = 'Key with the default attribution';
  export const description =
    "Each state is drawn in its marker's shape. The OpenStreetMap and ODbL credit is always rendered under the key.";
</script>

<script lang="ts">
  import { MapLegend } from '@lostgradient/cinder';
</script>

<MapLegend
  label="Map key"
  items={[
    { state: 'live', label: 'Happy hour now' },
    { state: 'idle', label: 'Starts later' },
    { state: 'selected', label: 'Selected' },
    { state: 'cluster', label: 'Several places' },
  ]}
/>
