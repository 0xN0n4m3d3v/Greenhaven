import {
  markAdventureReady,
  type AdventureQueueRow,
} from '../runtime/adventureQueue.js';
import {validateAdventureBlueprint} from '../runtime/adventureArbiter.js';
import {
  projectSituationToAdventureBlueprint,
  validateSituationBlueprint,
} from '../runtime/scenarioIntegrityArbiter.js';
import {
  defaultPressureForAdventureKind,
  type SituationBlueprint,
} from '../runtime/situationBlueprint.js';
import {fallbackTextsForMaterializerInput} from '../runtime/adventureFallbackTextSelector.js';
import type {AdventureMaterializerInput} from './types.js';

export async function tryMaterializerFallback(args: {
  queue: AdventureQueueRow;
  input: AdventureMaterializerInput;
  playerId: number;
  reason: string;
  message?: string;
}): Promise<AdventureQueueRow | null> {
  const situation = buildFallbackSituation(args.input, args.reason);
  if (!situation) {
    console.warn(
      `[adventure_materializer] deterministic fallback unavailable for queue=${args.queue.id} reason=${args.reason}`,
    );
    return null;
  }
  const situationVerdict = await validateSituationBlueprint({
    queue: args.queue,
    situation,
    playerId: args.playerId,
  });
  if (!situationVerdict.ok || !situationVerdict.situation) {
    console.warn(
      `[adventure_materializer] deterministic fallback rejected: ${situationVerdict.reason} ${situationVerdict.message ?? ''}`,
    );
    return null;
  }
  const projected = projectSituationToAdventureBlueprint({
    queue: args.queue,
    situation: situationVerdict.situation,
  });
  const verdict = await validateAdventureBlueprint({
    queue: args.queue,
    blueprint: projected,
    playerId: args.playerId,
  });
  if (!verdict.ok || !verdict.blueprint) {
    console.warn(
      `[adventure_materializer] deterministic fallback projection rejected: ${verdict.reason} ${verdict.message ?? ''}`,
    );
    return null;
  }
  const ready = await markAdventureReady(args.queue.id, verdict.blueprint);
  if (ready) {
    console.warn(
      `[adventure_materializer] using deterministic fallback for queue=${args.queue.id} reason=${args.reason}` +
        (args.message ? ` message=${args.message.slice(0, 160)}` : ''),
    );
  }
  return ready;
}

export function buildFallbackSituation(
  input: AdventureMaterializerInput,
  reason = 'materializer_fallback',
): SituationBlueprint | null {
  const fallbackText = fallbackTextsForMaterializerInput(input);
  const location = input.locationContext;
  const pressureType = defaultPressureForAdventureKind(input.queue.adventureKind);
  const activeQuest = selectFallbackBridgeQuest(input);

  // Preferred path: quest-bridge fallback when the adventure kind is a
  // quest_complication or the LLM gave us an empty/invalid blueprint but
  // we have an active bridge-tagged quest to anchor onto. Best continuity
  // because the resulting card folds into an already-pursued goal.
  if (activeQuest && input.queue.adventureKind === 'quest_complication') {
    return buildQuestAnchoredFallback({
      input,
      activeQuest,
      pressureType,
      reason,
      fallbackText,
    });
  }

  // Location path: create only when the current scene has recent narrative,
  // visible exits, reachable nearby entities, relationships, or memories to
  // make the hook concrete. A bare location id is not enough.
  if (input.queue.adventureKind === 'quest_complication') {
    return null;
  }

  if (location?.id != null) {
    return buildLocationAnchoredFallback({
      input,
      location,
      pressureType,
      reason,
      fallbackText,
    });
  }

  // Last resort: no location, no active quest — nothing in-world to anchor
  // to. The card stays dropped, but this case is rare (off-grid scripted
  // intros only).
  return null;
}

function buildQuestAnchoredFallback(args: {
  input: AdventureMaterializerInput;
  activeQuest: NonNullable<ReturnType<typeof selectFallbackBridgeQuest>>;
  pressureType: ReturnType<typeof defaultPressureForAdventureKind>;
  reason: string;
  fallbackText: ReturnType<typeof fallbackTextsForMaterializerInput>;
}): SituationBlueprint {
  const {input, activeQuest, pressureType, reason, fallbackText} = args;
  const location = input.locationContext;
  return {
    schemaVersion: 'situation.blueprint.v1',
    queueId: input.queue.id,
    pressureType,
    proximity: location?.id != null ? 'nearby_visible' : 'offscreen',
    danger: 'safe',
    causeSources: [
      {
        kind: 'quest',
        id: activeQuest.id,
        claim: limitText(fallbackText.questCauseClaim(activeQuest.title), 240),
      },
    ],
    actors: [
      {
        entityId: activeQuest.id,
        role: 'existing quest pressure',
        motive: 'keep the world moving without inventing unsupported private facts',
        knowledgeSource: limitText(
          `Fallback from ${reason}; anchored to existing context.`,
          240,
        ),
      },
    ],
    forbiddenMoves: [
      'Do not grant rewards before player acceptance.',
      'Do not create private access without owner evidence.',
      'Do not contradict active cartridge quests.',
    ],
    projectedHook: {
      title: limitText(activeQuest.title, 120),
      playerFacingHook: limitText(
        activeQuest.summary ?? fallbackText.bridgeGoalText(activeQuest.title),
        900,
      ),
      acceptCondition: fallbackText.acceptCondition,
    },
    questProjection: {
      mode: 'attach_existing',
      existingQuestId: activeQuest.id,
      source: 'player_goal',
      bridgeSummary: limitText(fallbackText.bridgeSummary(activeQuest.title), 240),
      goalText: limitText(fallbackText.bridgeGoalText(activeQuest.title), 600),
      tags: ['situation', 'materializer-fallback'],
    },
  };
}

