import type {CoordinatorBrief} from './intimacyCoordinatorTypes.js';

/**
 * Build the <intimacy_briefing> XML block that goes into broker's
 * user message. Broker prompt knows to consume this tag verbatim.
 */
export function formatBrokerBriefing(b: CoordinatorBrief): string {
  const cartridgeRef = b.cartridge_quest_name
    ? ` (use existing: "${b.cartridge_quest_name}")`
    : '';
  const handoff = b.handoff_recommend
    ? 'YES - hand off to narrator stage for prose'
    : 'NO - synth-render the prose in broker';
  const toolBlock =
    b.tool_plan.length === 0
      ? '  (none - phase=skip; broker may emit one narrate, no state mutation)'
      : b.tool_plan
          .map((t, i) => `  ${i + 1}. ${t.name}(${JSON.stringify(t.args)})`)
          .join('\n');
  const memBlock =
    b.memory_canon.length === 0
      ? '  (none for this beat)'
      : b.memory_canon
          .map(
            m =>
              `  - owner="${m.owner}" about="${m.about ?? 'null'}" importance=${m.importance} text="${m.text}" tags=${JSON.stringify(m.tags)}`,
          )
          .join('\n');

  return `<intimacy_briefing>
phase: ${b.phase}
quest_strategy: ${b.quest_strategy}${cartridgeRef}
handoff_recommend: ${handoff}
reason: ${b.reason}
tool_plan (call IN ORDER):
${toolBlock}
source_policy: Coordinator may not spawn new private locations/props. Use only cartridge quests and loaded state; new world facts must go through Situation/Adventure integrity validation.
memory_canon:
${memBlock}

USE THESE VALUES VERBATIM. Don't re-derive beat phase. Call the tools in order. Copy memory_canon entries to add_memory byte-for-byte.
</intimacy_briefing>`;
}

export function groundCoordinatorBriefing(
  brief: CoordinatorBrief,
): CoordinatorBrief {
  const memoryCanonKeys = new Set(brief.memory_canon.map(memoryCanonKey));
  return {
    ...brief,
    tool_plan: brief.tool_plan
      .map(tool => {
        if (tool.name !== 'create_quest') return tool;
        const args = {...tool.args};
        if ('spawn_entities' in args) delete args['spawn_entities'];
        return {...tool, args};
      })
      .filter(tool => {
        if (tool.name !== 'add_memory') return true;
        return !memoryCanonKeys.has(memoryToolKey(tool.args));
      }),
  };
}

function memoryCanonKey(memory: CoordinatorBrief['memory_canon'][number]): string {
  return stableMemoryKey(memory.owner, memory.about, memory.text);
}

function memoryToolKey(args: Record<string, unknown>): string {
  return stableMemoryKey(
    args['owner'] as string | number | null | undefined,
    args['about'] as string | number | null | undefined,
    args['text'],
  );
}

function stableMemoryKey(
  owner: string | number | null | undefined,
  about: string | number | null | undefined,
  text: unknown,
): string {
  return JSON.stringify({
    owner: owner ?? null,
    about: about ?? null,
    text: typeof text === 'string' ? text.trim() : '',
  });
}
