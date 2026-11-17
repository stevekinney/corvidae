import './virtual-list.css';
import VirtualList from './virtual-list.svelte';

export default VirtualList;
export {
  getFixedVirtualWindow,
  parsePixelLength,
  resolveVirtualItemHeight,
  resolveVirtualOverscan,
} from '@lostgradient/foundation/utilities/fixed-virtual-window.ts';
export type {
  FixedVirtualWindow,
  FixedVirtualWindowItem,
} from '@lostgradient/foundation/utilities/fixed-virtual-window.ts';
export type {
  VirtualListProps,
  VirtualListRef,
  VirtualListRowContext,
  VirtualListScrollAlign,
  VirtualListScrollToIndexOptions,
} from './virtual-list.types.ts';
export { VirtualList };
