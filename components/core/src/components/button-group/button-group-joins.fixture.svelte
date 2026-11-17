<script lang="ts">
  import { Button } from '../button/index.ts';
  import { Dropdown } from '../dropdown/index.ts';
  import { DropdownItem } from '../dropdown-item/index.ts';
  import { DropdownMenu } from '../dropdown-menu/index.ts';
  import { DropdownTrigger } from '../dropdown-trigger/index.ts';
  import { Tooltip } from '../tooltip/index.ts';
  import { ButtonGroup } from './index.ts';
  import type { ButtonVariant } from '../button/button.types.ts';

  // Every join a group draws: horizontal and vertical, two to four members, three variants, a
  // member wrapped in a Tooltip or a Dropdown, a split button, and right to left.
  const variants: ButtonVariant[] = ['secondary', 'primary', 'soft'];
  const counts = [2, 3, 4];
  const names = ['Save', 'Duplicate', 'Archive', 'Delete'];
</script>

<div class="button-group-joins">
  {#each variants as variant (variant)}
    {#each counts as count (count)}
      <div data-testid="vertical-{variant}-{count}">
        <ButtonGroup label="Vertical {variant} {count}" orientation="vertical">
          {#each names.slice(0, count) as name (name)}
            <Button {variant}>{name}</Button>
          {/each}
        </ButtonGroup>
      </div>
      <div data-testid="horizontal-{variant}-{count}">
        <ButtonGroup label="Horizontal {variant} {count}">
          {#each names.slice(0, count) as name (name)}
            <Button {variant}>{name}</Button>
          {/each}
        </ButtonGroup>
      </div>
    {/each}
  {/each}

  <div data-testid="vertical-wrapped">
    <ButtonGroup label="Vertical with wrappers" orientation="vertical">
      <Tooltip text="Save the document">
        <Button variant="secondary">Save</Button>
      </Tooltip>
      <Button variant="secondary">Duplicate</Button>
      <Tooltip text="Archive the document">
        <Button variant="secondary">Archive</Button>
      </Tooltip>
    </ButtonGroup>
  </div>

  <!-- `lang` as well as `dir`: the fixture bundler lowers logical corner radii to physical ones
       keyed on right-to-left languages, so `dir` alone would draw the left-to-right corners. -->
  <div data-testid="horizontal-wrapped" dir="rtl" lang="ar">
    <ButtonGroup label="Right to left with wrappers">
      <Tooltip text="Save the document">
        <Button variant="secondary">Save</Button>
      </Tooltip>
      <Button variant="secondary">Duplicate</Button>
      <Tooltip text="Archive the document">
        <Button variant="secondary">Archive</Button>
      </Tooltip>
    </ButtonGroup>
  </div>

  <div data-testid="split-default">
    <ButtonGroup label="Save options">
      <Button>Save</Button>
      <Dropdown id="joins-split-default">
        <DropdownTrigger aria-label="More save options" />
        <DropdownMenu>
          <DropdownItem>Save as draft</DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </ButtonGroup>
  </div>

  <div data-testid="split-primary">
    <ButtonGroup label="Publish options">
      <Button variant="primary" size="sm">Publish</Button>
      <Dropdown id="joins-split-primary">
        <DropdownTrigger aria-label="More publish options" />
        <DropdownMenu>
          <DropdownItem>Schedule</DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </ButtonGroup>
  </div>

  <div data-testid="split-vertical">
    <ButtonGroup label="Vertical split" orientation="vertical">
      <Button variant="secondary">Save</Button>
      <Dropdown id="joins-split-vertical">
        <DropdownTrigger aria-label="More save options">More</DropdownTrigger>
        <DropdownMenu>
          <DropdownItem>Save as draft</DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </ButtonGroup>
  </div>
</div>

<style>
  .button-group-joins {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 1.5rem;
    padding: 1rem;
  }
</style>
