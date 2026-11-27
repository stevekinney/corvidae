import * as page from './page-host.ts';
import * as sandbox from './sandbox-host.ts';
export const shared =
  page.createReviewsClientWithTransport === sandbox.createReviewsClientWithTransport &&
  page.useApprovalDecision === sandbox.useApprovalDecision &&
  page.ReviewApprovalButtons === sandbox.ReviewApprovalButtons &&
  page.useToolApprovalActions === sandbox.useToolApprovalActions;
