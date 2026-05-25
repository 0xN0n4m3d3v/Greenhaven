export interface InspirationalQuotePayload {
  id: number;
  text_key: string;
  text: string;
  attribution: string | null;
  scene_tags: string[];
  weight: number;
  language: string;
}

export async function loadInspirationalQuote(
  language: string,
  sceneTags: string[] = [],
  signal?: AbortSignal,
): Promise<InspirationalQuotePayload | null> {
  const params = new URLSearchParams();
  params.set('language', language || 'en');
  if (sceneTags.length > 0) params.set('tags', sceneTags.join(','));
  const response = await fetch(`/api/quotes/inspirational?${params}`, {
    credentials: 'include',
    signal,
  });
  if (!response.ok) {
    throw new Error(`loadInspirationalQuote failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    quote?: InspirationalQuotePayload | null;
  };
  return payload.quote ?? null;
}
