import '../button/button.css';
import '../confirm-dialog/confirm-dialog.css';
import '../modal/modal.css';
import ModalRegion from './modal-region.svelte';
export default ModalRegion;
export { useModal } from '@lostgradient/foundation/utilities/use-modal.ts';
export type {
  ModalApi,
  ModalContentControls,
  OpenModalOptions,
} from '@lostgradient/foundation/utilities/use-modal.ts';
export type { ModalRegionProps } from './modal-region.types.ts';
export { ModalRegion };
