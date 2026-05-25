// U-3 — web UI's view of the server `AffordanceAction` contract.
//
// Donor: `packages/web-server/src/affordances.ts::AffordanceAction`.
// Mirrors the server shape so the SSE `affordances:updated` payload
// flows through typed state into `useMentionTargets`,
// `buildMentionTargetsFromAffordances`, and the BubbleMenu without
// re-using `any[]` / `unknown[]`.
//
// ARCH-17 — keep `AffordanceKind` in lockstep with
// `packages/web-server/src/affordances.ts::AffordanceKind`. The SSE
// bus delivers untyped JSON; `isAffordanceAction` keeps using
// `typeof v.kind === 'string'` so an unknown future kind still
// passes through and is rendered with the fallback label rather than
// being silently dropped on the floor.

export type AffordanceKind =
  | 'item-check'
  | 'attack'
  | 'travel'
  | 'string-spend'
  | 'quest-choice'
  | 'inspiration-spend'
  | `social-${string}`;

export interface AffordanceAction {
  id: string;
  /** Entity this action targets — used by the UI to filter the
   *  per-bubble menu to only this entity's affordances. */
  entity_id: number;
  /** Kind of action — drives UI label translation:
   *    'social-<key>'      e.g. 'social-seduce', 'social-persuade'
   *    'item-check'        a generic item interaction (push/drag/light)
   *    'attack'            start combat against an NPC
   *    'travel'            move to a location/district
   *    'string-spend'      spend a String on an NPC
   *    'quest-choice'      branch a quest pending an awaiting_choice
   *    'inspiration-spend' spend Inspiration for the next exchange */
  kind: AffordanceKind;
  /** Ability score involved, if any (STR/DEX/CON/INT/WIS/CHA). */
  ability?: string;
  /** Display hint. UI derives localized labels from kind/label_key
   *  and uses this mostly to recover @mention names. */
  label: string;
  /** Optional protocol payload for non-prose actions. Player-facing
   *  quick actions must use message_key/message_vars instead. */
  message?: string;
  label_key?: string;
  label_vars?: Record<string, string | number>;
  message_key?: string;
  message_vars?: Record<string, string | number>;
  primary: boolean;
  dice_check?: {dc: number; description: string};
  /** Cartridge-authored verb for item-check actions; UI's localizer
   *  uses this when translating item-check labels. */
  action_verb?: string;
}

/** Minimum-viable shape check for `affordances:updated` SSE payloads.
 *  The server contract is the source of truth, but the bus is untyped
 *  at the boundary so we filter out anything that can't be rendered
 *  by `BubbleMenu` / `buildMentionTargetsFromAffordances`. */
export function isAffordanceAction(value: unknown): value is AffordanceAction {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.entity_id === 'number' &&
    typeof v.kind === 'string' &&
    typeof v.label === 'string' &&
    typeof v.primary === 'boolean'
  );
}
