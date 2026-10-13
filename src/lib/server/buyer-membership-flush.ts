import type { SupabaseClient } from '@supabase/supabase-js';

// A buyer who has just been enabled / approved only joins cohort- and campaign-scoped audiences
// when the membership tick (every 15 min) drains their `buyer_candidate` row, so for up to ~15
// minutes they browse at General prices while their campaign (e.g. app-enabled → Error list)
// applies only after. app.flush_buyer_membership drains that ONE buyer synchronously (3s statement
// timeout, single-flight with the tick), so call it right after the enable commits instead of
// waiting for the buyer's next page load.

const MAX_FLUSHES_PER_CALL = 25;
const BUSY_RETRIES = 2;
const BUSY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type MembershipFlushOutcome = 'flushed' | 'none' | 'busy' | 'failed';

export async function flushBuyerMembershipsNow(
  db: SupabaseClient,
  tenantId: string,
  buyerIds: string[],
): Promise<Record<string, MembershipFlushOutcome>> {
  const outcomes: Record<string, MembershipFlushOutcome> = {};

  for (const buyerId of buyerIds.slice(0, MAX_FLUSHES_PER_CALL)) {
    let outcome: MembershipFlushOutcome = 'failed';
    for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
      try {
        const { data, error } = await db
          .schema('app')
          .rpc('flush_buyer_membership', { p_tenant_id: tenantId, p_buyer_id: buyerId });
        if (error) {
          console.error('[buyer-membership-flush] rpc failed', { buyerId, error: error.message });
          outcome = 'failed';
          break;
        }
        outcome = (typeof data === 'string' ? data : 'none') as MembershipFlushOutcome;
      } catch (err) {
        console.error('[buyer-membership-flush] threw', {
          buyerId,
          error: err instanceof Error ? err.message : String(err),
        });
        outcome = 'failed';
        break;
      }
      if (outcome !== 'busy') break;
      await sleep(BUSY_DELAY_MS);
    }
    outcomes[buyerId] = outcome;
  }

  return outcomes;
}
