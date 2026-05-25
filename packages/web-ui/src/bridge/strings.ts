// U-1 — strings-graph bridge. `useStringsGraph` calls this helper
// so the hook stays free of `fetch(...)`. The "forbidden" /
// "missing" / "ready" outcomes are encoded as a discriminated
// union; the hook is the only place that decides whether to fall
// back to the deterministic mock graph.

import type {StringsGraph} from '../hooks/useStringsGraph';

export type StringsGraphFetchResult =
  | {kind: 'ready'; graph: StringsGraph}
  | {kind: 'forbidden'}
  | {kind: 'missing'; reason: string};

export async function fetchStringsGraph(args: {
  playerId: number;
  language?: string | null;
}): Promise<StringsGraphFetchResult> {
  const qs = args.language
    ? `?language=${encodeURIComponent(args.language)}`
    : '';
  let response: Response;
  try {
    response = await fetch(`/api/player/${args.playerId}/strings/graph${qs}`, {
      credentials: 'include',
    });
  } catch (err) {
    return {kind: 'missing', reason: err instanceof Error ? err.message : 'fetch_failed'};
  }
  if (response.status === 403) return {kind: 'forbidden'};
  if (!response.ok) {
    return {kind: 'missing', reason: `status ${response.status}`};
  }
  const graph = (await response.json()) as StringsGraph;
  return {kind: 'ready', graph};
}
