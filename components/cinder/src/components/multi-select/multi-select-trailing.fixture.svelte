<script lang="ts">
  import Combobox from '../combobox/combobox.svelte';
  import Select from '../select/select.svelte';
  import MultiSelect from './multi-select.svelte';

  const items = [
    { id: 'design', label: 'Design' },
    { id: 'engineering', label: 'Engineering' },
    { id: 'research', label: 'Research' },
    { id: 'support', label: 'Support' },
  ];
  const options = items.map((item) => ({ value: item.id, label: item.label }));
  const sizes = ['sm', 'md', 'lg'] as const;
  const longPlaceholder =
    'Choose every team that should hear about this release before it ships to customers';
</script>

<!-- The trailing controls of a closed MultiSelect, measured in a browser: the clear x and the
     chevron at every size and in every state, beside the Select and Combobox whose chevron
     the MultiSelect's chevron lines up with. -->
<div class="multi-select-trailing">
  {#each sizes as size (size)}
    <section class="multi-select-trailing__size" data-testid="size-{size}">
      <div data-testid="none">
        <MultiSelect id="trailing-{size}-none" label="None" {items} {size} />
      </div>
      <div data-testid="one">
        <MultiSelect id="trailing-{size}-one" label="One" {items} {size} selectedIds={['design']} />
      </div>
      <div data-testid="many">
        <MultiSelect
          id="trailing-{size}-many"
          label="Many"
          {items}
          {size}
          selectedIds={['design', 'engineering', 'research']}
        />
      </div>
      <div data-testid="select">
        <Select id="trailing-{size}-select" label="Select" {options} {size} value="design" />
      </div>
      <div data-testid="select-listbox">
        <Select
          id="trailing-{size}-select-listbox"
          label="Select listbox"
          {options}
          {size}
          value="design"
          presentation="listbox"
        />
      </div>
      <div data-testid="combobox">
        <Combobox id="trailing-{size}-combobox" label="Combobox" {options} {size} />
      </div>
    </section>
  {/each}

  <section class="multi-select-trailing__states">
    <div class="multi-select-trailing__narrow" data-testid="long">
      <MultiSelect id="trailing-long" label="Long" {items} placeholder={longPlaceholder} />
    </div>
    <div data-testid="disabled">
      <MultiSelect
        id="trailing-disabled"
        label="Disabled"
        {items}
        disabled
        selectedIds={['design', 'support']}
      />
    </div>
    <div data-testid="read-only">
      <MultiSelect
        id="trailing-read-only"
        label="Read-only"
        {items}
        readonly
        selectedIds={['design', 'support']}
      />
    </div>
    <div data-testid="invalid">
      <MultiSelect
        id="trailing-invalid"
        label="Invalid"
        {items}
        error="Choose at least two teams."
        selectedIds={['design']}
      />
    </div>
    <!-- A right-to-left page names its language too. Bun's CSS bundler lowers a logical inset
         (`inset-inline-end`) to `left`/`right` keyed on `:lang()`, so `dir` alone would leave
         every positioned chevron on the right. -->
    <div dir="rtl" lang="ar" data-testid="rtl">
      <MultiSelect id="trailing-rtl" label="RTL" {items} selectedIds={['design', 'research']} />
    </div>
    <div dir="rtl" lang="ar" data-testid="rtl-select">
      <Select id="trailing-rtl-select" label="RTL select" {options} value="design" />
    </div>
  </section>
</div>

<style>
  .multi-select-trailing {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
  }

  .multi-select-trailing__size,
  .multi-select-trailing__states {
    display: grid;
    grid-template-columns: repeat(3, 16rem);
    gap: 1rem;
  }

  .multi-select-trailing__narrow {
    inline-size: 12rem;
  }
</style>
