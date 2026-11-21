import { fireEvent } from '@testing-library/svelte';

export async function approveRefund(
  findByRole: (role: string, options: { name: string }) => Promise<HTMLElement>,
): Promise<void> {
  await fireEvent.click(await findByRole('button', { name: 'Approve' }));
  await fireEvent.click(await findByRole('button', { name: 'Press again to approve' }));
}
