<script lang="ts">
  import { AvatarGroup } from '@lostgradient/cinder';

  const avatars = [
    { id: 'ada', name: 'Ada Lovelace' },
    { id: 'grace', name: 'Grace Hopper' },
    { id: 'katherine', name: 'Katherine Johnson' },
  ];
</script>

<div id="example-mount-basic" class="avatar-group-fixture">
  <AvatarGroup {avatars} label="Active collaborators" />
</div>
