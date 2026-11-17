import DropdownGroup from '@lostgradient/dropdown/components/dropdown-group/dropdown-group.svelte';
import DropdownItem from '@lostgradient/dropdown/components/dropdown-item/dropdown-item.svelte';
import DropdownLabel from '@lostgradient/dropdown/components/dropdown-label/dropdown-label.svelte';
import DropdownMenu from '@lostgradient/dropdown/components/dropdown-menu/dropdown-menu.svelte';
import DropdownSeparator from '@lostgradient/dropdown/components/dropdown-separator/dropdown-separator.svelte';
import ContextMenuTrigger from '../context-menu-trigger/context-menu-trigger.svelte';
import './context-menu.css';
import ContextMenuRoot from './context-menu.svelte';

const ContextMenu = Object.assign(ContextMenuRoot, {
  Trigger: ContextMenuTrigger,
  Menu: DropdownMenu,
  Item: DropdownItem,
  Label: DropdownLabel,
  Separator: DropdownSeparator,
  Group: DropdownGroup,
});

export default ContextMenu;
export type { ContextMenuProps } from './context-menu.types.ts';
export { ContextMenu };
