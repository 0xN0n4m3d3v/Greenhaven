// U-1 — currency-glance bridge. CurrencyBadge calls this helper
// instead of `fetch(...)` so the rail stays platform-agnostic and
// the abort behavior (component unmount → cancel) survives moves
// between web and native shells.

interface CurrencyResponse {
  playerId: number;
  count: number;
}

/**
 * Returns the current player currency balance, or `null` when the
 * endpoint refuses (`!response.ok`) or returns a non-numeric count.
 * Throws only on AbortSignal cancellation so the caller can keep
 * the existing optional-failure semantics (badge hides itself).
 */
export async function fetchPlayerCurrency(args: {
  playerId: number;
  signal?: AbortSignal;
}): Promise<number | null> {
  const r = await fetch(`/api/player/currency?playerId=${args.playerId}`, {
    credentials: 'include',
    signal: args.signal,
  });
  if (!r.ok) return null;
  const data = (await r.json()) as CurrencyResponse;
  return typeof data.count === 'number' ? data.count : null;
}
