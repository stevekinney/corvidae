import type { CatalogHost } from '@lostgradient/backchannel-svelte';
import { createContext } from 'svelte';
import type { ReviewsOperationTypes } from '../generated/reviews-operations.generated.ts';
import type { ApprovalHost } from './tool-approval-actions.svelte.ts';

export type ReviewsHost = CatalogHost &
  ApprovalHost & {
    readonly opening: ReadonlyMap<string, ReviewsOperationTypes['bureau.reviews.list']['output']>;
  };
export const [getReviewsHost, setReviewsHost] = createContext<ReviewsHost>();
