/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — `tools/narrate.ts` is a compatibility barrel. The narrate
// tool body is split into focused modules under `tools/narrate/`:
//   - `sanitiser.ts`    — `sanitiseNarrateText` and analysis-tag
//                         scrubbing pipeline.
//   - `jsonText.ts`     — narrator-emitted JSON wrapper unwrap +
//                         depth-balanced candidate scan.
//   - `controlText.ts`  — `isNarrateControlText` /
//                         `isToolFunctionDumpText` rejection rails.
//   - `schema.ts`       — `NarrateArgs` zod schema.
//   - `directives.ts`   — `# tag: payload` directive parse/emit.
//   - `persistence.ts`  — chat_messages INSERT + memory persistence
//                          (delegates to MemoryService archival).
//   - `dialogueSync.ts` — author/tone/auto-swap/engage/scene-shift.
//   - `sseEmit.ts`      — post-insert SSE surface.
//   - `register.ts`     — `registerTool({name: 'narrate', ...})`.
// Importing this file still triggers narrate registration through
// `tools/index.ts`; the public exports below preserve the ABI for
// callers like `ai/handoff.ts` and `narrationSynthesis.ts`.

import './narrate/register.js';

export {sanitiseNarrateText} from './narrate/sanitiser.js';
export {
  isNarrateControlText,
  isToolFunctionDumpText,
} from './narrate/controlText.js';
