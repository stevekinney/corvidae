import type { CatalogHost } from '@lostgradient/backchannel-svelte';
import { createContext } from 'svelte';
import type { ApprovalHost } from './tool-approval-actions.svelte.ts';

export type ReviewsHost = CatalogHost & ApprovalHost;
export const [getReviewsHost, setReviewsHost] = createContext<ReviewsHost>();
