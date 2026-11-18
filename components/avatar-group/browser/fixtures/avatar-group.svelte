<script lang="ts">
  import { default as AvatarGroup } from '@lostgradient/avatar-group/components/avatar-group/index.ts';

  const avatars = [
    { id: 'ada', name: 'Ada Lovelace' },
    { id: 'grace', name: 'Grace Hopper' },
    { id: 'katherine', name: 'Katherine Johnson' },
  ];
</script>

<div id="example-mount-basic" class="avatar-group-fixture">
  <AvatarGroup {avatars} label="Active collaborators" />
</div>
