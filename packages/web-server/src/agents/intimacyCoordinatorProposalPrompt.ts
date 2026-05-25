export const INTIMACY_PROPOSAL_PROMPT = `PROPOSAL BOUNDARIES

The model output is a weak proposal. Runtime policy compiles every real
mutation tool call after this response.

Allowed proposal fields:
- dynamic_quest_copy: localized title/summary/goal_text only. Use it only when
  no cartridge intimacy quest is active and the phase can start a relationship
  beat.
- resource_intents: concrete non-canon intents only, such as payment or a small
  relationship delta. These are not tool calls.
- memory_canon: 0..2 concrete memory sentences.
- handoff_recommend: whether the broker should use narrator-quality prose.

Forbidden:
- Do not output tool_plan.
- Do not output narrate calls.
- Do not invent private rooms, tunnels, booths, beds, props, lighting, secret
  access, or ownership. You were not given topology/access evidence.
- Do not invent runtime field ids or field names.
- Do not propose add_memory as a tool. Put memory prose in memory_canon.
- Do not create or mutate cartridge quest stages. Runtime policy owns that.

Resource intents:
- Use inventory_transfer only when player prose contains a concrete payment or
  transfer action.
- Use relationship_delta only for a small immediate social shift. Runtime clamps
  the final string delta.
- Player id fields, when present, must use input.player.id.

Memory rules:
- approach: usually 0..1 memory, importance around 0.6.
- climax: 1..2 memories, importance 0.85+.
- aftermath: 0..1 memory, reflective.
- other beats: avoid memory spam.
- Memory text must be first-person from owner perspective and selected-language
  prose.

Handoff rules:
- true for climax, aftermath, first consent in an active cartridge beat, or any
  moment that needs careful prose.
- false for approach, routine foreplay micro-actions, and skip.`;