// Pressures that require >=3 clue carriers in `secrets` per the integrity
// arbiter. Kept in sync with CLUE_REQUIRED_PRESSURES in scenarioIntegrityArbiter.
const CLUE_REQUIRED_PRESSURES_FALLBACK = new Set([
  'exploration_secret',
  'location_discovery',
  'item_trace',
]);

const PRIVATE_ACCESS_POLICIES_FALLBACK = new Set([
  'staff_only',
  'locked',
  'secret',
  'hostile',
]);

type FallbackClueCarrier = {
  carrier: 'npc' | 'item' | 'location' | 'event' | 'memory';
  carrierEntityId?: number;
  displayName: string;
};

type SituationSecret = NonNullable<SituationBlueprint['secrets']>[number];
type SituationClue = SituationSecret['clues'][number];

function buildLocationAnchoredFallback(args: {
  input: AdventureMaterializerInput;
  location: NonNullable<AdventureMaterializerInput['locationContext']>;
  pressureType: ReturnType<typeof defaultPressureForAdventureKind>;
  reason: string;
  fallbackText: ReturnType<typeof fallbackTextsForMaterializerInput>;
}): SituationBlueprint | null {
  const {input, location, pressureType, reason, fallbackText} = args;
  const evidence = collectLocationFallbackEvidence(input, location);
  if (!evidence.hasSceneSignal && !evidence.hasLocalSignal) {
    return null;
  }
  if (
    CLUE_REQUIRED_PRESSURES_FALLBACK.has(pressureType) &&
    evidence.clueCarriers.length < 3
  ) {
    return null;
  }

  const anchorName = location.displayName;
  const title = limitText(
    fallbackText.title(input.queue.adventureKind, anchorName),
    120,
  );

  // Clue-required pressures need at least three clue carriers in `secrets`.
  // Build them from local entities/exits plus recent scene text; the evidence
  // precheck above drops barren scenes before projection.
  // get rejected — caller falls through to drop the card, which is correct
  // for a barren location with no neighbours.
  const secrets: SituationBlueprint['secrets'] = [];
  if (CLUE_REQUIRED_PRESSURES_FALLBACK.has(pressureType)) {
    const clueCarriers = evidence.clueCarriers
      .slice(0, 3)
      .map(carrier => clueForCarrier(carrier, fallbackText));
    if (clueCarriers.length < 3) {
      // Not enough neighbours — pad with the location itself so the count
      // hits 3. Same entity referenced thrice is acceptable to the arbiter
      // (it counts clues, not unique carriers).
      while (clueCarriers.length < 3) {
        clueCarriers.push({
          carrier: 'location',
          carrierEntityId: location.id,
          clueText: limitText(
            fallbackText.locationClueText(anchorName),
            240,
          ),
        });
      }
    }
    secrets.push({
      text: limitText(fallbackText.secretText(anchorName), 500),
      knownByEntityIds: [location.id],
      clues: clueCarriers,
    });
  }

  return {
    schemaVersion: 'situation.blueprint.v1',
    queueId: input.queue.id,
    pressureType,
    proximity: 'nearby_visible',
    danger: 'safe',
    causeSources: [
      {
        kind: 'entity',
        id: location.id,
        claim: limitText(fallbackText.entityCauseClaim(anchorName), 240),
      },
    ],
    actors: [],
    secrets: secrets.length > 0 ? secrets : undefined,
    forbiddenMoves: [
      'Do not grant rewards before player acceptance.',
      'Do not create private access without owner evidence.',
      'Do not introduce new NPCs without explicit player engagement.',
    ],
    projectedHook: {
      title,
      playerFacingHook: limitText(
        fallbackText.genericHook(anchorName),
        900,
      ),
      acceptCondition: fallbackText.acceptCondition,
    },
    questProjection: {
      mode: 'create_new',
      source: 'location_situation',
      // create_new + location_situation requires sourceEntityId per
      // scenarioIntegrityArbiter.validateQuestProjectionIntegrity; the
      // anchor location IS the source.
      sourceEntityId: location.id,
      bridgeSummary: limitText(
        `Location-anchored fallback from ${reason} at ${anchorName}.`,
        240,
      ),
      goalText: limitText(fallbackText.goalText, 600),
      // create_new requires stages; minimum two-stage notice→resolve loop
      // gives the arbiter a valid projection without inventing facts.
      stages: [
        {id: 'notice', title: 'Notice the lead', next_stage: 'resolve'},
        {id: 'resolve', title: 'Resolve the lead'},
      ],
      tags: ['situation', 'materializer-fallback', 'location-anchored'],
    },
  };
}

