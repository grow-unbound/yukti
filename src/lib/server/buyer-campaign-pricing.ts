/**
 * Single rule for what counts as a campaign price on a `campaign_items` row, shared by every
 * display surface (catalog browse, PDP, resolve, share link) and by checkout re-pricing so a price
 * a buyer is quoted is the price they are charged. A missing, non-numeric or non-positive
 * `price_override` is "no campaign price" — the buyer's resolved (price list / base) price applies.
 */
export function campaignOverridePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
