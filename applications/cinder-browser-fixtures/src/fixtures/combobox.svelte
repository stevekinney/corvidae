<script lang="ts">
  import { Combobox } from '@repo/cinder';
  const fruits = [
    'apple',
    'apricot',
    'banana',
    'blackberry',
    'cherry',
    'grape',
    'mango',
    'peach',
    'pineapple',
    'raspberry',
  ].map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));
  let selected = $state('');
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-example-preview-ready="">
    <Combobox
      id="fruit"
      label="Favorite fruit"
      placeholder="Start typing…"
      options={fruits}
      bind:value={selected}
    />
  </div>
</section>
