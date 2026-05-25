/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — narrate tool argument schema. Extracted verbatim from the
// original `tools/narrate.ts`. The schema is its own module so the
// register/dialogueSync/persistence files can import the inferred
// `NarrateArgs` type without dragging in zod via narrate's barrel.

import {z} from 'zod';

export const NarrateArgs = z.object({
  text: z.string().min(1),
  /** Hidden developer/system note for post-hoc diagnostics. Never sent to SSE. */
  internal_monologue: z.string().max(4000).optional(),
  /** Who's speaking. Defaults to the active scene narrator if unspecified. */
  author: z.string().optional(),
  /** Tone/mode hint for UI rendering: 'npc' | 'narrator' | 'system'. */
  tone: z.enum(['npc', 'narrator', 'system']).default('narrator'),
  /** Spec 32 — optional mood key matching one of the author NPC's
   *  profile.portrait_set entries (e.g. 'amused', 'angry', 'aroused',
   *  'wounded'). UI Portrait component cross-fades to the matching
   *  variant. Unknown moods fall back to 'default'. */
  mood: z.string().max(40).optional(),
  /** Mark this as the final narration for the turn. */
  done: z.boolean().default(true),
});

// Use `z.input` so the type matches the args object the registered
// `execute` callback sees pre-coercion — defaults still appear
// optional. `registerTool`'s `z.ZodType<TArgs>` typing flattens the
// input/output distinction; matching the input shape lets the
// narrate helpers mutate `args.tone` without strict-null grief.
export type NarrateArgsInput = z.input<typeof NarrateArgs>;
