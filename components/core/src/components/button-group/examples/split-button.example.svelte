<script lang="ts" module>
  export const title = 'Split button composition';
  export const description =
    'An action button paired with a dropdown for related secondary actions. The trigger takes the variant and size of the Button beside it, so the two halves read as one control with one seam.';
</script>

<script lang="ts">
  import {
    Button,
    ButtonGroup,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
  } from '@lostgradient/cinder';
</script>

<ButtonGroup label="Save options">
  <Button>Save</Button>
  <Dropdown id="save-options">
    <DropdownTrigger aria-label="More save options" />
    <DropdownMenu>
      <DropdownItem>Save as draft</DropdownItem>
      <DropdownItem>Save and publish</DropdownItem>
      <DropdownItem variant="danger">Discard changes</DropdownItem>
    </DropdownMenu>
  </Dropdown>
</ButtonGroup>
