import { fireEvent, type render } from '@testing-library/svelte';

export async function approveRefund(findByRole: ReturnType<typeof render>['findByRole']) {
  await fireEvent.click(await findByRole('button', { name: 'Approve' }));
  await fireEvent.click(await findByRole('button', { name: 'Press again to approve' }));
}
