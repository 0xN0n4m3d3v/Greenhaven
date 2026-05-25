// U-1 — ambient-audio bridge. `useAmbientBed` calls this helper
// instead of `fetch(...)`'ing `/api/audio/bed/:slug` directly so
// the hook stays platform-agnostic and the optional-failure
// behavior (badge stays silent on miss) is preserved.

export interface AmbientBedConfig {
  drone_url: string | null;
  room_tone_url: string | null;
  foley_pool: Array<{url: string; p: number}>;
  sting_pool: Array<{url: string; p: number}>;
  cross_fade_ms: number;
}

function normalizeBedConfig(value: unknown): AmbientBedConfig | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<AmbientBedConfig>;
  return {
    drone_url: typeof raw.drone_url === 'string' ? raw.drone_url : null,
    room_tone_url:
      typeof raw.room_tone_url === 'string' ? raw.room_tone_url : null,
    foley_pool: Array.isArray(raw.foley_pool) ? raw.foley_pool : [],
    sting_pool: Array.isArray(raw.sting_pool) ? raw.sting_pool : [],
    cross_fade_ms:
      typeof raw.cross_fade_ms === 'number' &&
      Number.isFinite(raw.cross_fade_ms) &&
      raw.cross_fade_ms >= 0
        ? raw.cross_fade_ms
        : 1500,
  };
}

/**
 * Returns the normalised bed config for `slug`, or `null` if the
 * endpoint refused or threw. The caller is responsible for the
 * Howler cross-fade orchestration.
 */
export async function fetchBedConfig(args: {
  slug: string;
}): Promise<AmbientBedConfig | null> {
  let response: Response;
  try {
    response = await fetch(
      `/api/audio/bed/${encodeURIComponent(args.slug)}`,
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return normalizeBedConfig(await response.json());
}
