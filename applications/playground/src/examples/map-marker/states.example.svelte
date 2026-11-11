<script lang="ts" module>
  export const title = 'Live, idle, selected and cluster';
  export const description =
    'Idle shows its start time, live is a filled pill with a dot, selected is raised with a ring, and a cluster is a round count. Each is at least 44px.';
</script>

<script lang="ts">
  import { MapMarker } from '@lostgradient/cinder';
</script>

<div style="display: flex; gap: 1rem; align-items: flex-end;">
  <MapMarker state="live" label="Live" name="Union Station Bar, happy hour live" />
  <MapMarker state="idle" label="8 pm" name="Larimer Taproom, happy hour starts 8 pm" />
  <MapMarker state="selected" label="6 pm" name="Ginger Bar, happy hour starts 6 pm" />
  <MapMarker state="cluster" label="12" name="12 places" />
</div>
