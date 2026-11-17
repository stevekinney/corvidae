<script lang="ts" module>
  export const title = 'Fit and size';
  export const description =
    'A square avatar-sized image that contains its picture instead of cropping it.';
</script>

<script lang="ts">
  import { Image } from '@lostgradient/cinder';

  const illustrationSource =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='338' viewBox='0 0 600 338'%3E%3Crect width='600' height='338' fill='%23f1f5f9'/%3E%3Cpath d='M0 260 150 120l100 90 90-70 260 198H0Z' fill='%230f172a'/%3E%3C/svg%3E";
</script>

<Image src={illustrationSource} alt="An illustration of mountains" size="avatar" fit="contain" />
