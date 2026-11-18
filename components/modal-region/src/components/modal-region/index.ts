import '@lostgradient/button/button.css';
import '@lostgradient/confirm-dialog/confirm-dialog.css';
import '@lostgradient/modal/modal.css';
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
