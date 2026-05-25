import type {DirectorBrief} from './combatDirectorTypes.js';

/**
 * Build the <combat_briefing> XML block that goes into broker's user message.
 * Broker prompt knows to consume this tag verbatim.
 */
export function formatBrokerBriefing(b: DirectorBrief): string {
  const conditions = b.conditions ?? [];
  const cond =
    conditions.length === 0
      ? '(none)'
      : conditions
          .map(
            c =>
              `${c.target} <- ${c.tag}(severity=${c.severity}, duration=${c.duration_turns})`,
          )
          .join('; ');
  const memBlock =
    b.memory_canon.length === 0
      ? '  (none - director judged sub-threshold; broker may add memory if narrative warrants)'
      : b.memory_canon
          .map(
            m =>
              `  - owner="${m.owner}" about="${m.about}" importance=${m.importance} text="${m.text}" tags=${JSON.stringify(m.tags)}`,
          )
          .join('\n');

  return `<combat_briefing>
roll_plan: ${b.roll_plan.skip_attack_roll ? 'SKIP_ATTACK_ROLL' : 'ROLL_ATTACK'} - ${b.roll_plan.reason}
damage: target="${b.damage_plan.target}" amount=${b.damage_plan.amount}${b.damage_plan.type ? ` type=${b.damage_plan.type}` : ''}${b.damage_plan.source ? ` source="${b.damage_plan.source}"` : ''}
source_policy: source is already grounded by inventory/environment. Broker must not narrate a different weapon or prop.
position: ${b.position}
effect: ${b.effect}
conditions: ${cond}
memory_canon (call add_memory for EACH after damage lands):
${memBlock}

USE THESE VALUES VERBATIM. Do not re-derive damage, position/effect, or memory text.
</combat_briefing>`;
}
