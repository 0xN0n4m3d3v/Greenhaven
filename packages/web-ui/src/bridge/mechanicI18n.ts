// U-1 — mechanic-i18n bridge. `useMechI18n` hook calls this helper
// instead of `fetch(...)`'ing `/api/i18n/mechanic` directly so the
// per-language map can be sourced from the same bridge surface in
// future Wails/native shells.

export async function fetchMechanicI18n(args: {
  language: string;
}): Promise<Record<string, string>> {
  const r = await fetch(
    `/api/i18n/mechanic?lang=${encodeURIComponent(args.language)}`,
  );
  const d = (await r.json()) as {map?: Record<string, string>};
  return d.map ?? {};
}
