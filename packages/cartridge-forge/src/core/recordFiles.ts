import type {EntityKind} from './types.js';

const RECORD_FILES: Record<EntityKind, string> = {
  activity: 'activities.jsonl',
  dialogue: 'dialogues.jsonl',
  event: 'events.jsonl',
  faction: 'factions.jsonl',
  item: 'items.jsonl',
  location: 'locations.jsonl',
  person: 'npcs.jsonl',
  quest: 'quests.jsonl',
  relationship: 'relationships.jsonl',
  scene: 'scenes.jsonl',
  world_fact: 'world-facts.jsonl',
};

export function recordFileName(kind: EntityKind): string {
  return RECORD_FILES[kind];
}
