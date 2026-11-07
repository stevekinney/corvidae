/**
 * The sentences the showcase host's scripted agents say about a refund and a question, in one
 * place that carries no imports, so the scripts that say them (`showcase-agents.ts`) and the
 * end-to-end captures that read them (`tests/e2e/home.spec.ts`) cannot drift apart.
 *
 * @module showcase-sentences
 */

/** An amount in cents as the sample world words money: dollars and cents, "$42.00". */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What Tool runner says as it asks for a person's approval to refund an order: what it found, and that it needs the approval. */
export function toolRunnerRefundAsk(orderId: string, totalCents: number): string {
  return `I found order ${orderId} (${dollars(totalCents)}). I need your approval to refund it.`;
}

/** What Tool runner says once the person approved the refund and it was issued, which is the last thing a decided refund chat says. */
export function toolRunnerRefundedReply(totalCents: number): string {
  return `You approved it. Refunded ${dollars(totalCents)} to the original payment method.`;
}

/** What Request human input says once the person answered its question with `answer`, which is the last thing an answered question's chat says. */
export function humanInputAnsweredReply(answer: string): string {
  return `You answered ${answer}.`;
}