function collectLocationFallbackEvidence(
  input: AdventureMaterializerInput,
  location: NonNullable<AdventureMaterializerInput['locationContext']>,
): {
  hasSceneSignal: boolean;
  hasLocalSignal: boolean;
  clueCarriers: FallbackClueCarrier[];
} {
  const clueCarriers: FallbackClueCarrier[] = [];
  const seenIds = new Set<number>();
  const addEntityCarrier = (entity: {
    id: number;
    kind: string;
    displayName: string;
    accessPolicy?: string | null;
    hiddenUntilStage?: string | null;
  }) => {
    if (seenIds.has(entity.id)) return;
    seenIds.add(entity.id);
    clueCarriers.push({
      carrier: carrierKindFor(entity.kind),
      carrierEntityId: entity.id,
      displayName: entity.displayName,
    });
  };

  addEntityCarrier(location);

  const visibleExits = location.exits.filter(isVisibleLocalReference);
  for (const exit of visibleExits) addEntityCarrier(exit);

  const reachableNearby = input.nearby.filter(
    entity =>
      entity.id !== location.id &&
      entity.reachable &&
      isVisibleLocalReference(entity),
  );
  for (const entity of reachableNearby) addEntityCarrier(entity);

  const hasSceneSignal = hasMeaningfulSceneSignal(input);
  if (hasSceneSignal) {
    clueCarriers.push({
      carrier: 'memory',
      displayName: 'recent scene',
    });
  }

  return {
    hasSceneSignal,
    hasLocalSignal:
      visibleExits.length > 0 ||
      reachableNearby.length > 0 ||
      input.relationships.length > 0 ||
      input.relevantMemories.length > 0,
    clueCarriers,
  };
}

function clueForCarrier(
  carrier: FallbackClueCarrier,
  fallbackText: ReturnType<typeof fallbackTextsForMaterializerInput>,
): SituationClue {
  const clue: SituationClue = {
    carrier: carrier.carrier,
    clueText: limitText(fallbackText.locationClueText(carrier.displayName), 240),
  };
  if (carrier.carrierEntityId != null) {
    clue.carrierEntityId = carrier.carrierEntityId;
  }
  return clue;
}

function hasMeaningfulSceneSignal(input: AdventureMaterializerInput): boolean {
  const snapshot = input.queue.contextSnapshot;
  const sampledText = [
    input.recentNarrative,
    snapshot['turnTextPreview'],
    snapshot['narrativePreview'],
  ]
    .map(value => (typeof value === 'string' ? value : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sampledText.length >= 16;
}

function isVisibleLocalReference(entity: {
  accessPolicy?: string | null;
  hiddenUntilStage?: string | null;
}): boolean {
  if (entity.hiddenUntilStage) return false;
  if (!entity.accessPolicy) return true;
  return !PRIVATE_ACCESS_POLICIES_FALLBACK.has(entity.accessPolicy);
}

function carrierKindFor(
  entityKind: string,
): 'npc' | 'item' | 'location' | 'event' | 'memory' {
  switch (entityKind) {
    case 'person':
      return 'npc';
    case 'item':
      return 'item';
    case 'event':
      return 'event';
    case 'location':
    case 'scene':
      return 'location';
    default:
      return 'location';
  }
}

function selectFallbackBridgeQuest(
  input: AdventureMaterializerInput,
): AdventureMaterializerInput['activeQuests'][number] | undefined {
  if (input.activeQuests.length === 0) return undefined;
  const candidates = input.activeQuests.filter(quest =>
    !quest.tags.includes('materializer-fallback'),
  );
  if (candidates.length === 0) return undefined;
  if (input.queue.adventureKind === 'quest_complication') {
    return candidates[0];
  }
  if (
    input.queue.adventureKind !== 'hidden_location' &&
    input.queue.adventureKind !== 'exploration_clue'
  ) {
    return undefined;
  }

  const bridgeTags = new Set([
    'adventure',
    'exploration',
    'exploration_secret',
    'hidden_location',
    'location_discovery',
    'situation',
  ]);
  return candidates.find(quest =>
    quest.tags.some(tag => bridgeTags.has(tag)),
  );
}

function limitText(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}
