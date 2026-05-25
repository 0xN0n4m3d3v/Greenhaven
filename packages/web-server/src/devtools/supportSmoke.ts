/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../tools/index.js';
import { runMigrations } from '../migrate.js';
import { closeDb, query } from '../db.js';
import {
  countAllNpcMemories,
  countNpcMemoriesByExactText,
  countNpcMemoriesForOwnerAboutWithText,
} from '../domain/memory/index.js';
import { clearConfigEnv, rawConfigEnv, setConfigEnv } from '../config.js';
import { buildAffordances, type AffordanceKind } from '../affordances.js';
import {
  BROKER_PROMPT_FRAGMENT_MANIFEST,
  brokerPromptFragmentFilesForMode,
  loadBrokerPromptForMode,
  loadNarratorPrompt,
} from '../ai/prompts.js';
import {
  brokerToolProfileForTurn,
  toolsForBrokerMode,
} from '../ai/toolsets.js';
import {
  catalogueScoutHook,
  extractNewEntities,
} from '../agents/catalogueScout.js';
import {
  agentLanguageName,
  buildAgentLanguageContract,
} from '../agents/agentLanguageContract.js';
import { adventureMaterializerPrompt } from '../domain/adventure/materializer/index.js';
import { groundCombatBriefing } from '../agents/combatDirector.js';
import { combatDirectorPrompt } from '../agents/combatDirectorPrompt.js';
import { dialogueAnchorPrompt } from '../agents/dialogueAnchorPrompt.js';
import { groundCoordinatorBriefing } from '../agents/intimacyCoordinator.js';
import { normalizeCoordinatorBrief } from '../agents/intimacyCoordinatorPolicy.js';
import { intimacyCoordinatorPrompt } from '../agents/intimacyCoordinatorPrompt.js';
import { validateVoiceGrounding } from '../agents/npcVoice.js';
import { npcVoicePrompt } from '../agents/npcVoicePrompt.js';
import { questWatcherPrompt } from '../agents/questWatcherPrompt.js';
import { rewardCalibratorPrompt } from '../agents/rewardCalibratorPrompt.js';
import { questRoutes } from '../routes/quests.js';
import { voiceWardenPrompt } from '../agents/voiceWardenPrompt.js';
import { sanitizeSuggestedSpeakerName } from '../agents/voiceWardenPreTool.js';
import {
  ADVENTURE_MATERIALIZER_SLOT_DEADLINE_MS,
  ADVENTURE_MATERIALIZER_SPECIALIST_TIMEOUT_MS,
  buildFallbackSituation,
  buildMaterializerInput,
} from '../domain/adventure/materializer/index.js';
import { fallbackTextsForMaterializerInput } from '../domain/adventure/index.js';
import { detectScripts } from '../agents/scriptUtil.js';
import { questPacerHook } from '../agents/questPacer.js';
import { applyQuestTransitionProposal } from '../quest/questTransitionArbiter.js';
import { sessionManager, type Session } from '../sessionManager.js';
import { dispatch, getRegisteredTools } from '../tools/index.js';
import { isNarrateControlText, sanitiseNarrateText } from '../tools/narrate.js';
import { decrementConditions, decrementSurfaces } from '../transitionEngine.js';
import { buildTurnContext, renderDialogueState } from '../turnContext/index.js';
import {
  renderActiveQuestsState,
  renderAvailableQuests,
} from '../turnContext/questContext.js';
import { renderNeighbours } from '../turnContext/worldLocationContext.js';
import { loadPresentNpcCandidates } from '../dialogueParticipants.js';
import { evaluateObjective } from '../quest/objectiveEvaluators.js';
import { DYNAMIC_ENTITY_WHERE_SQL, resetWorldState } from '../resetWorld.js';
import { resetSessionState } from '../resetSession.js';
import { maybeScriptAction } from '../scriptedActions.js';
import {
  brokerEmptyFailOpenText,
  friendlyTurnErrorMessage,
  synthesiseNarrate,
} from '../turnRunnerV2.js';
import {maybeAutoEngageDialogue} from '../turn/dialogueAutoEngage.js';
import {
  composePlayerTextForBroker,
  validateProtagonistRenderCandidate,
  type ProtagonistActionRendererOutput,
} from '../agents/protagonistActionRenderer.js';
import { buildSessionTranscriptDiagnostics } from './sessionTranscriptDiagnostics.js';
import { buildTelemetryDeveloperExport } from './telemetryDeveloperExport.js';
import { buildTelemetryBundle } from './telemetryDiagnostics.js';
import {
  applyTelemetryRetention,
  writeTelemetryJsonArtifact,
} from '../telemetryArtifacts.js';
import { validateCartridge } from './validateCartridge.js';
import { runAdventureQueueEndToEndFixture } from './adventureQueueFixture.js';
import { runAdventurePhase2Fixture } from './adventurePhase2Fixture.js';
import {
  closePresentationBarrier,
  currentPresentationBarrier,
  listPostTurnPresentationSlots,
  openPresentationBarrier,
  reservePostTurnPresentationSlots,
  runPostTurnHookWithPresentation,
} from '../presentationScheduler.js';
import {
  cancelQueuedTurn,
  enqueueTurn,
  listTurnQueueSnapshot,
  startNextQueuedTurn,
} from '../turnIngressQueue.js';
import { runOrderedQueueFixture } from './orderedQueueFixture.js';
import {
  listAdventureQueue,
  markAdventureReady,
  maybeEnqueueAdventureOpportunity,
  recoverAbandonedMaterializingAdventures,
  rollAdventureOracle,
  type AdventureQueueRow,
  validateAdventureAcceptFollowupTemplates,
  type AdventureKind,
  type AdventureTableContext,
  ADVENTURE_TABLE_ID,
  applyReadyAdventureBlueprint,
  validateAdventureBlueprint,
  projectSituationToAdventureBlueprint,
  validateSituationBlueprint,
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
  type AdventureBlueprint,
  SITUATION_BLUEPRINT_SCHEMA_VERSION,
  type SituationBlueprint,
} from '../domain/adventure/index.js';
import {
  clearNpcAgencyState,
  evaluateNpcAgency,
} from '../agency/npcAgencyEvaluator.js';
import { telemetryRoutes } from '../routes/telemetry.js';
import { SUPPORTED_LANGUAGE_CODES } from '../languages.js';

export type SupportSmokeStatus = 'pass' | 'fail' | 'skipped';

export interface SupportSmokeCheck {
  name: string;
  status: SupportSmokeStatus;
  details?: unknown;
}

export interface SupportSmokeOptions {
  useExistingDb?: boolean;
  keepTemp?: boolean;
  fixture?: 'normal' | 'broken';
}

export interface SupportSmokeResult {
  ok: boolean;
  checks: SupportSmokeCheck[];
  tempDataDir?: string;
}

interface SupportWorld {
  suffix: string;
  sessionId: string;
  playerId: number;
  locationId: number;
  locationName: string;
  playerName: string;
  npcId: number;
  npcName: string;
  signalFieldId: number;
  surfaceFieldId: number;
  conditionFieldId: number;
  session: Session;
  events: Array<{ event?: string; data?: string; id?: string }>;
  ssePump: Promise<void>;
}

export async function runSupportSmoke(
  options: SupportSmokeOptions = {},
): Promise<SupportSmokeResult> {
  const checks: SupportSmokeCheck[] = [];
  let tempDataDir: string | undefined;

  try {
    if (!options.useExistingDb) {
      clearConfigEnv('DATABASE_URL');
      const base =
        rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
        path.resolve(process.cwd(), '.tmp');
      await mkdir(base, { recursive: true });
      tempDataDir = await mkdtemp(path.join(base, 'greenhaven-support-smoke-'));
      setConfigEnv('PGLITE_DATA_DIR', tempDataDir);
    }

    await runMigrations();
    const world = await seedSupportWorld();

    await runCheck(checks, 'atomic_batch_rollback_db_state', () =>
      checkAtomicBatchRollback(world),
    );
    await runCheck(checks, 'transactional_sse_rollback_buffer', () =>
      checkNoRolledBackSse(world),
    );
    await runCheck(checks, 'successful_batch_post_commit_sse', () =>
      checkSuccessfulBatchSse(world),
    );
    await runCheck(checks, 'gui_event_outbox_ordering', () =>
      checkGuiEventOutboxOrdering(world),
    );
    await runCheck(checks, 'presentation_barrier_blocks_next_turn', () =>
      checkPresentationBarrierBlocks(world),
    );
    await runCheck(checks, 'post_turn_slot_registry_ordering', () =>
      checkPostTurnSlotRegistryOrdering(world),
    );
    await runCheck(checks, 'post_turn_real_quest_pacer_slot', () =>
      checkPostTurnRealQuestPacerSlot(world),
    );
    await runCheck(checks, 'quest_progression_arbiter', () =>
      checkQuestProgressionArbiter(world),
    );
    await runCheck(checks, 'turn_ingress_queue_hidden_until_promoted', () =>
      checkTurnIngressQueue(world),
    );
    await runCheck(checks, 'affordance_language_neutral_contract', () =>
      checkAffordanceLanguageNeutralContract(world),
    );
    await runCheck(checks, 'movement_reachability_contract', () =>
      checkMovementReachabilityContract(world),
    );
    await runCheck(checks, 'quest_spawn_initial_reveal_and_travel_graph', () =>
      checkQuestSpawnInitialRevealAndTravelGraph(world),
    );
    await runCheck(checks, 'ordered_queue_regression', () =>
      runOrderedQueueFixture(world),
    );
    await runCheck(checks, 'adventure_queue_seeded_oracle', () =>
      checkAdventureQueueSeededOracle(world),
    );
    await runCheck(checks, 'adventure_materializer_blueprint', () =>
      checkAdventureMaterializerBlueprint(world),
    );
    await runCheck(checks, 'scenario_integrity_arbiter', () =>
      checkScenarioIntegrityArbiter(world),
    );
    await runCheck(checks, 'adventure_queue_end_to_end', () =>
      runAdventureQueueEndToEndFixture({
        sessionId: world.sessionId,
        playerId: world.playerId,
        locationId: world.locationId,
        ownerId: world.npcId,
        suffix: world.suffix,
        session: world.session,
        events: world.events,
        signal: world.session.activeTurn?.abortController.signal,
      }),
    );
    await runCheck(checks, 'adventure_accept_followup_i18n', async () =>
      validateAdventureAcceptFollowupTemplates(),
    );
    await runCheck(checks, 'adventure_queue_phase_2', () =>
      runAdventurePhase2Fixture({
        sessionId: world.sessionId,
        playerId: world.playerId,
        locationId: world.locationId,
        ownerId: world.npcId,
        suffix: world.suffix,
      }),
    );
    await runCheck(checks, 'successful_batch_child_tool_history', () =>
      checkBatchChildToolHistory(world),
    );
    await runCheck(checks, 'runtime_field_final_sse_contract', () =>
      checkRuntimeFieldEvents(world),
    );
    await runCheck(checks, 'runtime_field_prompt_context_metadata', () =>
      checkRuntimeFieldPromptContext(world),
    );
    await runCheck(checks, 'npc_agency_runtime_hp_contract', () =>
      checkNpcAgencyRuntimeHpContract(world),
    );
    await runCheck(checks, 'catalogue_scout_spawned_map_extraction', () =>
      checkCatalogueScoutExtraction(world),
    );
    await runCheck(checks, 'non_uuid_session_telemetry', () =>
      checkNonUuidTelemetry(world),
    );
    await runCheck(checks, 'frontend_telemetry_ingest', () =>
      checkFrontendTelemetryIngest(world),
    );
    await runCheck(checks, 'desktop_telemetry_ingest', () =>
      checkDesktopTelemetryIngest(world),
    );
    await runCheck(checks, 'telemetry_diagnostic_bundle', () =>
      checkTelemetryDiagnosticBundle(world),
    );
    await runCheck(checks, 'telemetry_retention_and_artifact_files', () =>
      checkTelemetryRetentionFixture(world),
    );
    await runCheck(checks, 'telemetry_developer_export', () =>
      checkTelemetryDeveloperExport(world),
    );
    await runCheck(checks, 'cartridge_validator_fixture_mode', () =>
      checkCartridgeValidator(),
    );
    await runCheck(checks, 'narrator_json_quarantine', () =>
      checkNarratorJsonQuarantine(world),
    );
    await runCheck(checks, 'narrate_quarantine_system_event', () =>
      checkNarrateQuarantineSystemEvent(world),
    );
    await runCheck(checks, 'session_transcript_diagnostics', () =>
      checkSessionTranscriptDiagnostics(world),
    );
    await runCheck(checks, 'multi_npc_dialogue_participants', () =>
      checkMultiNpcDialogueParticipants(world),
    );
    await runCheck(checks, 'protagonist_renderer_validation', () =>
      checkProtagonistRendererValidation(world),
    );
    await runCheck(checks, 'synth_narrate_audit', () =>
      checkSynthNarrateAudit(world),
    );
    await runCheck(checks, 'state_mutation_guardrails', () =>
      checkStateMutationGuardrails(world),
    );
    await runCheck(checks, 'actor_resource_grounding', () =>
      checkActorResourceGrounding(world),
    );
    await runCheck(checks, 'dynamic_item_materialization', () =>
      checkDynamicItemMaterialization(world),
    );
    await runCheck(checks, 'delivery_quest_item_state', () =>
      checkDeliveryQuestItemState(world),
    );
    await runCheck(checks, 'turn_error_text_encoding', () =>
      checkTurnErrorTextEncoding(),
    );
    await runCheck(checks, 'apply_surface_source_grounding', () =>
      checkApplySurfaceSourceGrounding(world),
    );
    await runCheck(checks, 'npc_voice_grounding_guard', () =>
      checkNpcVoiceGroundingGuard(),
    );
    await runCheck(checks, 'voice_warden_candidate_guard', () =>
      checkVoiceWardenCandidateGuard(),
    );
    await runCheck(checks, 'finalization_guardrails', () =>
      checkFinalizationGuardrails(world),
    );
    await runCheck(checks, 'runtime_context_player_scope', () =>
      checkRuntimeContextPlayerScope(world),
    );
    await runCheck(checks, 'cartridge_nested_i18n_runtime', () =>
      checkCartridgeNestedI18nRuntime(world),
    );
    await runCheck(checks, 'session_reset_lifecycle', () =>
      checkSessionResetLifecycle(world),
    );
    await runCheck(checks, 'reset_world_dynamic_cleanup', () =>
      checkResetWorldDynamicCleanup(world),
    );
    await runCheck(checks, 'combat_source_grounding', () =>
      checkCombatSourceGrounding(),
    );
    await runCheck(checks, 'intimacy_spawn_grounding', () =>
      checkIntimacySpawnGrounding(),
    );
    await runCheck(checks, 'agent_selected_language_contracts', () =>
      checkAgentSelectedLanguageContracts(),
    );
    await runCheck(checks, 'broker_prompt_fragment_ownership', () =>
      checkBrokerPromptFragmentOwnership(),
    );
    await runCheck(checks, 'broker_state_recap_profile', () =>
      checkBrokerStateRecapProfile(),
    );
    await runCheck(checks, 'broker_focused_commerce_profiles', () =>
      checkBrokerFocusedCommerceProfiles(),
    );

    if (options.fixture === 'broken') {
      checks.push({
        name: 'broken_fixture_control',
        status: 'fail',
        details: {
          reason: 'intentional failure requested by --fixture broken',
        },
      });
    }

    world.session.sse.closeAll();
    await Promise.race([world.ssePump, sleep(250)]);
  } catch (err) {
    checks.push({
      name: 'support_smoke_setup',
      status: 'fail',
      details: errorDetails(err),
    });
  } finally {
    await sessionManager.destroyAll().catch(() => {});
    await closeDb().catch(() => {});
    if (tempDataDir && !options.keepTemp) {
      await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const failed = checks.some((check) => check.status === 'fail');
  return {
    ok: !failed,
    checks,
    ...(tempDataDir && options.keepTemp ? { tempDataDir } : {}),
  };
}

async function runCheck(
  checks: SupportSmokeCheck[],
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    const details = await fn();
    checks.push({ name, status: 'pass', ...(details ? { details } : {}) });
  } catch (err) {
    checks.push({ name, status: 'fail', details: errorDetails(err) });
  }
}

async function checkTurnErrorTextEncoding(): Promise<unknown> {
  const englishBrokerEmpty = brokerEmptyFailOpenText('en');
  const englishByCase = friendlyErrorSamples('en');
  const checked: string[] = [];
  for (const language of SUPPORTED_LANGUAGE_CODES) {
    const brokerEmpty = brokerEmptyFailOpenText(language);
    assertReadablePlayerText(`${language}.broker_empty`, brokerEmpty);
    if (language !== 'en' && brokerEmpty === englishBrokerEmpty) {
      throw new Error(`${language}.broker_empty fell back to English`);
    }
    checked.push(`${language}.broker_empty`);

    const samples = friendlyErrorSamples(language);
    for (const [key, value] of Object.entries(samples)) {
      assertReadablePlayerText(`${language}.${key}`, value);
      if (language !== 'en' && value === englishByCase[key]) {
        throw new Error(`${language}.${key} fell back to English`);
      }
      checked.push(`${language}.${key}`);
    }
  }

  // The catalog loop at lines 437-453 above already asserts every
  // expected key/value pair on every supported language, so by the
  // time we land here the Russian sample lookup is guaranteed to
  // return strings. The `!` assertions just satisfy
  // `noUncheckedIndexedAccess` without re-deriving the same checks.
  const ruSamples = friendlyErrorSamples('ru');
  const samples = {
    ruBrokerEmpty: brokerEmptyFailOpenText('ru'),
    ruStreamReset: ruSamples.streamReset!,
    ruTimeout: ruSamples.timeout!,
    ruRateLimit: ruSamples.rateLimit!,
    unsupportedFallback: friendlyTurnErrorMessage(
      new Error('timeout'),
      'timeout',
      'xx',
    ),
  };
  assertReadablePlayerText(
    'ruBrokerEmpty',
    samples.ruBrokerEmpty,
    'На мгновение',
  );
  assertReadablePlayerText(
    'ruStreamReset',
    samples.ruStreamReset,
    'Соединение с моделью',
  );
  assertReadablePlayerText('ruTimeout', samples.ruTimeout, 'Модель');
  assertReadablePlayerText('ruRateLimit', samples.ruRateLimit, 'Провайдер');
  assertReadablePlayerText(
    'unsupportedFallback',
    samples.unsupportedFallback,
    'The model',
  );
  return {
    checkedCount: checked.length,
    languages: SUPPORTED_LANGUAGE_CODES,
  };
}

function friendlyErrorSamples(language: string): Record<string, string> {
  return {
    streamReset: friendlyTurnErrorMessage(
      new Error('terminated'),
      'terminated',
      language,
    ),
    aborted: friendlyTurnErrorMessage(
      new Error('aborted'),
      'aborted',
      language,
    ),
    timeout: friendlyTurnErrorMessage(
      new Error('timeout'),
      'timeout',
      language,
    ),
    rateLimit: friendlyTurnErrorMessage(
      new Error('429 rate limit'),
      '429 rate limit',
      language,
    ),
    upstream: friendlyTurnErrorMessage(
      new Error('503 upstream'),
      '503 upstream',
      language,
    ),
  };
}

function assertReadablePlayerText(
  label: string,
  text: string,
  expectedSnippet?: string,
): void {
  if (expectedSnippet && !text.includes(expectedSnippet)) {
    throw new Error(`${label} is missing expected text: ${text}`);
  }
  if (!text.trim()) {
    throw new Error(`${label} is empty`);
  }
  if (/[\u00c2\u00c3\u00d0\u00d1\ufffd]/u.test(text)) {
    throw new Error(`${label} contains mojibake markers: ${text}`);
  }
}

async function checkBrokerPromptFragmentOwnership(): Promise<unknown> {
  const modes = [
    'combat',
    'intimacy',
    'dialogue',
    'exploration',
    'travel',
    'rest',
  ];
  const promptDetails: Record<
    string,
    { files: readonly string[]; chars: number }
  > = {};
  const profileDetails: Record<
    string,
    { files: readonly string[]; chars: number; defaultChars: number }
  > = {};
  const violations: string[] = [];

  const baseFragments =
    BROKER_PROMPT_FRAGMENT_MANIFEST.base as readonly string[];
  if (baseFragments.includes('combat.md')) {
    violations.push('base manifest must not include combat.md');
  }
  if (baseFragments.includes('intimacy.md')) {
    violations.push('base manifest must not include intimacy.md');
  }
  if (baseFragments.includes('performance.md')) {
    violations.push(
      'base manifest must not use broad performance.md; split into owned fragments',
    );
  }
  for (const required of [
    'language.md',
    'voice-authoring.md',
    'player-agency.md',
    'movement.md',
    'companions.md',
    'cartridge-tone.md',
  ]) {
    if (!baseFragments.includes(required)) {
      violations.push(
        `base manifest missing owned shared fragment ${required}`,
      );
    }
  }

  for (const mode of modes) {
    const files = brokerPromptFragmentFilesForMode(mode);
    const duplicates = duplicatePromptFragments(files);
    if (duplicates.length > 0) {
      violations.push(
        `${mode} prompt has duplicate fragments: ${duplicates.join(', ')}`,
      );
    }

    if (mode !== 'combat') {
      for (const forbidden of [
        'combat.md',
        'combat-conditions.md',
        'trauma.md',
      ]) {
        if (files.includes(forbidden)) {
          violations.push(
            `${mode} prompt includes combat-only fragment ${forbidden}`,
          );
        }
      }
    }
    if (mode !== 'intimacy') {
      for (const forbidden of ['intimacy.md', 'sex-moves.md']) {
        if (files.includes(forbidden)) {
          violations.push(
            `${mode} prompt includes intimacy-only fragment ${forbidden}`,
          );
        }
      }
    }
    if (mode === 'combat' && !files.includes('combat.md')) {
      violations.push('combat prompt does not include combat.md');
    }
    if (mode === 'intimacy' && !files.includes('intimacy.md')) {
      violations.push('intimacy prompt does not include intimacy.md');
    }

    const prompt = loadBrokerPromptForMode(mode);
    promptDetails[mode] = { files, chars: prompt.length };
    if (mode !== 'combat' && prompt.includes('## Combat')) {
      violations.push(`${mode} compiled prompt contains Combat section text`);
    }
    if (mode !== 'intimacy' && prompt.includes('## Intimacy')) {
      violations.push(`${mode} compiled prompt contains Intimacy section text`);
    }
    for (const requiredHeading of [
      '## Language',
      '## Voice Authoring',
      '## Player Agency',
      '## Movement',
      '## Companions',
    ]) {
      if (!prompt.includes(requiredHeading)) {
        violations.push(
          `${mode} compiled prompt missing shared heading ${requiredHeading}`,
        );
      }
    }
  }

  for (const mode of ['exploration', 'travel'] as const) {
    const defaultPrompt = loadBrokerPromptForMode(mode);
    for (const profile of ['movement_social', 'environment_probe'] as const) {
      const files = brokerPromptFragmentFilesForMode(mode, profile);
      const prompt = loadBrokerPromptForMode(mode, profile);
      profileDetails[`${mode}:${profile}`] = {
        files,
        chars: prompt.length,
        defaultChars: defaultPrompt.length,
      };
      if (files.includes('dynamic-quests.md')) {
        violations.push(
          `${mode}:${profile} prompt includes broad dynamic-quests.md`,
        );
      }
      if (profile === 'movement_social' && files.includes('surfaces.md')) {
        violations.push(`${mode}:${profile} prompt includes surfaces.md`);
      }
      if (prompt.length >= defaultPrompt.length) {
        violations.push(
          `${mode}:${profile} prompt is not narrower than default`,
        );
      }
      if (
        !prompt.includes('## Movement') ||
        !prompt.includes('## Companions')
      ) {
        violations.push(
          `${mode}:${profile} prompt lost movement/companion rules`,
        );
      }
    }
  }

  for (const mode of ['dialogue', 'exploration', 'travel'] as const) {
    const defaultPrompt = loadBrokerPromptForMode(mode);
    const files = brokerPromptFragmentFilesForMode(mode, 'state_recap');
    const prompt = loadBrokerPromptForMode(mode, 'state_recap');
    profileDetails[`${mode}:state_recap`] = {
      files,
      chars: prompt.length,
      defaultChars: defaultPrompt.length,
    };
    if (!files.includes('state-recap.md')) {
      violations.push(`${mode}:state_recap prompt missing state-recap.md`);
    }
    for (const required of [
      'tools-narrow.md',
      'gamemaster-affordances-compact.md',
      'mentions-compact.md',
    ]) {
      if (!files.includes(required)) {
        violations.push(`${mode}:state_recap prompt missing ${required}`);
      }
    }
    if (files.includes('dynamic-quests.md') || files.includes('strings.md')) {
      violations.push(
        `${mode}:state_recap prompt includes broad dialogue fragments`,
      );
    }
    for (const broad of [
      'tools-mandatory.md',
      'gamemaster-affordances.md',
      'mentions.md',
      'player-identity-preamble.md',
    ]) {
      if (files.includes(broad)) {
        violations.push(`${mode}:state_recap prompt includes broad ${broad}`);
      }
    }
    if (prompt.length >= defaultPrompt.length) {
      violations.push(
        `${mode}:state_recap prompt is not narrower than default`,
      );
    }
  }

  for (const mode of ['dialogue', 'exploration', 'travel'] as const) {
    const defaultPrompt = loadBrokerPromptForMode(mode);
    for (const [profile, requiredFile] of [
      ['commerce_bargain', 'commerce-bargain.md'],
      ['scene_trade', 'scene-trade.md'],
    ] as const) {
      const files = brokerPromptFragmentFilesForMode(mode, profile);
      const prompt = loadBrokerPromptForMode(mode, profile);
      profileDetails[`${mode}:${profile}`] = {
        files,
        chars: prompt.length,
        defaultChars: defaultPrompt.length,
      };
      if (!files.includes(requiredFile)) {
        violations.push(`${mode}:${profile} prompt missing ${requiredFile}`);
      }
      for (const required of [
        'tools-narrow.md',
        'gamemaster-affordances-compact.md',
        'mentions-compact.md',
      ]) {
        if (!files.includes(required)) {
          violations.push(`${mode}:${profile} prompt missing ${required}`);
        }
      }
      for (const broad of [
        'tools-mandatory.md',
        'gamemaster-affordances.md',
        'mentions.md',
        'player-identity-preamble.md',
      ]) {
        if (files.includes(broad)) {
          violations.push(`${mode}:${profile} prompt includes broad ${broad}`);
        }
      }
      if (prompt.length >= defaultPrompt.length) {
        violations.push(
          `${mode}:${profile} prompt is not narrower than default`,
        );
      }
    }
  }

  for (const mode of ['dialogue', 'exploration', 'travel'] as const) {
    const defaultPrompt = loadBrokerPromptForMode(mode);
    for (const [profile, requiredFile] of [
      ['quest_seed', 'quest-seed.md'],
      ['adventure_accept', 'adventure-accept.md'],
      ['adventure_ignore', 'adventure-ignore.md'],
    ] as const) {
      const files = brokerPromptFragmentFilesForMode(mode, profile);
      const prompt = loadBrokerPromptForMode(mode, profile);
      profileDetails[`${mode}:${profile}`] = {
        files,
        chars: prompt.length,
        defaultChars: defaultPrompt.length,
      };
      if (!files.includes(requiredFile)) {
        violations.push(`${mode}:${profile} prompt missing ${requiredFile}`);
      }
      for (const required of [
        'tools-narrow.md',
        'gamemaster-affordances-compact.md',
        'mentions-compact.md',
      ]) {
        if (!files.includes(required)) {
          violations.push(`${mode}:${profile} prompt missing ${required}`);
        }
      }
      for (const broad of [
        'tools-mandatory.md',
        'gamemaster-affordances.md',
        'mentions.md',
        'player-identity-preamble.md',
      ]) {
        if (files.includes(broad)) {
          violations.push(`${mode}:${profile} prompt includes broad ${broad}`);
        }
      }
      if (prompt.length >= defaultPrompt.length) {
        violations.push(
          `${mode}:${profile} prompt is not narrower than default`,
        );
      }
    }
  }

  const narratorPrompt = loadNarratorPrompt();
  for (const forbidden of [
    'create_quest(',
    'create_entity(',
    'inventory_transfer(',
    'damage(',
    'dice_check(',
    'add_memory(',
    'set_runtime_field(',
    'apply_runtime_field_patch(',
    'move_player(',
    'advance_quest(',
    'complete_quest(',
    'start_quest(',
    'award_xp(',
  ]) {
    if (narratorPrompt.includes(forbidden)) {
      violations.push(
        `narrator prompt contains broker mutation tool example: ${forbidden}`,
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(violations.join('; '));
  }

  return {
    modes: promptDetails,
    profiles: profileDetails,
    baseFragments: BROKER_PROMPT_FRAGMENT_MANIFEST.base.length,
  };
}

async function checkBrokerStateRecapProfile(): Promise<unknown> {
  // X-3 — `brokerToolProfileForTurn` no longer inspects raw player
  // text. The classifier emits a `ProfileHint`; this check validates
  // the pure `(mode, profileHint)` selector and the resulting toolset
  // shape. Routing of free-text turns to `state_recap` is covered by
  // the classifier prompt + parser tests, not by replaying en/ru
  // sample strings here.
  const routed = [
    brokerToolProfileForTurn('dialogue', 'state_recap'),
    brokerToolProfileForTurn('exploration', 'state_recap'),
  ];
  if (routed.some((profile) => profile !== 'state_recap')) {
    throw new Error(`state recap routing failed: ${routed.join(', ')}`);
  }
  // Default hint must NOT promote to state_recap so the broker only
  // sees the focused toolset when the classifier asked for it.
  const fallback = brokerToolProfileForTurn('dialogue', 'default');
  if (fallback !== 'default') {
    throw new Error(`default hint should fall back to 'default', got ${fallback}`);
  }
  // Intimacy keeps its mandatory consent/state contract regardless of
  // the profile hint.
  const intimacyOverride = brokerToolProfileForTurn('intimacy', 'state_recap');
  if (intimacyOverride !== 'intimacy_social') {
    throw new Error(
      `intimacy mode must override profile hint, got ${intimacyOverride}`,
    );
  }

  const registry = getRegisteredTools();
  const defaultTools = toolsForBrokerMode(registry, 'dialogue', 'default');
  const recapTools = toolsForBrokerMode(registry, 'dialogue', 'state_recap');
  const names = [...recapTools.keys()].sort();

  for (const required of [
    'advance_quest',
    'complete_quest',
    'get_recent_history',
    'narrate',
    'query_inventory',
    'query_memory',
    'query_player_state',
  ]) {
    if (!recapTools.has(required)) {
      throw new Error(`state_recap missing required tool ${required}`);
    }
  }
  for (const forbidden of [
    'batch_mutate_world',
    'create_entity',
    'create_quest',
    'move_player',
    'set_runtime_field',
    'start_quest',
    'summarize_relationships',
  ]) {
    if (recapTools.has(forbidden)) {
      throw new Error(`state_recap includes broad tool ${forbidden}`);
    }
  }
  if (recapTools.size >= defaultTools.size) {
    throw new Error(
      `state_recap toolset not narrower: ${recapTools.size}/${defaultTools.size}`,
    );
  }

  return {
    routed,
    toolCount: recapTools.size,
    defaultToolCount: defaultTools.size,
    tools: names,
  };
}

async function checkBrokerFocusedCommerceProfiles(): Promise<unknown> {
  // X-3 — pure selector test: the classifier hint maps to the focused
  // commerce profiles, independent of player-text language.
  const bargainProfile = brokerToolProfileForTurn(
    'dialogue',
    'commerce_bargain',
  );
  const sceneTradeProfile = brokerToolProfileForTurn(
    'dialogue',
    'scene_trade',
  );
  if (bargainProfile !== 'commerce_bargain') {
    throw new Error(`bargain routed to ${bargainProfile}`);
  }
  if (sceneTradeProfile !== 'scene_trade') {
    throw new Error(`scene trade routed to ${sceneTradeProfile}`);
  }

  const registry = getRegisteredTools();
  const commerceTools = toolsForBrokerMode(
    registry,
    'dialogue',
    'commerce_social',
  );
  const bargainTools = toolsForBrokerMode(
    registry,
    'dialogue',
    'commerce_bargain',
  );
  const sceneTradeTools = toolsForBrokerMode(
    registry,
    'dialogue',
    'scene_trade',
  );

  for (const [profile, tools] of [
    ['commerce_bargain', bargainTools],
    ['scene_trade', sceneTradeTools],
  ] as const) {
    const requiredTools =
      profile === 'scene_trade'
        ? ['batch_mutate_world', 'dice_check', 'narrate']
        : ['dice_check', 'inventory_transfer', 'narrate'];
    for (const required of requiredTools) {
      if (!tools.has(required)) {
        throw new Error(`${profile} missing required tool ${required}`);
      }
    }
    if (profile === 'commerce_bargain' && !tools.has('batch_mutate_world')) {
      throw new Error('commerce_bargain missing batch_mutate_world');
    }
    const forbiddenTools = [
      'create_entity',
      'create_quest',
      'query_memory',
      'start_quest',
      'string_award',
      'string_spend',
    ];
    if (profile === 'commerce_bargain') {
      forbiddenTools.push('query_inventory');
    } else {
      forbiddenTools.push('add_memory');
      forbiddenTools.push('inventory_transfer');
    }
    for (const forbidden of forbiddenTools) {
      if (tools.has(forbidden)) {
        throw new Error(`${profile} includes broad tool ${forbidden}`);
      }
    }
    if (tools.size >= commerceTools.size) {
      throw new Error(
        `${profile} not narrower than commerce_social: ${tools.size}/${commerceTools.size}`,
      );
    }
  }

  return {
    routed: [bargainProfile, sceneTradeProfile],
    commerceToolCount: commerceTools.size,
    bargainToolCount: bargainTools.size,
    sceneTradeToolCount: sceneTradeTools.size,
  };
}

function duplicatePromptFragments(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) {
      duplicates.add(file);
      continue;
    }
    seen.add(file);
  }
  return [...duplicates].sort();
}

async function checkCombatSourceGrounding(): Promise<unknown> {
  const base = {
    roll_plan: { skip_attack_roll: false, reason: 'support' },
    damage_plan: {
      target: 'Support NPC',
      amount: 22,
      type: 'slashing',
      source: 'longsword',
    },
    position: 'risky' as const,
    effect: 'standard' as const,
    conditions: [
      {
        target: 'Support NPC',
        tag: 'bleeding',
        duration_turns: 2,
        severity: 2,
      },
    ],
    memory_canon: [
      {
        owner: 'Support NPC',
        about: 1,
        text: 'Support Player cut me with a longsword.',
        importance: 0.7,
        tags: ['combat', 'longsword'],
      },
    ],
    language: 'en',
  };
  const noInventory = groundCombatBriefing(base, {
    player_prose: 'I attack @Support NPC.',
    player: { id: 1, name: 'Support Player', hp: 10, max_hp: 10 },
    target: { name: 'Support NPC', hp: 20, max_hp: 20, conditions: [] },
    recent_damage: [],
    inventory: emptyCombatInventory(),
    environment: emptyCombatEnvironment(),
    language_hint: 'en',
  });
  if (
    noInventory.damage_plan.source !== 'unarmed_strike' ||
    noInventory.damage_plan.type !== 'bludgeoning' ||
    noInventory.damage_plan.amount > 6 ||
    (noInventory.conditions ?? []).some((c) => c.tag === 'bleeding') ||
    noInventory.memory_canon.length !== 0
  ) {
    throw new Error(
      `ungrounded source survived: ${JSON.stringify(noInventory)}`,
    );
  }

  const equipped = groundCombatBriefing(base, {
    player_prose: 'I attack @Support NPC.',
    player: { id: 1, name: 'Support Player', hp: 10, max_hp: 10 },
    target: { name: 'Support NPC', hp: 20, max_hp: 20, conditions: [] },
    recent_damage: [],
    inventory: {
      equipped_weapons: [
        {
          slug: 'shortsword',
          item_name: 'Shortsword',
          category: 'weapon',
          quantity: 1,
          equipped: true,
          damage_die: '1d6',
          damage_type: 'slashing',
        },
      ],
      carried_weapons: [],
      carried_tools: [],
      unarmed_source: 'unarmed_strike',
    },
    environment: emptyCombatEnvironment(),
    language_hint: 'en',
  });
  if (
    equipped.damage_plan.source !== 'shortsword' ||
    equipped.damage_plan.type !== 'slashing'
  ) {
    throw new Error(
      `equipped source not selected: ${JSON.stringify(equipped)}`,
    );
  }

  return {
    noInventory: noInventory.damage_plan,
    equipped: equipped.damage_plan,
  };
}

async function checkIntimacySpawnGrounding(): Promise<unknown> {
  const policyInput = {
    player: { id: 42, name: 'Support Player' },
    player_prose: 'support',
    partner: {
      name: 'Support Partner',
      mood: null,
      strings: 0,
      intimacy_quest_active: 'Support Existing Quest',
      sex_move: null,
    },
    language: 'en',
    participants: [],
    active_intimacy_quest_phase: 'approach',
    recent_intimate_beats: [],
  };
  const normalized = normalizeCoordinatorBrief(
    {
      phase: 'consent',
      quest_strategy: 'dynamic',
      tool_plan: [
        {
          name: 'create_quest',
          args: { title: 'Should be stripped' },
        },
        {
          name: 'advance_quest',
          args: { quest: 'Wrong Quest', to_stage: 'consent' },
        },
      ],
      memory_canon: [],
      handoff_recommend: true,
      reason: 'support',
      language: 'en',
    },
    policyInput,
  );
  if (
    normalized.quest_strategy !== 'cartridge' ||
    normalized.cartridge_quest_name !== 'Support Existing Quest' ||
    normalized.tool_plan.some((tool) => tool.name === 'create_quest') ||
    normalized.tool_plan[0]?.args.quest !== 'Support Existing Quest'
  ) {
    throw new Error(
      `coordinator policy failed cartridge normalization: ${JSON.stringify(normalized)}`,
    );
  }

  const skip = normalizeCoordinatorBrief(
    {
      phase: 'skip',
      quest_strategy: 'dynamic',
      tool_plan: [{ name: 'create_quest', args: { title: 'Nope' } }],
      memory_canon: [
        {
          owner: 'Support Partner',
          about: 42,
          text: 'Should be cleared.',
          importance: 0.6,
          tags: ['support'],
        },
      ],
      handoff_recommend: true,
      reason: 'support',
      language: 'en',
    },
    policyInput,
  );
  if (
    skip.quest_strategy !== 'none' ||
    skip.tool_plan.length !== 0 ||
    skip.memory_canon.length !== 0 ||
    skip.handoff_recommend
  ) {
    throw new Error(
      `coordinator policy failed skip normalization: ${JSON.stringify(skip)}`,
    );
  }

  const dynamic = normalizeCoordinatorBrief(
    {
      phase: 'approach',
      dynamic_quest_copy: {
        title: 'Support Dynamic Beat',
        goal_text: 'Support dynamic relationship beat.',
      },
      resource_intents: [
        {
          kind: 'relationship_delta',
          npc: 'Support Partner',
          delta: 99,
          reason: 'support model-style proposal',
        },
      ],
      memory_canon: [],
      handoff_recommend: false,
      reason: 'support',
      language: 'en',
    },
    {
      ...policyInput,
      partner: {
        ...policyInput.partner,
        intimacy_quest_active: null,
      },
      active_intimacy_quest_phase: null,
    },
  );
  const dynamicCreate = dynamic.tool_plan.find(
    (tool) => tool.name === 'create_quest',
  );
  const dynamicString = dynamic.tool_plan.find(
    (tool) => tool.name === 'string_award',
  );
  if (
    dynamic.quest_strategy !== 'dynamic' ||
    !dynamicCreate ||
    'spawn_entities' in dynamicCreate.args ||
    typeof dynamicCreate.args.summary !== 'string' ||
    dynamicCreate.args.summary.length < 8 ||
    !Array.isArray(dynamicCreate.args.stages) ||
    dynamicCreate.args.stages.length !== 5 ||
    dynamic.tool_plan.some(
      (tool) => tool.name === 'award_xp' || tool.name === 'add_memory',
    ) ||
    dynamicString?.args.delta !== 3
  ) {
    throw new Error(
      `coordinator policy failed dynamic compilation: ${JSON.stringify(dynamic)}`,
    );
  }

  const aftermath = normalizeCoordinatorBrief(
    {
      phase: 'aftermath',
      quest_strategy: 'cartridge',
      tool_plan: [
        {
          name: 'award_xp',
          args: { amount: 999, reason: 'support aftermath' },
        },
        { name: 'string_award', args: { npc: 'Support Partner', delta: 99 } },
        {
          name: 'add_memory',
          args: { owner: 'Support Partner', text: 'Nope' },
        },
        {
          name: 'apply_runtime_field_patch',
          args: { patches: [{ field_id: 'bad', value: true }] },
        },
      ],
      memory_canon: [],
      handoff_recommend: true,
      reason: 'support',
      language: 'en',
    },
    {
      ...policyInput,
      active_intimacy_quest_phase: 'climax',
      partner: {
        ...policyInput.partner,
        sex_move: {
          effect_tool: 'add_memory',
          effect_args: {
            owner: 'Support Partner',
            about: 42,
            text: 'Support sex move memory.',
            importance: 0.8,
            tags: ['support', 'sex_move'],
          },
        },
      },
    },
  );
  const completeTool = aftermath.tool_plan[0];
  const aftermathXp = aftermath.tool_plan.find(
    (tool) => tool.name === 'award_xp',
  );
  const aftermathString = aftermath.tool_plan.find(
    (tool) => tool.name === 'string_award',
  );
  const aftermathMemory = aftermath.tool_plan.find(
    (tool) => tool.name === 'add_memory',
  );
  if (
    completeTool?.name !== 'complete_quest' ||
    completeTool.args.quest !== 'Support Existing Quest' ||
    aftermathXp?.args.amount !== 100 ||
    aftermathXp.args.player_id !== 42 ||
    aftermathString?.args.delta !== 3 ||
    aftermath.tool_plan.some(
      (tool) => tool.name === 'apply_runtime_field_patch',
    ) ||
    aftermathMemory?.args.text !== 'Support sex move memory.'
  ) {
    throw new Error(
      `coordinator policy failed aftermath compilation: ${JSON.stringify(aftermath)}`,
    );
  }

  const grounded = groundCoordinatorBriefing({
    phase: 'approach',
    quest_strategy: 'dynamic',
    tool_plan: [
      {
        name: 'create_quest',
        args: {
          title: 'Support Intimacy Beat',
          goal_text: 'Support relationship beat.',
          stages: [{ id: 'approach', title: 'Approach' }],
          spawn_entities: [
            {
              kind: 'location',
              display_name: 'Unsupported Private Room',
              summary: 'Should not survive coordinator grounding.',
            },
          ],
        },
      },
    ],
    memory_canon: [],
    handoff_recommend: true,
    reason: 'support',
    language: 'en',
  });
  const firstArgs = grounded.tool_plan[0]?.args as
    | Record<string, unknown>
    | undefined;
  if (firstArgs && 'spawn_entities' in firstArgs) {
    throw new Error(
      `coordinator spawn_entities survived: ${JSON.stringify(firstArgs)}`,
    );
  }
  return {
    createQuestArgs: firstArgs,
    policyQuest: normalized.cartridge_quest_name,
    dynamicTools: dynamic.tool_plan.map((tool) => tool.name),
    aftermathTools: aftermath.tool_plan.map((tool) => tool.name),
  };
}

function emptyCombatInventory() {
  return {
    equipped_weapons: [],
    carried_weapons: [],
    carried_tools: [],
    unarmed_source: 'unarmed_strike' as const,
  };
}

function emptyCombatEnvironment() {
  return {
    location_name: 'Support Lane',
    location_summary: 'Support smoke lane.',
    items_here: [],
    active_surfaces: [],
  };
}

async function checkAgentSelectedLanguageContracts(): Promise<unknown> {
  const languages = ['ro', 'ar'];
  const checkedByLanguage: Record<string, string[]> = {};

  for (const language of languages) {
    const snippets = buildAgentLanguageContractSnippets(language);
    const languageName = agentLanguageName(language);
    const missing = snippets
      .filter(
        (snippet) =>
          !snippet.text.includes('<agent_language_contract>') ||
          !snippet.text.includes(`selected_language_code: ${language}`) ||
          !snippet.text.includes(`selected_language_name: ${languageName}`),
      )
      .map((snippet) => snippet.name);
    if (missing.length > 0) {
      throw new Error(
        `missing selected-language contract for ${language}: ${missing.join(', ')}`,
      );
    }
    checkedByLanguage[language] = snippets.map((snippet) => snippet.name);
  }

  const banned = [
    "Mirror the player's input language",
    'Detect from player_prose',
    'Match the language of the draft',
    "Match the player's narrative language",
  ];
  const promptText = [
    adventureMaterializerPrompt.system,
    combatDirectorPrompt.system,
    dialogueAnchorPrompt.system,
    intimacyCoordinatorPrompt.system,
    npcVoicePrompt.system,
    questWatcherPrompt.system,
    rewardCalibratorPrompt.system,
    voiceWardenPrompt.system,
  ].join('\n');
  const offenders = banned.filter((phrase) => promptText.includes(phrase));
  if (offenders.length > 0) {
    throw new Error(
      `prompt still infers output language from input: ${offenders.join('; ')}`,
    );
  }

  return { languages, checkedByLanguage };
}

async function checkCartridgeNestedI18nRuntime(
  world: SupportWorld,
): Promise<unknown> {
  const titleEn = `Support Localized Quest ${world.suffix}`;
  const summaryRo = `Rezumat localizat ${world.suffix}`;
  const summaryAr = `ملخص مترجم ${world.suffix}`;
  const stageNameRo = `Etapa localizata ${world.suffix}`;
  const stageNameAr = `مرحلة مترجمة ${world.suffix}`;
  const stageDescriptionRo = `Descriere de etapa ${world.suffix}`;
  const stageDescriptionAr = `وصف مرحلة ${world.suffix}`;

  const inserted = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags, i18n,
       cartridge_id, dynamic_origin
     )
       VALUES (
         'quest',
         $1,
         'English support summary',
         jsonb_build_object(
           'stages', jsonb_build_array(
             jsonb_build_object(
               'id', 'opening',
               'name', 'English Stage',
               'description', 'English stage description',
               'objectives', jsonb_build_array()
             )
           )
         ),
         ARRAY['quest']::text[],
         jsonb_build_object(
           'display_name', jsonb_build_object('ro', $1::text, 'ar', $1::text),
           'summary', jsonb_build_object('ro', $2::text, 'ar', $3::text),
           'profile.stages.opening.name', jsonb_build_object('ro', $4::text, 'ar', $5::text),
           'profile.stages.opening.description', jsonb_build_object('ro', $6::text, 'ar', $7::text)
         ),
         'support-smoke',
         false
       )
       RETURNING id`,
    [
      titleEn,
      summaryRo,
      summaryAr,
      stageNameRo,
      stageNameAr,
      stageDescriptionRo,
      stageDescriptionAr,
    ],
  );
  const questId = inserted.rows[0]?.id;
  if (!questId) throw new Error('localized support quest was not inserted');
  await query(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase, current_stage_id, started_at)
     VALUES ($1, $2, 'active', 1, 'opening', now())
     ON CONFLICT (player_id, quest_entity_id) DO NOTHING`,
    [world.playerId, questId],
  );

  const roContext = await buildTurnContext(world.sessionId, world.playerId, {
    lang: 'ro',
  });
  if (
    !roContext.dynamic.includes(titleEn) ||
    !roContext.dynamic.includes(summaryRo) ||
    !roContext.dynamic.includes(stageNameRo) ||
    !roContext.dynamic.includes(stageDescriptionRo)
  ) {
    throw new Error(
      'Romanian nested quest i18n did not render in turn context',
    );
  }

  const arContext = await buildTurnContext(world.sessionId, world.playerId, {
    lang: 'ar',
  });
  if (
    !arContext.dynamic.includes(titleEn) ||
    !arContext.dynamic.includes(summaryAr) ||
    !arContext.dynamic.includes(stageNameAr) ||
    !arContext.dynamic.includes(stageDescriptionAr)
  ) {
    throw new Error('Arabic nested quest i18n did not render in turn context');
  }

  const roResponse = await questRoutes.request(
    `http://support.local/${world.playerId}/quests?language=ro`,
  );
  if (!roResponse.ok) {
    throw new Error(`localized quest route failed: ${roResponse.status}`);
  }
  const roJson = (await roResponse.json()) as {
    active?: Array<{
      id: number;
      name?: string;
      summary?: string | null;
      stage?: { name?: string; description?: string };
    }>;
  };
  const localizedQuest = (roJson.active ?? []).find(
    (row) => row.id === questId,
  );
  if (
    !localizedQuest ||
    localizedQuest.name !== titleEn ||
    localizedQuest.summary !== summaryRo ||
    localizedQuest.stage?.name !== stageNameRo ||
    localizedQuest.stage?.description !== stageDescriptionRo
  ) {
    throw new Error(
      `localized quest route returned wrong text: ${JSON.stringify(localizedQuest)}`,
    );
  }

  return {
    questId,
    languages: ['ro', 'ar'],
    context: {
      ro: [titleEn, summaryRo, stageNameRo, stageDescriptionRo],
      ar: [titleEn, summaryAr, stageNameAr, stageDescriptionAr],
    },
  };
}

function buildAgentLanguageContractSnippets(
  language: string,
): Array<{ name: string; text: string }> {
  const snippets: Array<{ name: string; text: string }> = [
    { name: 'contract', text: buildAgentLanguageContract(language) },
    {
      name: 'adventure_materializer',
      text: adventureMaterializerPrompt.buildUser({
        schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
        language,
        queue: {
          id: 1,
          adventureKind: 'social_hook',
          source: 'support',
          tableId: ADVENTURE_TABLE_ID,
          seed: 'support',
          sequence: 1,
          rollResult: {},
          contextSnapshot: { language },
        },
        player: {
          id: 1,
          name: 'Support Player',
          level: 1,
          currentLocationId: 2,
          currentLocationName: 'Support Lane',
        },
        locationContext: null,
        activeQuests: [],
        nearby: [],
        relationships: [],
        relevantMemories: [],
        activeSituations: [],
        duplicateCandidates: [],
        recentNarrative: '',
      }),
    },
    {
      name: 'combat_director',
      text: combatDirectorPrompt.buildUser({
        player_prose: 'I strike @Target.',
        player: { id: 1, name: 'Support Player', hp: 10, max_hp: 10 },
        target: { name: 'Target', hp: 10, max_hp: 10, conditions: [] },
        recent_damage: [],
        inventory: emptyCombatInventory(),
        environment: emptyCombatEnvironment(),
        language_hint: language,
      }),
    },
    {
      name: 'dialogue_anchor',
      text: dialogueAnchorPrompt.buildUser({
        partner_name: 'Support NPC',
        partner_speech_style: null,
        partner_persona: null,
        recent_exchanges: [{ role: 'player', text: 'Hello.' }],
        previous_emotional_beat: null,
        language,
      }),
    },
    {
      name: 'intimacy_coordinator',
      text: intimacyCoordinatorPrompt.buildUser({
        player: { id: 1, name: 'Support Player' },
        player_prose: 'I take their hand.',
        partner: {
          name: 'Support NPC',
          mood: null,
          strings: 0,
          intimacy_quest_active: null,
          sex_move: null,
        },
        language,
        participants: [],
        active_intimacy_quest_phase: null,
        recent_intimate_beats: [],
      }),
    },
    {
      name: 'npc_voice',
      text: npcVoicePrompt.buildUser({
        npc_name: 'Support NPC',
        npc_speech_style: null,
        npc_persona: null,
        draft_text: 'Support Player spoke to me.',
        about_name: 'Support Player',
        importance: 0.5,
        tags: ['support'],
        recent_utterances: [],
        past_memories: [],
        language,
      }),
    },
    {
      name: 'quest_watcher',
      text: questWatcherPrompt.buildUser({
        player: { id: 1, name: 'Support Player' },
        language,
        active_quests: [],
        turn: { user_text: 'I wait.', tool_calls: [], visible_narrative: '' },
      }),
    },
    {
      name: 'reward_calibrator',
      text: rewardCalibratorPrompt.buildUser({
        player_level: 1,
        scene_scale_hint: 'trivial',
        recent_xp_last_10_turns: 0,
        recent_xp_total: 0,
        player_text: 'I wait.',
        cartridge_tier: 'standard',
        language,
      }),
    },
    {
      name: 'voice_warden',
      text: voiceWardenPrompt.buildUser({
        author_name: 'Support Lane',
        author_kind: 'location',
        tone: 'narrator',
        text: 'Support NPC says hello.',
        candidate_npcs: ['Support NPC'],
        current_location_name: 'Support Lane',
        language,
      }),
    },
  ];
  return snippets;
}

async function seedSupportWorld(): Promise<SupportWorld> {
  // ARCH-8 / ARCH-19 Phases 3+4 — make support-smoke the active
  // cartridge for the duration of this run so the column-based
  // cartridgeScope.ts predicate matches the fixtures (which all
  // carry cartridge_id = 'support-smoke'). The legacy `'support-smoke'`
  // tag retired in migration 0124; entities.cartridge_id is the
  // canonical scope.
  await query(
    `INSERT INTO cartridge_meta (key, value, description)
     VALUES ('cartridge_id', to_jsonb('support-smoke'::text), 'Active cartridge for support-smoke harness')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const { clearMetaCache } = await import('../cartridge.js');
  clearMetaCache();

  const suffix = `${process.pid}-${Date.now()}`;
  const locationName = `Support Smoke Location ${suffix}`;
  const locationId = await insertEntity(
    'location',
    locationName,
    'Support smoke location.',
  );
  const playerName = `Support Smoke Player ${suffix}`;
  const playerId = await insertEntity(
    'player',
    playerName,
    'Support smoke player.',
  );
  await query(
    `INSERT INTO players (entity_id, public_id, current_location_id)
     VALUES ($1, $2, $3)`,
    [playerId, randomUUID(), locationId],
  );
  const npcName = `Support Smoke Archivist ${suffix}`;
  const npcId = await insertEntity('person', npcName, 'Support smoke NPC.');
  await query(
    `UPDATE entities
        SET profile = jsonb_build_object(
          'owner_entity_id', $2::bigint,
          'access_policy', 'public'
        )
      WHERE id = $1`,
    [locationId, npcId],
  );
  await query(
    `UPDATE entities SET profile = jsonb_build_object('home_id', $1::text)
      WHERE id = $2`,
    [locationId, npcId],
  );
  const signalFieldId = await insertRuntimeField(
    playerId,
    'support_signal',
    'string',
    'idle',
    'session',
  );
  const conditionFieldId = await insertRuntimeField(
    playerId,
    'conditions',
    'json',
    [],
    'turn',
  );
  const surfaceFieldId = await insertRuntimeField(
    locationId,
    'active_surfaces',
    'json',
    [],
    'scene',
  );

  const sessionId = `support-smoke-session-${suffix}`;
  const session = await sessionManager.getOrCreate(sessionId, playerId);
  session.activeTurn = {
    turnId: `support-smoke-turn-${suffix}`,
    abortController: new AbortController(),
    startedAt: Date.now(),
  };

  const events: Array<{ event?: string; data?: string; id?: string }> = [];
  const stream = {
    write: async () => {},
    writeSSE: async (event: {
      event?: string;
      data?: unknown;
      id?: string;
    }) => {
      events.push({
        event: event.event,
        id: event.id,
        data: typeof event.data === 'string' ? event.data : undefined,
      });
    },
    onAbort: () => {},
  } as unknown as Parameters<Session['sse']['runFor']>[0];
  const ssePump = session.sse.runFor(stream);

  return {
    suffix,
    sessionId,
    playerId,
    locationId,
    locationName,
    playerName,
    npcId,
    npcName,
    signalFieldId,
    surfaceFieldId,
    conditionFieldId,
    session,
    events,
    ssePump,
  };
}

async function checkAtomicBatchRollback(world: SupportWorld): Promise<unknown> {
  const before = await readPlayerXp(world.playerId);
  const result = await dispatch(
    'batch_mutate_world',
    {
      reason: 'support smoke rollback',
      atomic: true,
      operations: [
        {
          id: 'rolled-grant',
          tool: 'award_xp',
          args: { player: world.playerName, amount: 5, reason: 'rollback' },
        },
        {
          id: 'rolled-fail',
          tool: 'award_xp',
          args: {
            player: 'Support Smoke Missing Player',
            amount: 1,
            reason: 'fail',
          },
        },
      ],
    },
    baseCtx(world),
  );
  if (result.ok) throw new Error('rollback batch unexpectedly succeeded');
  await sleep(80);
  const after = await readPlayerXp(world.playerId);
  if (after !== before) {
    throw new Error(
      `XP changed after rollback: before=${before}, after=${after}`,
    );
  }
  return { xp: after };
}

async function checkNoRolledBackSse(world: SupportWorld): Promise<unknown> {
  // GE-1 — the outbox now emits only the normalized `gui:event`
  // SSE per released `gui_events` row. A rolled-back transaction
  // must therefore leave NO `xp:awarded` envelope on the wire.
  const xpEnvelopes = guiEventEnvelopes(world).filter(
    (event) => event.type === 'xp:awarded',
  );
  if (xpEnvelopes.length > 0) {
    throw new Error('rolled-back xp:awarded gui:event SSE was delivered');
  }
  return { xpAwardedEvents: xpEnvelopes.length };
}

async function checkSuccessfulBatchSse(world: SupportWorld): Promise<unknown> {
  const result = await dispatch(
    'batch_mutate_world',
    {
      reason: 'support smoke committed batch',
      atomic: true,
      operations: [
        {
          id: 'remember',
          tool: 'add_memory',
          args: {
            owner: world.npcName,
            about: world.playerId,
            text: 'Support smoke committed memory',
            importance: 0.6,
          },
        },
        {
          id: 'grant',
          tool: 'award_xp',
          args: {
            player: world.playerName,
            amount: 7,
            reason: 'support smoke',
          },
        },
      ],
    },
    baseCtx(world),
  );
  if (!result.ok) throw new Error(`committed batch failed: ${result.error}`);
  await waitUntil(
    () =>
      guiEventEnvelopes(world).some((event) => event.type === 'xp:awarded'),
    'xp:awarded gui:event SSE',
  );
  const xp = await readPlayerXp(world.playerId);
  if (xp !== 7) throw new Error(`expected committed XP=7, got ${xp}`);
  const xpEnvelopes = guiEventEnvelopes(world).filter(
    (event) => event.type === 'xp:awarded',
  );
  return { xp, xpAwardedEvents: xpEnvelopes.length };
}

async function checkGuiEventOutboxOrdering(
  world: SupportWorld,
): Promise<unknown> {
  await waitUntil(
    () => guiEventEnvelopes(world).some((event) => event.type === 'xp:awarded'),
    'gui:event xp:awarded SSE',
  );
  const rows = await query<{
    id: number;
    event_type: string;
    status: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, event_type, status, payload
       FROM gui_events
      WHERE session_id = $1
        AND event_type IN ('memory:added', 'xp:awarded')
      ORDER BY id ASC`,
    [world.sessionId],
  );
  const memory = rows.rows.find((row) => row.event_type === 'memory:added');
  const xp = rows.rows.find((row) => row.event_type === 'xp:awarded');
  if (!memory || !xp) {
    throw new Error(
      `missing gui_events rows: ${rows.rows.map((r) => r.event_type).join(',')}`,
    );
  }
  if (memory.status !== 'released' || xp.status !== 'released') {
    throw new Error('gui_events rows were not released');
  }
  if (Number(memory.id) >= Number(xp.id)) {
    throw new Error(
      `gui event order drifted: memory=${memory.id}, xp=${xp.id}`,
    );
  }
  // GE-1 — legacy per-type `xp:awarded` SSE was removed; the
  // normalized `gui:event` envelope is the single source of truth
  // for outbox-routed events. Verify both `gui_events` rows are
  // represented exactly once on the wire and that the envelope's
  // `eventId` matches the durable row id.
  const envelopes = guiEventEnvelopes(world);
  const memoryEnvelope = envelopes.find(
    (event) => event.eventId === Number(memory.id),
  );
  const xpEnvelope = envelopes.find(
    (event) => event.eventId === Number(xp.id),
  );
  if (!memoryEnvelope || !xpEnvelope) {
    throw new Error('normalized gui:event envelopes missing outbox ids');
  }
  if (xpEnvelope.type !== 'xp:awarded') {
    throw new Error(
      `expected xp envelope type=xp:awarded, got ${xpEnvelope.type}`,
    );
  }
  // No legacy per-type SSE for outbox-routed events.
  if (world.events.some((event) => event.event === 'xp:awarded')) {
    throw new Error(
      'unexpected legacy xp:awarded SSE alongside the gui:event envelope',
    );
  }
  return {
    rows: rows.rows.length,
    firstEventId: Number(memory.id),
    secondEventId: Number(xp.id),
    envelopes: envelopes.length,
  };
}

async function checkPresentationBarrierBlocks(
  world: SupportWorld,
): Promise<unknown> {
  const barrier = openPresentationBarrier(world.session, {
    turnId: 'support-smoke-barrier-turn',
    pendingVisibleSlots: 2,
    deadlineMs: 30_000,
  });
  const active = currentPresentationBarrier(world.session);
  if (!active || active.id !== barrier.id) {
    throw new Error('presentation barrier was not visible as open');
  }
  closePresentationBarrier(world.session, barrier.id, 'support_smoke_done');
  const afterClose = currentPresentationBarrier(world.session);
  if (afterClose) {
    throw new Error('presentation barrier remained open after close');
  }
  return {
    opened: barrier.id,
    blockingTurnId: barrier.turnId,
    pendingVisibleSlots: barrier.pendingVisibleSlots,
  };
}

async function checkPostTurnSlotRegistryOrdering(
  world: SupportWorld,
): Promise<unknown> {
  const turnId = `support-smoke-slots-${world.suffix}`;
  const slots = await reservePostTurnPresentationSlots(
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId,
    },
    [
      {
        name: 'support_slow',
        presentation: {
          slotKey: 'post.support_slow',
          lane: 'post_response',
          ordinal: 10,
          visible: true,
          barrierMode: 'chat_visible',
          deadlineMs: 500,
        },
      },
      {
        name: 'support_fast',
        presentation: {
          slotKey: 'post.support_fast',
          lane: 'post_response',
          ordinal: 20,
          visible: true,
          barrierMode: 'chat_visible',
          deadlineMs: 500,
        },
      },
      {
        name: 'support_throwing',
        presentation: {
          slotKey: 'post.support_throwing',
          lane: 'status',
          ordinal: 30,
          visible: true,
          barrierMode: 'chat_visible',
          deadlineMs: 500,
        },
      },
      {
        name: 'support_expired',
        presentation: {
          slotKey: 'post.support_expired',
          lane: 'status',
          ordinal: 35,
          visible: true,
          barrierMode: 'chat_visible',
          deadlineMs: 40,
        },
      },
      {
        name: 'support_quiet',
        presentation: {
          slotKey: 'post.support_quiet',
          lane: 'rail',
          ordinal: 40,
          visible: false,
          barrierMode: 'non_blocking',
          deadlineMs: 500,
        },
      },
      {
        name: 'support_rail',
        presentation: {
          slotKey: 'post.support_rail',
          lane: 'rail',
          ordinal: 50,
          visible: true,
          barrierMode: 'non_blocking',
          deadlineMs: 500,
        },
      },
    ],
  );

  await Promise.allSettled([
    runPostTurnHookWithPresentation(slots[0]!, async ({ presentation }) => {
      await sleep(60);
      await presentation.emit('quest_pacer:stale', {
        questId: 1,
        questTitle: 'slow slot',
        details: 'slow support slot',
        suggestion: 'release first',
      });
    }),
    runPostTurnHookWithPresentation(slots[1]!, async ({ presentation }) => {
      await presentation.emit('quest_pacer:overload', {
        questId: null,
        questTitle: null,
        details: 'fast support slot',
        suggestion: 'must wait for slow slot',
      });
    }),
    runPostTurnHookWithPresentation(slots[2]!, async () => {
      throw new Error('support throwing slot');
    }),
    runPostTurnHookWithPresentation(slots[3]!, async () => {
      await sleep(120);
    }),
    runPostTurnHookWithPresentation(slots[4]!, async () => {
      // quiet hook: wrapper should skip the slot.
    }),
    runPostTurnHookWithPresentation(slots[5]!, async ({ presentation }) => {
      await presentation.emit('memory:enriched', {
        entityId: world.playerId,
        details: 'rail support slot',
      });
    }),
  ]);

  await waitUntil(
    () =>
      turnEvents(world, turnId).some(
        (event) => event.event === 'quest_pacer:stale',
      ) &&
      turnEvents(world, turnId).some(
        (event) => event.event === 'quest_pacer:overload',
      ) &&
      turnEvents(world, turnId).some(
        (event) => event.event === 'memory:enriched',
      ) &&
      turnEvents(world, turnId).filter(
        (event) => event.event === 'post_turn:slot_failed',
      ).length >= 2,
    'post-turn slot ordered SSE',
  );

  const sequence = turnEvents(world, turnId).map((event) => event.event);
  const slowIndex = sequence.indexOf('quest_pacer:stale');
  const fastIndex = sequence.indexOf('quest_pacer:overload');
  const railIndex = sequence.indexOf('memory:enriched');
  const failedIndex = sequence.indexOf('post_turn:slot_failed');
  const secondFailedIndex = sequence.indexOf(
    'post_turn:slot_failed',
    failedIndex + 1,
  );
  if (
    slowIndex < 0 ||
    fastIndex < 0 ||
    railIndex < 0 ||
    failedIndex < 0 ||
    secondFailedIndex < 0
  ) {
    throw new Error(`missing slot events: ${sequence.join(',')}`);
  }
  if (
    !(
      slowIndex < fastIndex &&
      fastIndex < failedIndex &&
      failedIndex < secondFailedIndex
    )
  ) {
    throw new Error(`slot release order drifted: ${sequence.join(' -> ')}`);
  }
  if (!(railIndex < slowIndex)) {
    throw new Error(
      `non-blocking rail event did not release while chat barrier was open: ${sequence.join(' -> ')}`,
    );
  }

  const snapshots = await listPostTurnPresentationSlots(world.sessionId, {
    turnId,
  });
  const byKey = new Map(snapshots.map((slot) => [slot.slotKey, slot]));
  if (byKey.get('post.support_slow')?.slotStatus !== 'emitted') {
    throw new Error('slow slot did not resolve as emitted');
  }
  if (byKey.get('post.support_fast')?.slotStatus !== 'emitted') {
    throw new Error('fast slot did not resolve as emitted');
  }
  if (byKey.get('post.support_throwing')?.slotStatus !== 'failed') {
    throw new Error('throwing slot did not resolve as failed');
  }
  if (byKey.get('post.support_expired')?.slotStatus !== 'expired') {
    throw new Error('expired slot did not resolve as expired');
  }
  if (byKey.get('post.support_quiet')?.slotStatus !== 'skipped') {
    throw new Error('quiet slot did not resolve as skipped');
  }
  if (byKey.get('post.support_rail')?.slotStatus !== 'emitted') {
    throw new Error('rail slot did not resolve as emitted');
  }
  const telemetryRows = await query<{
    slot_key: string;
    slot_status: string;
    deadline_ms: number | string;
    expired: boolean;
  }>(
    `SELECT slot_key, slot_status, deadline_ms, expired
       FROM turn_telemetry
      WHERE session_id = $1
        AND turn_id = $2
        AND slot_key IS NOT NULL`,
    [world.sessionId, turnId],
  );
  const telemetryKeys = new Set(telemetryRows.rows.map((row) => row.slot_key));
  for (const key of [
    'post.support_slow',
    'post.support_fast',
    'post.support_throwing',
    'post.support_expired',
    'post.support_quiet',
    'post.support_rail',
  ]) {
    if (!telemetryKeys.has(key)) {
      throw new Error(`missing slot telemetry for ${key}`);
    }
  }
  if (
    !telemetryRows.rows.some(
      (row) => row.slot_key === 'post.support_expired' && row.expired,
    )
  ) {
    throw new Error('expired slot telemetry did not mark expired=true');
  }

  return {
    slots: snapshots.length,
    telemetryRows: telemetryRows.rows.length,
    sequence,
  };
}

async function checkPostTurnRealQuestPacerSlot(
  world: SupportWorld,
): Promise<unknown> {
  const turnId = `support-smoke-real-pacer-${world.suffix}`;
  const questIds: number[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const questId = await insertGuardrailQuest(world, {
        title: `Support Smoke Pacer Quest ${world.suffix}-${index}`,
        rewardXp: 0,
      });
      questIds.push(questId);
      await query(
        `INSERT INTO player_quests
           (player_id, quest_entity_id, status, started_at, current_stage_id)
         VALUES ($1, $2, 'active', now(), 'open')
         ON CONFLICT (player_id, quest_entity_id)
         DO UPDATE SET status = 'active',
                       started_at = now(),
                       current_stage_id = 'open'`,
        [world.playerId, questId],
      );
    }

    const [slot] = await reservePostTurnPresentationSlots(
      {
        sessionId: world.sessionId,
        playerId: world.playerId,
        turnId,
      },
      [questPacerHook],
    );
    if (!slot) throw new Error('quest pacer slot was not reserved');

    const abortController = new AbortController();
    await runPostTurnHookWithPresentation(slot, async ({ presentation }) => {
      await questPacerHook.run(
        {
          sessionId: world.sessionId,
          playerId: world.playerId,
          turnId,
          signal: abortController.signal,
          presentation,
        },
        {
          text: 'support smoke quest pacer overload',
          toolHistory: [],
          narrative: 'Support smoke deterministic quest pacer overload.',
        },
      );
    });

    await waitUntil(
      () =>
        turnEvents(world, turnId).some(
          (event) => event.event === 'quest_pacer:overload',
        ),
      'real quest pacer overload SSE',
    );

    const snapshots = await listPostTurnPresentationSlots(world.sessionId, {
      turnId,
    });
    const pacerSlot = snapshots.find(
      (snapshot) => snapshot.slotKey === 'post.quest_pacer',
    );
    if (pacerSlot?.slotStatus !== 'emitted') {
      throw new Error(
        `real quest pacer slot status drifted: ${pacerSlot?.slotStatus ?? '<missing>'}`,
      );
    }
    const telemetryRows = await query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
         FROM turn_telemetry
        WHERE session_id = $1
          AND turn_id = $2
          AND slot_key = 'post.quest_pacer'
          AND slot_status = 'emitted'`,
      [world.sessionId, turnId],
    );
    if (Number(telemetryRows.rows[0]?.count ?? 0) !== 1) {
      throw new Error('real quest pacer slot telemetry missing');
    }

    return {
      turnId,
      slotStatus: pacerSlot.slotStatus,
      activeQuests: questIds.length,
    };
  } finally {
    if (questIds.length > 0) {
      await query(
        `DELETE FROM player_quests
          WHERE player_id = $1
            AND quest_entity_id = ANY($2::bigint[])`,
        [world.playerId, questIds],
      ).catch(() => {});
      // ARCH-19 Phase 4 (migration 0124) — support-smoke fixtures
      // are scoped via `cartridge_id`, not the retired
      // `'support-smoke'` tag.
      await query(
        `DELETE FROM entities
          WHERE id = ANY($1::bigint[])
            AND cartridge_id = 'support-smoke'`,
        [questIds],
      ).catch(() => {});
    }
    await query(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb) - 'quest_pacer'
        WHERE entity_id = $1`,
      [world.playerId],
    ).catch(() => {});
  }
}

async function checkQuestProgressionArbiter(
  world: SupportWorld,
): Promise<unknown> {
  const questIds: number[] = [];
  try {
    const duplicateTurnId = `support-smoke-quest-duplicate-${world.suffix}`;
    const duplicateTitle = `Support Smoke Duplicate Quest ${world.suffix}`;
    const duplicateQuestId = await insertGuardrailQuest(world, {
      title: duplicateTitle,
      rewardXp: 0,
    });
    questIds.push(duplicateQuestId);
    await dispatch(
      'start_quest',
      { quest_id: duplicateQuestId, player_id: world.playerId },
      { ...baseCtx(world), turnId: duplicateTurnId },
    );
    const advancedBefore = countEvents(world, 'quest:advanced');
    const brokerAdvance = await dispatch(
      'advance_quest',
      { quest: duplicateTitle, player_id: world.playerId, to_stage: 'done' },
      { ...baseCtx(world), turnId: duplicateTurnId },
    );
    if (!brokerAdvance.ok) {
      throw new Error(`broker title advance failed: ${brokerAdvance.error}`);
    }
    const duplicateVerdict = await applyQuestTransitionProposal({
      source: 'quest_watcher',
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: duplicateTurnId,
      questId: duplicateQuestId,
      expectedCurrentStageId: 'open',
      action: 'advance',
      toStage: 'done',
      reason: 'support smoke duplicate watcher proposal after broker advance',
      turnToolHistory: [
        {
          name: 'advance_quest',
          args: { quest: duplicateTitle, to_stage: 'done' },
          ok: true,
          source: 'ai_sdk',
          result: { quest_id: duplicateQuestId, changed: true },
        },
      ],
    });
    if (
      duplicateVerdict.applied ||
      duplicateVerdict.verdict.reason !== 'already_handled_same_turn'
    ) {
      throw new Error(
        `duplicate proposal was not skipped: ${JSON.stringify(duplicateVerdict)}`,
      );
    }
    if (countEvents(world, 'quest:advanced') - advancedBefore !== 1) {
      throw new Error(
        'duplicate watcher proposal emitted an extra quest:advanced card',
      );
    }

    const staleQuestId = await insertActiveSupportQuest(world, {
      title: `Support Smoke Stale Quest ${world.suffix}`,
      startedAtSql: 'now()',
    });
    questIds.push(staleQuestId);
    const staleVerdict = await applyQuestTransitionProposal({
      source: 'quest_watcher',
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: `support-smoke-quest-stale-${world.suffix}`,
      questId: staleQuestId,
      expectedCurrentStageId: 'wrong_stage',
      action: 'advance',
      toStage: 'done',
      reason: 'support smoke stale watcher stage',
    });
    if (
      staleVerdict.applied ||
      staleVerdict.verdict.reason !== 'stale_current_stage'
    ) {
      throw new Error(
        `stale proposal was not rejected: ${JSON.stringify(staleVerdict)}`,
      );
    }

    const illegalQuestId = await insertActiveSupportQuest(world, {
      title: `Support Smoke Illegal Quest ${world.suffix}`,
      startedAtSql: 'now()',
    });
    questIds.push(illegalQuestId);
    const illegalVerdict = await applyQuestTransitionProposal({
      source: 'quest_watcher',
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: `support-smoke-quest-illegal-${world.suffix}`,
      questId: illegalQuestId,
      expectedCurrentStageId: 'open',
      action: 'advance',
      toStage: 'missing_stage',
      reason: 'support smoke illegal watcher target',
    });
    if (
      illegalVerdict.applied ||
      illegalVerdict.verdict.reason !== 'illegal_stage_transition'
    ) {
      throw new Error(
        `illegal proposal was not rejected: ${JSON.stringify(illegalVerdict)}`,
      );
    }

    const spawnedLocationId = await insertEntity(
      'location',
      `Support Smoke Quest Spawn Location ${world.suffix}`,
      'Support smoke quest-spawned location.',
    );
    questIds.push(spawnedLocationId);
    const locationQuestId = await insertActiveSupportQuest(world, {
      title: `Support Smoke Location Stage Quest ${world.suffix}`,
      startedAtSql: 'now()',
      profileExtra: {
        spawned_entities: {
          [`Support Smoke Quest Spawn Location ${world.suffix}`]:
            spawnedLocationId,
        },
      },
    });
    questIds.push(locationQuestId);
    const locationVerdict = await applyQuestTransitionProposal({
      source: 'quest_watcher',
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: `support-smoke-location-stage-${world.suffix}`,
      questId: locationQuestId,
      expectedCurrentStageId: 'open',
      action: 'advance',
      toStage: 'done',
      reason:
        'support smoke watcher must not canonize entering a spawned location without movement',
      turnToolHistory: [
        {
          name: 'query_entity',
          args: { id_or_name: spawnedLocationId },
          ok: true,
          source: 'ai_sdk',
        },
      ],
    });
    if (
      locationVerdict.applied ||
      locationVerdict.verdict.reason !==
        'spawned_location_stage_without_move_player'
    ) {
      throw new Error(
        `location-stage proposal was not rejected: ${JSON.stringify(locationVerdict)}`,
      );
    }

    const dynamicQuestId = await insertActiveSupportQuest(world, {
      title: `Support Smoke Dynamic Giver Quest ${world.suffix}`,
      startedAtSql: `now() - interval '10 days'`,
      profileExtra: { giver_entity_id: world.npcId },
    });
    questIds.push(dynamicQuestId);
    await query(
      `INSERT INTO tool_invocations
         (session_id, player_id, turn_id, tool_name, args, result, error, duration_ms)
       VALUES ($1, $2, $3, 'advance_quest', $4::jsonb, '{}'::jsonb, NULL, 1)`,
      [
        world.sessionId,
        world.playerId,
        `support-smoke-quest-legacy-ref-${world.suffix}`,
        JSON.stringify({ quest_id: 'legacy-title-ref' }),
      ],
    );
    const pacerTurnId = `support-smoke-quest-pacer-dynamic-${world.suffix}`;
    const [pacerSlot] = await reservePostTurnPresentationSlots(
      {
        sessionId: world.sessionId,
        playerId: world.playerId,
        turnId: pacerTurnId,
      },
      [questPacerHook],
    );
    if (!pacerSlot)
      throw new Error('quest pacer dynamic slot was not reserved');
    const abortController = new AbortController();
    await runPostTurnHookWithPresentation(
      pacerSlot,
      async ({ presentation }) => {
        await questPacerHook.run(
          {
            sessionId: world.sessionId,
            playerId: world.playerId,
            turnId: pacerTurnId,
            signal: abortController.signal,
            presentation,
          },
          {
            text: 'support smoke dynamic giver',
            toolHistory: [],
            narrative: '',
          },
        );
      },
    );
    await waitUntil(
      () =>
        turnEvents(world, pacerTurnId).some(
          (event) => event.event === 'quest_pacer:dead_npc_arc',
        ),
      'quest pacer dynamic giver dead arc SSE',
    );
    const deadArcPayload = turnEvents(world, pacerTurnId)
      .filter((event) => event.event === 'quest_pacer:dead_npc_arc')
      .map((event) => parseEventData(event.data))
      .find((payload) => payload?.['questId'] === dynamicQuestId);
    if (deadArcPayload?.['giverEntityId'] !== world.npcId) {
      throw new Error(
        `dynamic giver id missing from pacer signal: ${JSON.stringify(deadArcPayload)}`,
      );
    }

    const rewardText = `Support smoke numeric reward memory ${world.suffix}`;
    const rewardQuestId = await insertActiveSupportQuest(world, {
      title: `Support Smoke Reward Memory Quest ${world.suffix}`,
      startedAtSql: 'now()',
      profileExtra: {
        rewards: {
          memory: {
            owner_entity_id: world.npcId,
            about_entity_id: world.playerId,
            text: rewardText,
            importance: 0.8,
          },
        },
      },
    });
    questIds.push(rewardQuestId);
    const completeReward = await dispatch(
      'complete_quest',
      {
        quest_id: rewardQuestId,
        player_id: world.playerId,
        outcome: 'completed',
      },
      {
        ...baseCtx(world),
        turnId: `support-smoke-quest-reward-${world.suffix}`,
      },
    );
    if (!completeReward.ok) {
      throw new Error(
        `reward memory quest completion failed: ${completeReward.error}`,
      );
    }
    const memoryCount = await countNpcMemoriesForOwnerAboutWithText({
      ownerEntityId: world.npcId,
      aboutEntityId: world.playerId,
      text: rewardText,
    });
    if (memoryCount !== 1) {
      throw new Error(
        'numeric reward memory refs did not write intended memory',
      );
    }

    return {
      duplicate: duplicateVerdict.verdict.reason,
      stale: staleVerdict.verdict.reason,
      illegal: illegalVerdict.verdict.reason,
      spawnedLocationGuard: locationVerdict.verdict.reason,
      dynamicPacerQuestId: dynamicQuestId,
      rewardQuestId,
    };
  } finally {
    if (questIds.length > 0) {
      await query(
        `DELETE FROM player_quests
          WHERE player_id = $1
            AND quest_entity_id = ANY($2::bigint[])`,
        [world.playerId, questIds],
      ).catch(() => {});
      // ARCH-19 Phase 4 (migration 0124) — support-smoke fixtures
      // are scoped via `cartridge_id`, not the retired
      // `'support-smoke'` tag.
      await query(
        `DELETE FROM entities
          WHERE id = ANY($1::bigint[])
            AND cartridge_id = 'support-smoke'`,
        [questIds],
      ).catch(() => {});
    }
    await query(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb) - 'quest_pacer'
        WHERE entity_id = $1`,
      [world.playerId],
    ).catch(() => {});
  }
}

async function checkTurnIngressQueue(world: SupportWorld): Promise<unknown> {
  const activeBefore = world.session.activeTurn;
  world.session.activeTurn = undefined;
  const barrier = openPresentationBarrier(world.session, {
    turnId: 'support-smoke-queue-blocker',
    pendingVisibleSlots: 1,
    deadlineMs: 30_000,
  });
  try {
    const queued = await enqueueTurn({
      sessionId: world.sessionId,
      playerId: world.playerId,
      text: 'support smoke queued input',
      clientRequestId: `support-smoke-queue-${world.suffix}`,
      visibleAfterTurnId: barrier.turnId,
    });
    const duplicate = await enqueueTurn({
      sessionId: world.sessionId,
      playerId: world.playerId,
      text: 'support smoke duplicate queued input',
      clientRequestId: `support-smoke-queue-${world.suffix}`,
      visibleAfterTurnId: barrier.turnId,
    });
    if (!duplicate.reused || duplicate.row.id !== queued.row.id) {
      throw new Error('duplicate client_request_id enqueued a second turn');
    }
    const chatBefore = await query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n
         FROM chat_messages
        WHERE session_id = $1
          AND payload->>'turn_id' = $2`,
      [world.sessionId, queued.row.turnId],
    );
    if (Number(chatBefore.rows[0]?.n ?? 0) !== 0) {
      throw new Error('queued turn leaked into chat_messages before promotion');
    }
    const blocked = await startNextQueuedTurn(world.session, (row) => ({
      turnId: row.turnId,
      done: Promise.resolve(),
    }));
    if (blocked) {
      throw new Error(
        'queued turn started while presentation barrier was open',
      );
    }
    const snapshot = await listTurnQueueSnapshot(world.sessionId);
    const queuedSnapshot = snapshot.find(
      (row) => row.turnId === queued.row.turnId,
    );
    if (
      !queuedSnapshot ||
      queuedSnapshot.status !== 'queued' ||
      queuedSnapshot.position < 1
    ) {
      throw new Error('queued turn missing from queue snapshot diagnostics');
    }
    closePresentationBarrier(world.session, barrier.id, 'queue_support_smoke');
    const started = await startNextQueuedTurn(world.session, (row) => ({
      turnId: row.turnId,
      done: Promise.resolve(),
    }));
    if (!started || started.row.turnId !== queued.row.turnId) {
      throw new Error('queued turn did not promote after barrier close');
    }
    await started.handle.done;
    await sleep(20);
    const statusRow = await query<{ status: string }>(
      `SELECT status FROM turn_ingress_queue WHERE id = $1`,
      [queued.row.id],
    );
    if (statusRow.rows[0]?.status !== 'done') {
      throw new Error(
        `queued row status was ${statusRow.rows[0]?.status ?? '<missing>'}`,
      );
    }
    const cancelBarrier = openPresentationBarrier(world.session, {
      turnId: 'support-smoke-queue-cancel-blocker',
      pendingVisibleSlots: 1,
      deadlineMs: 30_000,
    });
    let cancelledTurnId = '';
    try {
      const cancellable = await enqueueTurn({
        sessionId: world.sessionId,
        playerId: world.playerId,
        text: 'support smoke cancellable queued input',
        clientRequestId: `support-smoke-cancel-${world.suffix}`,
        visibleAfterTurnId: cancelBarrier.turnId,
      });
      cancelledTurnId = cancellable.row.turnId;
      const cancelled = await cancelQueuedTurn(
        world.sessionId,
        cancellable.row.turnId,
      );
      if (!cancelled) {
        throw new Error('queued turn cancellation returned false');
      }
      const cancelledStatus = await query<{ status: string }>(
        `SELECT status FROM turn_ingress_queue WHERE id = $1`,
        [cancellable.row.id],
      );
      if (cancelledStatus.rows[0]?.status !== 'cancelled') {
        throw new Error('queued turn did not persist cancelled status');
      }
      const cancelledChat = await query<{ n: number | string }>(
        `SELECT COUNT(*)::int AS n
           FROM chat_messages
          WHERE session_id = $1
            AND payload->>'turn_id' = $2`,
        [world.sessionId, cancellable.row.turnId],
      );
      if (Number(cancelledChat.rows[0]?.n ?? 0) !== 0) {
        throw new Error('cancelled queued turn leaked into chat_messages');
      }
    } finally {
      closePresentationBarrier(
        world.session,
        cancelBarrier.id,
        'queue_support_smoke_cancel_cleanup',
      );
    }
    return {
      queueId: queued.row.id,
      turnId: queued.row.turnId,
      initialPosition: queued.position,
      snapshotPosition: queuedSnapshot.position,
      duplicateReused: duplicate.reused,
      cancelledTurnId,
    };
  } finally {
    world.session.activeTurn = activeBefore;
    closePresentationBarrier(
      world.session,
      barrier.id,
      'queue_support_smoke_cleanup',
    );
  }
}

async function checkAffordanceLanguageNeutralContract(
  world: SupportWorld,
): Promise<unknown> {
  const exitId = await insertEntity(
    'location',
    `Support Smoke Exit ${world.suffix}`,
    'Support smoke exit.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify({ exits: [exitId] }), world.locationId],
  );
  const npcId = await insertEntity(
    'person',
    `Support Smoke Affordance NPC ${world.suffix}`,
    'Support smoke affordance NPC.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        home_id: String(world.locationId),
        social_dcs: {
          persuade: { ability: 'CHA', dc: 10 },
          seduce: { ability: 'CHA', dc: 11 },
        },
      }),
      npcId,
    ],
  );
  await insertRuntimeField(npcId, 'current_hp', 'int', 10, 'session');
  const movedNpcId = await insertEntity(
    'person',
    `Support Smoke Moved Affordance NPC ${world.suffix}`,
    'Support smoke NPC present via current_location_id only.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        current_location_id: String(world.locationId),
        social_dcs: {
          persuade: { ability: 'CHA', dc: 10 },
        },
      }),
      movedNpcId,
    ],
  );
  await insertRuntimeField(movedNpcId, 'current_hp', 'int', 10, 'session');
  const unavailableNpcId = await insertEntity(
    'person',
    `Support Smoke Missing Affordance NPC ${world.suffix}`,
    'Support smoke NPC marked missing; must not expose active actions.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        current_location_id: String(world.locationId),
        social_dcs: {
          persuade: { ability: 'CHA', dc: 10 },
        },
      }),
      unavailableNpcId,
    ],
  );
  await insertRuntimeField(
    unavailableNpcId,
    'current_hp',
    'int',
    10,
    'session',
  );
  await insertRuntimeField(
    unavailableNpcId,
    'armor_class',
    'int',
    11,
    'session',
  );
  await query(
    `INSERT INTO actor_statuses
       (player_id, actor_entity_id, status_kind, status_value, intensity, source, metadata)
     VALUES ($1, $2, 'missing', 'left_scene', 1.0, 'support_smoke', '{}'::jsonb)
     ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
       status_value = EXCLUDED.status_value,
       intensity = EXCLUDED.intensity,
       source = EXCLUDED.source,
       updated_at = now()`,
    [world.playerId, unavailableNpcId],
  );
  const movedQuestName = `Support Smoke Moved Giver Quest ${world.suffix}`;
  const movedQuestId = await insertEntity(
    'quest',
    movedQuestName,
    'Support smoke quest offered by an NPC present via current_location_id.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        giver_id: String(movedNpcId),
        stages: [{ id: 'open', title: 'Open' }],
      }),
      movedQuestId,
    ],
  );
  const unavailableQuestName = `Support Smoke Missing Giver Quest ${world.suffix}`;
  const unavailableQuestId = await insertEntity(
    'quest',
    unavailableQuestName,
    'Support smoke quest that must not appear while its giver is missing.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        giver_id: String(unavailableNpcId),
        stages: [{ id: 'open', title: 'Open' }],
      }),
      unavailableQuestId,
    ],
  );
  const itemId = await insertEntity(
    'item',
    `Support Smoke Lever ${world.suffix}`,
    'Support smoke item.',
  );
  await query(`UPDATE entities SET profile = $1::jsonb WHERE id = $2`, [
    JSON.stringify({
      check: { ability: 'DEX', dc: 12, action: 'open' },
    }),
    itemId,
  ]);
  await query(
    `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count)
     VALUES ($1, $2, 1)`,
    [world.locationId, itemId],
  );

  const actions = await buildAffordances(world.playerId);
  const requiredKinds = new Set<AffordanceKind>([
    'item-check',
    'social-persuade',
    'social-seduce',
    'attack',
    'travel',
  ]);
  const relevant = actions.filter((action) => requiredKinds.has(action.kind));
  if (
    !actions.some((action) => action.id === `social:${movedNpcId}:persuade`)
  ) {
    throw new Error(
      `current_location_id-only NPC did not produce social affordance: ${movedNpcId}`,
    );
  }
  const unavailableAction = actions.find(
    (action) => action.entity_id === unavailableNpcId,
  );
  if (unavailableAction) {
    throw new Error(
      `missing NPC still produced active affordance: ${unavailableAction.id}`,
    );
  }
  const playerState = await dispatch(
    'query_player_state',
    { player_id: world.playerId },
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: `support-smoke-current-location-state-${world.suffix}`,
    },
  );
  const peopleHere = Array.isArray(
    (playerState.data as Record<string, unknown> | undefined)?.['people_here'],
  )
    ? ((playerState.data as Record<string, unknown>)['people_here'] as Array<
        Record<string, unknown>
      >)
    : [];
  if (!peopleHere.some((row) => Number(row['id']) === movedNpcId)) {
    throw new Error(
      `query_player_state people_here missed current_location_id NPC: ${movedNpcId}`,
    );
  }
  if (peopleHere.some((row) => Number(row['id']) === unavailableNpcId)) {
    throw new Error(
      `query_player_state people_here included missing NPC: ${unavailableNpcId}`,
    );
  }
  const availableQuests = await renderAvailableQuests(
    world.playerId,
    world.locationId,
    null,
    'en',
  );
  if (!availableQuests.includes(movedQuestName)) {
    throw new Error(
      `available quest context missed current_location_id giver: ${movedQuestId}`,
    );
  }
  if (availableQuests.includes(unavailableQuestName)) {
    throw new Error(
      `available quest context included missing giver: ${unavailableQuestId}`,
    );
  }
  const candidates = await loadPresentNpcCandidates(world.playerId, {
    sessionId: world.sessionId,
  });
  if (candidates.some((candidate) => candidate.id === unavailableNpcId)) {
    throw new Error(
      `dialogue candidates included missing NPC: ${unavailableNpcId}`,
    );
  }
  const seenKinds = new Set(relevant.map((action) => action.kind));
  for (const kind of requiredKinds) {
    if (!seenKinds.has(kind)) {
      throw new Error(`missing affordance kind ${kind}`);
    }
  }
  const proseLeak = relevant.find(
    (action) => typeof action.message === 'string' && action.message.trim(),
  );
  if (proseLeak) {
    throw new Error(`affordance ${proseLeak.id} still exposes prose message`);
  }
  const missingContract = relevant.find(
    (action) => !action.message_key || action.message_vars == null,
  );
  if (missingContract) {
    throw new Error(
      `affordance ${missingContract.id} missing message_key/message_vars`,
    );
  }
  const serialized = JSON.stringify(relevant);
  if (
    /\bI\s+(try|attempt|draw|head|lean|move|enter|watch)\b/i.test(serialized)
  ) {
    throw new Error('affordance contract leaked English player prose');
  }
  return {
    actions: relevant.length,
    kinds: [...seenKinds].sort(),
    currentLocationNpcId: movedNpcId,
    currentLocationQuestId: movedQuestId,
    unavailableNpcId,
    unavailableQuestId,
    messageKeys: relevant.map((action) => action.message_key),
  };
}

async function checkMovementReachabilityContract(
  world: SupportWorld,
): Promise<unknown> {
  const activeBefore = world.session.activeTurn;
  const turnId = `support-smoke-movement-reachability-${world.suffix}`;
  world.session.activeTurn = {
    turnId,
    abortController: new AbortController(),
    startedAt: Date.now(),
    toolHistory: [],
  };
  const originalLocationId = await readPlayerLocation(world.playerId);
  const originalProfileRow = await query<{ profile: unknown }>(
    `SELECT profile FROM entities WHERE id = $1`,
    [originalLocationId],
  );
  const originalLocationProfile = originalProfileRow.rows[0]?.profile ?? {};
  const exitId = await insertEntity(
    'location',
    `Support Smoke Reachable Exit ${world.suffix}`,
    'Support smoke reachable exit.',
  );
  const childId = await insertEntity(
    'location',
    `Support Smoke Reachable Child ${world.suffix}`,
    'Support smoke reachable child.',
  );
  const districtChildId = await insertEntity(
    'district',
    `Support Smoke Reachable District ${world.suffix}`,
    'Support smoke reachable district.',
  );
  const parentId = await insertEntity(
    'location',
    `Support Smoke Reachable Parent ${world.suffix}`,
    'Support smoke reachable parent.',
  );
  const hiddenId = await insertEntity(
    'location',
    `Support Smoke Hidden Target ${world.suffix}`,
    'Support smoke hidden target.',
  );
  const unrelatedId = await insertEntity(
    'location',
    `Support Smoke Unrelated Target ${world.suffix}`,
    'Support smoke unrelated target.',
  );
  const nonPlaceExitId = await insertEntity(
    'item',
    `Support Smoke Bad Exit Item ${world.suffix}`,
    'Support smoke non-place exit fixture.',
  );

  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        exits: [exitId, nonPlaceExitId],
        topology_parent_id: parentId,
      }),
      originalLocationId,
    ],
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify({ topology_parent_id: originalLocationId }), childId],
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({ topology_parent_id: originalLocationId }),
      districtChildId,
    ],
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        topology_parent_id: originalLocationId,
        hidden_until_stage: 'support_reveal',
      }),
      hiddenId,
    ],
  );

  async function resetToOriginal(): Promise<void> {
    await query(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [originalLocationId, world.playerId],
    );
  }

  async function expectMove(
    targetLocationId: number,
    expected: 'ok' | 'reject',
    expectedReason?: string,
  ): Promise<string | null> {
    await resetToOriginal();
    const result = await dispatch(
      'move_player',
      {
        target_location_id: targetLocationId,
        intent_source: 'user_command',
        reason: 'support smoke reachability fixture',
      },
      { ...baseCtx(world), turnId },
    );
    if (expected === 'ok') {
      if (!result.ok) {
        throw new Error(
          `reachable move rejected for ${targetLocationId}: ${JSON.stringify(result)}`,
        );
      }
      return null;
    }
    if (result.ok) {
      throw new Error(`unreachable move succeeded for ${targetLocationId}`);
    }
    const error = result.error ?? '';
    if (expectedReason && !error.includes(expectedReason)) {
      throw new Error(
        `move rejection reason mismatch for ${targetLocationId}: ${JSON.stringify(result)}`,
      );
    }
    return error;
  }

  try {
    const actions = await buildAffordances(world.playerId);
    if (actions.some((action) => action.id === `travel:${nonPlaceExitId}`)) {
      throw new Error(
        `non-place profile.exits target produced travel affordance: ${nonPlaceExitId}`,
      );
    }
    await expectMove(exitId, 'ok');
    await expectMove(childId, 'ok');
    await expectMove(districtChildId, 'ok');
    await expectMove(parentId, 'ok');
    const hidden = await expectMove(hiddenId, 'reject', 'still hidden');
    const unrelated = await expectMove(unrelatedId, 'reject', 'not an exit');
    return {
      exitId,
      childId,
      districtChildId,
      parentId,
      hidden,
      unrelated,
      nonPlaceExitFiltered: nonPlaceExitId,
    };
  } finally {
    await query(`UPDATE entities SET profile = $1::jsonb WHERE id = $2`, [
      JSON.stringify(originalLocationProfile),
      originalLocationId,
    ]);
    await resetToOriginal();
    world.session.activeTurn = activeBefore;
  }
}

async function checkQuestSpawnInitialRevealAndTravelGraph(
  world: SupportWorld,
): Promise<unknown> {
  const title = `Support Smoke Initial Reveal Quest ${world.suffix}`;
  const hiddenLocationName = `Support Smoke Initial Reveal Passage ${world.suffix}`;
  const result = await dispatch(
    'create_quest',
    {
      title,
      summary:
        'Support smoke quest that reveals a spawned passage on its initial stage.',
      giver: world.npcName,
      goal_text:
        'Verify initial-stage quest spawns become visible and reachable.',
      stages: [{ id: 'found', title: 'Found' }],
      tags: [],
      auto_start: true,
      spawn_entities: [
        {
          kind: 'location',
          display_name: hiddenLocationName,
          summary: 'Support smoke passage.',
          tags: [],
          profile: {
            topology_parent_id: world.locationId,
            owner_entity_id: world.npcId,
            access_policy: 'secret',
            access_reason: 'support smoke owner-backed initial reveal fixture',
          },
          hidden_until_stage: 'found',
        },
      ],
    },
    baseCtx(world),
  );
  if (!result.ok) {
    throw new Error(
      `create_quest initial reveal fixture failed: ${result.error}`,
    );
  }
  const data = result.data as Record<string, unknown>;
  const questId = Number(data['quest_id']);
  const spawned = data['spawned'] as Record<string, unknown> | undefined;
  const passageId = Number(spawned?.[hiddenLocationName]);
  if (
    !Number.isInteger(questId) ||
    questId <= 0 ||
    !Number.isInteger(passageId) ||
    passageId <= 0
  ) {
    throw new Error(
      `create_quest did not return quest/spawn ids: ${JSON.stringify(data)}`,
    );
  }

  const passage = await query<{
    profile: Record<string, unknown> | null;
    tags: string[] | null;
  }>(
    `SELECT profile, tags
       FROM entities
      WHERE id = $1`,
    [passageId],
  );
  const profile = passage.rows[0]?.profile ?? {};
  const tags = passage.rows[0]?.tags ?? [];
  if (profile['hidden_until_stage'] != null || tags.includes('hidden')) {
    throw new Error(
      `initial-stage spawned location stayed hidden: ${JSON.stringify(passage.rows[0])}`,
    );
  }
  if (String(profile['source_quest_id'] ?? '') !== String(questId)) {
    throw new Error(
      `spawned location missing source_quest_id: ${JSON.stringify(profile)}`,
    );
  }

  const actions = await buildAffordances(world.playerId);
  const travel = actions.find((action) => action.id === `travel:${passageId}`);
  if (!travel) {
    throw new Error(
      'initial-stage spawned location missing from travel affordances',
    );
  }
  const context = await buildTurnContext(world.sessionId, world.playerId, {
    lang: 'en',
  });
  const serializedContext = `${context.static}\n${context.dynamic}`;
  if (!serializedContext.includes(hiddenLocationName)) {
    throw new Error(
      'initial-stage spawned location missing from broker turn context',
    );
  }
  return { questId, passageId, travelAction: travel.id };
}

async function checkAdventureQueueSeededOracle(
  world: SupportWorld,
): Promise<unknown> {
  const movedNpcId = await insertEntity(
    'person',
    `Support Smoke Adventure Presence NPC ${world.suffix}`,
    'Support smoke NPC included in adventure nearby signature via current_location_id.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({ current_location_id: String(world.locationId) }),
      movedNpcId,
    ],
  );
  const missingNpcId = await insertEntity(
    'person',
    `Support Smoke Missing Adventure NPC ${world.suffix}`,
    'Support smoke NPC that must not seed adventure context while missing.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({ current_location_id: String(world.locationId) }),
      missingNpcId,
    ],
  );
  await query(
    `INSERT INTO actor_statuses
       (player_id, actor_entity_id, status_kind, status_value, intensity, source, metadata)
     VALUES ($1, $2, 'missing', 'left_scene', 1.0, 'support_smoke', '{}'::jsonb)`,
    [world.playerId, missingNpcId],
  );
  const seed = `support-adventure-seed-${world.suffix}`;
  const oracleContext: AdventureTableContext = {
    playerLevel: 2,
    currentLocationId: world.locationId,
    mode: 'travel' as const,
    activeQuestCount: 0,
    recentCombat: false,
    recentDanger: null,
    cooldownKinds: new Set<AdventureKind>(),
  };
  const rollA = rollAdventureOracle({
    seed,
    sequence: 1,
    context: oracleContext,
  });
  const rollB = rollAdventureOracle({
    seed,
    sequence: 1,
    context: oracleContext,
  });
  if (
    rollA.selectedKind !== rollB.selectedKind ||
    rollA.rawRoll !== rollB.rawRoll ||
    rollA.selectionRoll !== rollB.selectionRoll
  ) {
    throw new Error('same seed/context/sequence did not replay');
  }
  const rollC = rollAdventureOracle({
    seed,
    sequence: 2,
    context: oracleContext,
  });
  if (rollC.rawRoll === rollA.rawRoll) {
    throw new Error('different oracle sequence did not advance raw roll');
  }

  const overloaded = rollAdventureOracle({
    seed,
    sequence: 1,
    context: { ...oracleContext, activeQuestCount: 99 },
  });
  if (
    !overloaded.rejected.some(
      (rejection) =>
        rejection.kind === 'quest_complication' &&
        rejection.reason === 'quest_load',
    )
  ) {
    throw new Error('active quest overload did not filter quest-heavy entries');
  }
  const postCombat = rollAdventureOracle({
    seed,
    sequence: 1,
    context: {
      ...oracleContext,
      recentCombat: true,
      recentDanger: 'deadly',
    },
  });
  if (
    !postCombat.rejected.some(
      (rejection) =>
        rejection.kind === 'ambush' && rejection.reason === 'recent_danger',
    )
  ) {
    throw new Error('recent combat did not filter immediate deadly ambush');
  }

  const beforeEntities = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities`,
    [],
  );
  const beforeQuests = await countRows(
    `SELECT COUNT(*)::int AS count FROM player_quests`,
    [],
  );
  const beforeMemories = await countAllNpcMemories();
  const turnId = `support-smoke-adventure-${world.suffix}`;
  const first = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke adventure oracle',
      narrative: 'The road opens into a quiet crosswind.',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!first.queued || first.reused || !first.row || !first.roll) {
    throw new Error('adventure opportunity was not queued');
  }
  const nearbySignature = String(
    first.row.contextSnapshot['nearbyEntitySignature'] ?? '',
  );
  if (!nearbySignature.split(',').includes(String(movedNpcId))) {
    throw new Error(
      `adventure nearby signature missed current_location_id NPC: ${nearbySignature}`,
    );
  }
  if (nearbySignature.split(',').includes(String(missingNpcId))) {
    throw new Error(
      `adventure nearby signature included missing NPC: ${nearbySignature}`,
    );
  }
  const second = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke adventure oracle duplicate',
      narrative: '',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!second.reused || second.row?.id !== first.row.id) {
    throw new Error('adventure queue dedupe did not reuse existing row');
  }

  const queueRows = await listAdventureQueue({
    sessionId: world.sessionId,
    playerId: world.playerId,
    statuses: ['queued'],
    limit: 20,
  });
  if (!queueRows.some((row) => row.id === first.row!.id)) {
    throw new Error('queued adventure row not returned by listAdventureQueue');
  }
  const rollRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM adventure_oracle_rolls
      WHERE adventure_queue_id = $1`,
    [first.row.id],
  );
  if (rollRows !== 1) {
    throw new Error(`expected one oracle roll row, got ${rollRows}`);
  }

  const afterEntities = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities`,
    [],
  );
  const afterQuests = await countRows(
    `SELECT COUNT(*)::int AS count FROM player_quests`,
    [],
  );
  const afterMemories = await countAllNpcMemories();
  if (
    beforeEntities !== afterEntities ||
    beforeQuests !== afterQuests ||
    beforeMemories !== afterMemories
  ) {
    throw new Error('adventure oracle mutated canon state');
  }

  return {
    queueId: first.row.id,
    selectedKind: first.row.adventureKind,
    sequence: first.row.sequence,
    movedNpcId,
    missingNpcId,
    queuedRawRoll: first.roll.rawRoll,
    pureReplayRawRoll: rollB.rawRoll,
    dedupeReused: second.reused,
  };
}

async function checkAdventureMaterializerBlueprint(
  world: SupportWorld,
): Promise<unknown> {
  const seed = 'support-hidden-location-blueprint';
  const context: AdventureTableContext = {
    playerLevel: 2,
    currentLocationId: world.locationId,
    mode: 'travel',
    activeQuestCount: 0,
    recentCombat: false,
    recentDanger: null,
    cooldownKinds: new Set<AdventureKind>(),
  };
  let sequence = 1;
  let selected = rollAdventureOracle({ seed, sequence, context });
  while (selected.selectedKind !== 'hidden_location' && sequence < 100) {
    sequence += 1;
    selected = rollAdventureOracle({ seed, sequence, context });
  }
  if (selected.selectedKind !== 'hidden_location') {
    throw new Error('support fixture could not find hidden_location sequence');
  }

  const turnId = `support-smoke-materializer-${world.suffix}`;
  const queued = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed,
      sequence,
      visible: false,
      language: 'ru',
    },
    {
      text: 'проверка материализатора приключений',
      narrative: 'За переулком видна едва заметная боковая тропа.',
      toolHistory: [],
      mode: 'travel',
      language: 'ru',
    },
  );
  if (!queued.row) throw new Error('materializer fixture did not queue row');
  if (queued.row.contextSnapshot['language'] !== 'ru') {
    throw new Error('adventure queue did not persist explicit player language');
  }
  const stewardTurnId = `support-smoke-steward-language-${world.suffix}`;
  await query(
    `INSERT INTO turn_ingress_queue
       (session_id, player_id, turn_id, status, text, queue_index, language)
     VALUES ($1, $2, $3, 'done', $4, 900002, 'ru')`,
    [
      world.sessionId,
      world.playerId,
      stewardTurnId,
      'I ask for work in English.',
    ],
  );
  const stewardQuest = await dispatch(
    'create_quest',
    {
      title: `Проверка языка ${world.suffix}`,
      summary:
        'Проверка принимает русский текст, когда язык интерфейса выбран явно.',
      giver: world.npcName,
      goal_text:
        'Проверить, что выбранный язык сильнее латинского текста команды.',
      stages: [{ id: 'open', title: 'Открыто' }],
      auto_start: false,
      tags: ['language'],
    },
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: stewardTurnId,
    },
  );
  if (!stewardQuest.ok) {
    throw new Error(
      `cartridge steward ignored explicit turn language: ${JSON.stringify(stewardQuest)}`,
    );
  }
  const staleQueue = await query<{ id: number }>(
    `INSERT INTO adventure_queue
       (session_id, player_id, turn_id, status, source, adventure_kind,
        priority, seed, sequence, table_id, roll_result, context_snapshot, updated_at)
     VALUES ($1, $2, $3, 'materializing', 'manual_debug', 'exploration_clue',
        10, $4, 1, $5, '{}'::jsonb, '{}'::jsonb, now() - interval '10 minutes')
     RETURNING id`,
    [
      world.sessionId,
      world.playerId,
      `support-smoke-stale-adventure-${world.suffix}`,
      `support-stale-adventure-${world.suffix}`,
      ADVENTURE_TABLE_ID,
    ],
  );
  const recoveredStale = await recoverAbandonedMaterializingAdventures({
    sessionId: world.sessionId,
    playerId: world.playerId,
    olderThanMs: 60_000,
    reason: 'support smoke stale materializer',
  });
  const recoveredRow = await query<{ status: string; recovered: unknown }>(
    `SELECT status, context_snapshot->'materializer_recovered' AS recovered
       FROM adventure_queue
      WHERE id = $1`,
    [staleQueue.rows[0]!.id],
  );
  if (
    recoveredStale < 1 ||
    recoveredRow.rows[0]?.status !== 'queued' ||
    recoveredRow.rows[0]?.recovered == null
  ) {
    throw new Error('stale materializing adventure was not recovered');
  }
  const materializerInput = await buildMaterializerInput(queued.row);
  if (materializerInput.locationContext?.id !== world.locationId) {
    throw new Error('materializer input missing current location context');
  }
  const movedNpcId = await insertEntity(
    'person',
    `Support Smoke Materializer Presence NPC ${world.suffix}`,
    'Support smoke NPC visible to materializer via current_location_id.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({ current_location_id: String(world.locationId) }),
      movedNpcId,
    ],
  );
  const missingNpcId = await insertEntity(
    'person',
    `Support Smoke Materializer Missing NPC ${world.suffix}`,
    'Support smoke missing NPC excluded from materializer nearby input.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({ current_location_id: String(world.locationId) }),
      missingNpcId,
    ],
  );
  await query(
    `INSERT INTO actor_statuses
       (player_id, actor_entity_id, status_kind, status_value, intensity, source, metadata)
     VALUES ($1, $2, 'missing', 'left_scene', 1.0, 'support_smoke', '{}'::jsonb)`,
    [world.playerId, missingNpcId],
  );
  const materializerInputAfterMove = await buildMaterializerInput(queued.row);
  const movedNearby = materializerInputAfterMove.nearby.find(
    (entity) => entity.id === movedNpcId,
  );
  if (!movedNearby?.reachable) {
    throw new Error(
      'materializer input missed NPC present via current_location_id',
    );
  }
  if (
    materializerInputAfterMove.nearby.some(
      (entity) => entity.id === missingNpcId,
    )
  ) {
    throw new Error('materializer input included missing NPC');
  }
  const nearbyNpc = materializerInput.nearby.find(
    (entity) => entity.id === world.npcId,
  );
  if (!nearbyNpc?.reachable) {
    throw new Error('materializer input missing reachable nearby NPC metadata');
  }
  if (
    !materializerInput.relationships.some((row) => row.npcId === world.npcId)
  ) {
    throw new Error('materializer input missing nearby relationship evidence');
  }
  if (
    ADVENTURE_MATERIALIZER_SLOT_DEADLINE_MS -
      ADVENTURE_MATERIALIZER_SPECIALIST_TIMEOUT_MS <
    1500
  ) {
    throw new Error(
      'adventure materializer fallback has no guaranteed slot budget before presentation expiry',
    );
  }
  const localFallback = buildFallbackSituation(
    { ...materializerInput, activeQuests: [] },
    'support_smoke_location_fallback',
  );
  if (!localFallback) {
    throw new Error(
      'materializer fallback did not create a location-anchored situation with local evidence',
    );
  }
  if (
    localFallback.questProjection?.mode !== 'create_new' ||
    localFallback.questProjection.source !== 'location_situation' ||
    localFallback.questProjection.sourceEntityId !== world.locationId
  ) {
    throw new Error(
      'materializer location fallback did not stay anchored to current location',
    );
  }
  const localFallbackSituationVerdict = await validateSituationBlueprint({
    queue: queued.row,
    situation: localFallback,
    playerId: world.playerId,
  });
  if (
    !localFallbackSituationVerdict.ok ||
    !localFallbackSituationVerdict.situation
  ) {
    throw new Error(
      `materializer location fallback situation rejected: ${localFallbackSituationVerdict.reason} ${localFallbackSituationVerdict.message ?? ''}`,
    );
  }
  const localFallbackProjectionVerdict = await validateAdventureBlueprint({
    queue: queued.row,
    blueprint: projectSituationToAdventureBlueprint({
      queue: queued.row,
      situation: localFallbackSituationVerdict.situation,
    }),
    playerId: world.playerId,
  });
  if (!localFallbackProjectionVerdict.ok) {
    throw new Error(
      `materializer location fallback projection rejected: ${localFallbackProjectionVerdict.reason} ${localFallbackProjectionVerdict.message ?? ''}`,
    );
  }
  const barrenFallback = buildFallbackSituation(
    {
      ...materializerInput,
      activeQuests: [],
      relationships: [],
      relevantMemories: [],
      recentNarrative: '',
      queue: {
        ...materializerInput.queue,
        contextSnapshot: {
          ...materializerInput.queue.contextSnapshot,
          turnTextPreview: '',
          narrativePreview: '',
        },
      },
      locationContext: materializerInput.locationContext
        ? { ...materializerInput.locationContext, exits: [] }
        : null,
      nearby: materializerInput.locationContext
        ? [
            {
              id: materializerInput.locationContext.id,
              kind: materializerInput.locationContext.kind,
              displayName: materializerInput.locationContext.displayName,
              summary: materializerInput.locationContext.summary,
              locationId: null,
              powerCenterId: null,
              homeId: null,
              ownerEntityId: materializerInput.locationContext.ownerEntityId,
              topologyParentId:
                materializerInput.locationContext.topologyParentId,
              accessPolicy: materializerInput.locationContext.accessPolicy,
              accessReason: materializerInput.locationContext.accessReason,
              hiddenUntilStage:
                materializerInput.locationContext.hiddenUntilStage,
              reachable: true,
            },
          ]
        : [],
    },
    'support_smoke_barren_location_fallback',
  );
  if (barrenFallback !== null) {
    throw new Error(
      'materializer fallback created content for a barren location without scene evidence',
    );
  }
  const explicitEnglishPack = fallbackTextsForMaterializerInput({
    queue: {
      id: queued.row.id,
      contextSnapshot: {
        language: 'en',
        turnTextPreview: 'игрок пишет на другом языке',
        narrativePreview: 'сцена тоже может быть не на английском',
      },
    },
    recentNarrative: 'русский текст не должен перебить выбранный английский',
  });
  const explicitEnglishTitle = explicitEnglishPack.title(
    queued.row.adventureKind,
    'Anchor',
  );
  if (detectScripts(explicitEnglishTitle).dominantScript !== 'latin') {
    throw new Error('explicit English language did not override prose script');
  }
  const explicitUkrainianPack = fallbackTextsForMaterializerInput({
    queue: {
      id: queued.row.id,
      contextSnapshot: {
        language: 'uk',
        turnTextPreview:
          'русский текст не должен превращать украинский выбор в русский',
      },
    },
    recentNarrative: 'русская сцена не должна перебить выбранный украинский',
  });
  const explicitUkrainianTitle = explicitUkrainianPack.title(
    'exploration_clue',
    'Anchor',
  );
  if (!explicitUkrainianTitle.includes('Зачіпка')) {
    throw new Error('explicit Ukrainian language fell back to Russian text');
  }
  const bridgeQuestId = await insertGuardrailQuest(world, {
    title: `Support Smoke Bridge Quest ${world.suffix}`,
    rewardXp: 0,
  });
  const bridgeInput = {
    ...materializerInput,
    queue: {
      ...materializerInput.queue,
      adventureKind: 'quest_complication' as AdventureKind,
    },
    activeQuests: [
      {
        id: bridgeQuestId,
        title: `Support Smoke Bridge Quest ${world.suffix}`,
        summary: 'Support smoke existing quest bridge.',
        currentStageId: 'open',
        tags: ['quest'],
        stages: [
          { id: 'open', title: 'Open', next_stage: 'done' },
          { id: 'done', title: 'Done' },
        ],
      },
    ],
  };
  const fallbackGeneratedQuest = buildFallbackSituation(
    {
      ...bridgeInput,
      activeQuests: [
        {
          ...bridgeInput.activeQuests[0]!,
          tags: ['quest', 'materializer-fallback'],
        },
      ],
    },
    'support_smoke_fallback_generated_quest',
  );
  if (fallbackGeneratedQuest !== null) {
    throw new Error(
      'materializer fallback bridged to a materializer-fallback quest',
    );
  }
  const fallbackSituation = buildFallbackSituation(
    bridgeInput,
    'support_smoke_fallback',
  );
  if (!fallbackSituation) {
    throw new Error(
      'materializer fallback did not bridge to a real existing quest',
    );
  }
  const bridgeQueue = {
    ...queued.row,
    adventureKind: 'quest_complication' as AdventureKind,
  };
  if (
    fallbackSituation.questProjection?.mode !== 'attach_existing' ||
    fallbackSituation.questProjection.existingQuestId !== bridgeQuestId
  ) {
    throw new Error(
      'materializer fallback did not attach to the existing quest',
    );
  }
  const fallbackSituationVerdict = await validateSituationBlueprint({
    queue: bridgeQueue,
    situation: fallbackSituation,
    playerId: world.playerId,
  });
  if (!fallbackSituationVerdict.ok || !fallbackSituationVerdict.situation) {
    throw new Error(
      `materializer fallback situation rejected: ${fallbackSituationVerdict.reason} ${fallbackSituationVerdict.message ?? ''}`,
    );
  }
  const fallbackProjectionVerdict = await validateAdventureBlueprint({
    queue: bridgeQueue,
    blueprint: projectSituationToAdventureBlueprint({
      queue: bridgeQueue,
      situation: fallbackSituationVerdict.situation,
    }),
    playerId: world.playerId,
  });
  if (!fallbackProjectionVerdict.ok) {
    throw new Error(
      `materializer fallback projection rejected: ${fallbackProjectionVerdict.reason} ${fallbackProjectionVerdict.message ?? ''}`,
    );
  }

  const hiddenLocationName = `Support Smoke Hidden Spur ${world.suffix}`;
  const blueprint: AdventureBlueprint = {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: queued.row.id,
    adventureKind: queued.row.adventureKind,
    title: 'Скрытая тропа за переулком',
    summary:
      'Скрытый путь можно раскрыть без преждевременного изменения канона.',
    playerFacingHook: `Полускрытая метка указывает на ${hiddenLocationName}, но путь останется недоступен, пока след не будет доказан.`,
    danger: 'risky',
    suggestedQuest: {
      title: 'Найти скрытую тропу',
      summary:
        'Проследить за едва заметной меткой и подтвердить, куда ведет скрытый путь.',
      goal_text: 'Найти метку, которая раскрывает скрытый путь за переулком.',
      stages: [
        { id: 'open', title: 'Найти метку', next_stage: 'reveal_spur' },
        { id: 'reveal_spur', title: 'Раскрыть скрытую тропу' },
      ],
      tags: ['hidden-location'],
      spawn_entities: [
        {
          kind: 'location',
          display_name: hiddenLocationName,
          summary:
            'A hidden support-smoke location created through create_quest.',
          tags: [],
          profile: {
            support_smoke: true,
            topology_parent_id: world.locationId,
            owner_entity_id: world.npcId,
            access_policy: 'public',
            access_reason:
              'the support archivist reveals the marker before the hidden spur exists in play',
          },
          hidden_until_stage: 'reveal_spur',
        },
      ],
    },
  };

  const verdict = await validateAdventureBlueprint({
    queue: queued.row,
    blueprint,
    playerId: world.playerId,
  });
  if (!verdict.ok) {
    throw new Error(
      `valid blueprint rejected: ${verdict.reason} ${verdict.message ?? ''}`,
    );
  }

  const existingName = `Support Smoke Existing Duplicate ${world.suffix}`;
  await insertEntity(
    'location',
    existingName,
    'Existing duplicate for arbiter.',
  );
  const duplicateVerdict = await validateAdventureBlueprint({
    queue: queued.row,
    playerId: world.playerId,
    blueprint: {
      ...blueprint,
      suggestedQuest: {
        ...blueprint.suggestedQuest!,
        spawn_entities: [
          {
            kind: 'location',
            display_name: existingName,
            summary: 'Duplicate location.',
            hidden_until_stage: 'reveal_spur',
          },
        ],
      },
    },
  });
  if (
    duplicateVerdict.ok ||
    duplicateVerdict.reason !== 'duplicate_entity_name'
  ) {
    throw new Error('duplicate blueprint was not rejected');
  }

  const itemVerdict = await validateAdventureBlueprint({
    queue: queued.row,
    playerId: world.playerId,
    blueprint: {
      ...blueprint,
      suggestedQuest: undefined,
      itemPlacements: [
        {
          itemDisplayName: 'Support Smoke Loot',
          holderEntityId: world.playerId,
          count: 1,
        },
      ],
    },
  });
  if (itemVerdict.ok || itemVerdict.reason !== 'item_granted_to_player') {
    throw new Error('direct player item grant was not rejected');
  }

  const ambushVerdict = await validateAdventureBlueprint({
    queue: queued.row,
    playerId: world.playerId,
    blueprint: {
      ...blueprint,
      danger: 'deadly',
      suggestedQuest: undefined,
      encounterPlan: {
        encounterType: 'ambush',
        budget: 'medium',
        requiredVisibleRoll: false,
        enemies: [
          { display_name: 'Support Smoke Bandit', role: 'raider', count: 2 },
        ],
      },
    },
  });
  if (
    ambushVerdict.ok ||
    ambushVerdict.reason !== 'ambush_without_visible_roll'
  ) {
    throw new Error('ambush without visible roll was not rejected');
  }

  await markAdventureReady(queued.row.id, blueprint);
  const beforeEntities = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities`,
    [],
  );
  const applied = await applyReadyAdventureBlueprint(queued.row.id, {
    sessionId: world.sessionId,
    playerId: world.playerId,
    turnId,
    signal: world.session.activeTurn?.abortController.signal,
  });
  if (!applied.ok) {
    throw new Error(
      `ready blueprint did not apply: ${applied.reason} ${applied.message ?? ''}`,
    );
  }
  const afterEntities = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities`,
    [],
  );
  if (afterEntities <= beforeEntities) {
    throw new Error('applying ready quest blueprint did not create entities');
  }
  const acceptedRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM adventure_queue
      WHERE id = $1
        AND status = 'accepted'`,
    [queued.row.id],
  );
  if (acceptedRows !== 1) {
    throw new Error('applied blueprint did not mark queue accepted');
  }
  const createdQuestId =
    applied.questResult &&
    typeof applied.questResult === 'object' &&
    !Array.isArray(applied.questResult)
      ? Number((applied.questResult as Record<string, unknown>)['quest_id'])
      : NaN;
  if (!Number.isFinite(createdQuestId)) {
    throw new Error('create_quest result missing quest_id');
  }

  return {
    queueId: queued.row.id,
    questId: createdQuestId,
    materializerInput: {
      locationContext: materializerInput.locationContext.displayName,
      nearby: materializerInput.nearby.length,
      relationships: materializerInput.relationships.length,
      activeSituations: materializerInput.activeSituations.length,
    },
    duplicateReason: duplicateVerdict.reason,
    itemReason: itemVerdict.reason,
    ambushReason: ambushVerdict.reason,
  };
}

async function checkScenarioIntegrityArbiter(
  world: SupportWorld,
): Promise<unknown> {
  const queued = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: `support-smoke-scenario-integrity-${world.suffix}`,
      source: 'manual_debug',
      mode: 'travel',
      seed: `support-scenario-integrity-${world.suffix}`,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke scenario integrity',
      narrative: 'A locked staff door has an owner, a reason, and clues.',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!queued.row) throw new Error('scenario integrity fixture did not queue');
  const queue = {
    ...queued.row,
    adventureKind: 'hidden_location' as AdventureKind,
  };
  const hiddenName = `Support Smoke Staff Archive ${world.suffix}`;
  const valid: SituationBlueprint = {
    schemaVersion: SITUATION_BLUEPRINT_SCHEMA_VERSION,
    queueId: queue.id,
    pressureType: 'location_discovery',
    proximity: 'nearby_visible',
    danger: 'risky',
    causeSources: [
      {
        kind: 'entity',
        id: world.npcId,
        claim: 'The present archivist controls access to a staff archive.',
      },
    ],
    actors: [
      {
        entityId: world.npcId,
        role: 'archive owner',
        motive:
          'protect records while testing whether the player is trustworthy',
        knowledgeSource: 'owns the archive and keeps the key',
      },
    ],
    locations: [
      {
        proposedName: hiddenName,
        topologyParentId: world.locationId,
        ownerEntityId: world.npcId,
        accessPolicy: 'staff_only',
        accessReason:
          'the archivist offers supervised access after the player agrees to help',
        whyHere: 'the archive is a staff room inside the current location',
      },
    ],
    secrets: [
      {
        text: 'The archive exists behind a staff-marked door.',
        knownByEntityIds: [world.npcId],
        clues: [
          {
            carrier: 'npc',
            carrierEntityId: world.npcId,
            clueText: 'The archivist mentions the staff-marked door.',
          },
          {
            carrier: 'location',
            carrierEntityId: world.locationId,
            clueText: 'A worn threshold shows staff traffic.',
          },
          {
            carrier: 'event',
            clueText: 'A key-ring sound comes from the owner before the offer.',
          },
        ],
      },
    ],
    forbiddenMoves: [
      'Do not claim the archive is public.',
      'Do not place another NPC stash here without provenance.',
    ],
    projectedHook: {
      title: `Staff Archive Lead ${world.suffix}`,
      playerFacingHook: `The staff-marked door near @${world.locationName} points toward @${hiddenName} only if the archivist grants access.`,
      acceptCondition:
        'Accept the archivist offer and investigate the staff archive.',
    },
    questProjection: {
      source: 'npc_giver',
      giverEntityId: world.npcId,
      goalText: `Gain permission to inspect ${hiddenName}.`,
      stages: [
        {
          id: 'ask_owner',
          title: 'Ask the owner',
          next_stage: 'inspect_archive',
        },
        { id: 'inspect_archive', title: 'Inspect the archive' },
      ],
      tags: ['scenario-integrity'],
    },
  };

  const validVerdict = await validateSituationBlueprint({
    queue,
    situation: valid,
    playerId: world.playerId,
  });
  if (!validVerdict.ok || !validVerdict.situation) {
    throw new Error(
      `valid situation rejected: ${validVerdict.reason} ${validVerdict.message ?? ''}`,
    );
  }
  const looseModelVerdict = await validateSituationBlueprint({
    queue,
    playerId: world.playerId,
    situation: {
      ...valid,
      causeSources: [
        {
          kind: 'location',
          id: world.locationId,
          claim: 'The current location contains a staff-marked lead.',
        },
      ],
      items: [
        {
          proposedName: `Support Smoke Null-Optional Item ${world.suffix}`,
          holderEntityId: world.npcId,
          ownerEntityId: null,
          count: 1,
          provenance: 'The archivist placed it near the archive as a clue.',
          hiddenUntilStage: null,
        },
      ],
      questProjection: {
        ...valid.questProjection!,
        stages: [
          {
            id: 'ask_owner',
            title: 'Ask the owner',
            next_stage: 'inspect_archive',
          },
          {
            id: 'inspect_archive',
            title: 'Inspect the archive',
            next_stage: '',
          },
        ],
      },
    },
  });
  if (!looseModelVerdict.ok || !looseModelVerdict.situation) {
    throw new Error(
      `loose model situation was not normalized: ${looseModelVerdict.reason} ${looseModelVerdict.message ?? ''}`,
    );
  }
  if (looseModelVerdict.situation.causeSources[0]?.kind !== 'entity') {
    throw new Error('location cause kind was not normalized to entity');
  }
  if (looseModelVerdict.situation.items?.[0]?.ownerEntityId != null) {
    throw new Error('null optional item owner was not normalized away');
  }
  if (
    looseModelVerdict.situation.questProjection?.stages?.[1]?.next_stage != null
  ) {
    throw new Error('blank final next_stage was not normalized away');
  }
  const looseProjectionVerdict = await validateAdventureBlueprint({
    queue,
    blueprint: projectSituationToAdventureBlueprint({
      queue,
      situation: looseModelVerdict.situation,
    }),
    playerId: world.playerId,
  });
  if (!looseProjectionVerdict.ok) {
    throw new Error(
      `normalized situation projection rejected: ${looseProjectionVerdict.reason} ${looseProjectionVerdict.message ?? ''}`,
    );
  }
  const projected = projectSituationToAdventureBlueprint({
    queue,
    situation: validVerdict.situation,
  });
  const projectedVerdict = await validateAdventureBlueprint({
    queue,
    blueprint: projected,
    playerId: world.playerId,
  });
  if (!projectedVerdict.ok) {
    throw new Error(
      `projected adventure rejected: ${projectedVerdict.reason} ${projectedVerdict.message ?? ''}`,
    );
  }
  const missingTopologyBlueprintVerdict = await validateAdventureBlueprint({
    queue,
    playerId: world.playerId,
    blueprint: {
      ...projected,
      suggestedQuest: {
        ...projected.suggestedQuest!,
        spawn_entities: [
          {
            kind: 'location',
            display_name: `Support Smoke Unsupported Hidden Room ${world.suffix}`,
            summary: 'Hidden location without topology must be rejected.',
            hidden_until_stage: 'inspect_archive',
          },
        ],
      },
    },
  });
  if (
    missingTopologyBlueprintVerdict.ok ||
    missingTopologyBlueprintVerdict.reason !== 'unsupported_world_fact' ||
    !missingTopologyBlueprintVerdict.message?.includes(
      'location_spawn_missing_topology',
    )
  ) {
    throw new Error(
      'hidden location without topology was not rejected by adventure blueprint guard',
    );
  }

  const outsiderId = await insertEntity(
    'person',
    `Support Smoke Outsider ${world.suffix}`,
    'Support smoke outsider who cannot own the archive.',
  );
  await query(
    `UPDATE entities SET profile = jsonb_build_object('home_id', $1::text)
      WHERE id = $2`,
    [world.locationId, outsiderId],
  );
  const ownerMismatchVerdict = await validateAdventureBlueprint({
    queue,
    playerId: world.playerId,
    blueprint: {
      ...projected,
      suggestedQuest: {
        ...projected.suggestedQuest!,
        spawn_entities: [
          {
            kind: 'location',
            display_name: `Support Smoke Stolen Staff Room ${world.suffix}`,
            summary: 'Hidden room claimed by the wrong owner.',
            profile: {
              topology_parent_id: world.locationId,
              owner_entity_id: outsiderId,
              access_policy: 'secret',
              access_reason:
                'the outsider claims access without the location owner',
            },
            hidden_until_stage: 'inspect_archive',
          },
        ],
      },
    },
  });
  if (
    ownerMismatchVerdict.ok ||
    ownerMismatchVerdict.reason !== 'unsupported_world_fact' ||
    !ownerMismatchVerdict.message?.includes('private_location_owner_mismatch')
  ) {
    throw new Error('private location under another owner was not rejected');
  }

  const hiddenItemVerdict = await validateAdventureBlueprint({
    queue,
    playerId: world.playerId,
    blueprint: {
      ...projected,
      suggestedQuest: {
        ...projected.suggestedQuest!,
        spawn_entities: [
          {
            kind: 'item',
            display_name: `Support Smoke Unsupported Hidden Stash ${world.suffix}`,
            summary: 'Hidden item without holder or provenance.',
            hidden_until_stage: 'inspect_archive',
          },
        ],
      },
    },
  });
  if (
    hiddenItemVerdict.ok ||
    hiddenItemVerdict.reason !== 'unsupported_world_fact' ||
    !hiddenItemVerdict.message?.includes('hidden_item_missing_holder')
  ) {
    throw new Error('hidden item without holder/provenance was not rejected');
  }
  const hiddenItemNoProvenanceVerdict = await validateAdventureBlueprint({
    queue,
    playerId: world.playerId,
    blueprint: {
      ...projected,
      suggestedQuest: {
        ...projected.suggestedQuest!,
        spawn_entities: [
          {
            kind: 'item',
            display_name: `Support Smoke Unprovenanced Stash ${world.suffix}`,
            summary: 'Hidden item with holder but no provenance.',
            profile: { holder_entity_id: world.locationId },
            hidden_until_stage: 'inspect_archive',
          },
        ],
      },
    },
  });
  if (
    hiddenItemNoProvenanceVerdict.ok ||
    hiddenItemNoProvenanceVerdict.reason !== 'unsupported_world_fact' ||
    !hiddenItemNoProvenanceVerdict.message?.includes(
      'hidden_item_missing_provenance',
    )
  ) {
    throw new Error('hidden item without provenance was not rejected');
  }

  const missingOwnerVerdict = await validateSituationBlueprint({
    queue,
    playerId: world.playerId,
    situation: {
      ...valid,
      locations: [
        {
          ...valid.locations![0]!,
          ownerEntityId: undefined,
        },
      ],
    },
  });
  if (
    missingOwnerVerdict.ok ||
    missingOwnerVerdict.reason !== 'missing_location_owner'
  ) {
    throw new Error('private location without owner was not rejected');
  }

  const directItemVerdict = await validateSituationBlueprint({
    queue,
    playerId: world.playerId,
    situation: {
      ...valid,
      items: [
        {
          proposedName: `Support Smoke Unsupported Stash ${world.suffix}`,
          holderEntityId: world.playerId,
          ownerEntityId: world.npcId,
          count: 1,
          provenance: 'The owner deliberately placed it here.',
        },
      ],
    },
  });
  if (
    directItemVerdict.ok ||
    directItemVerdict.reason !== 'unsupported_item_provenance'
  ) {
    throw new Error('direct player item situation was not rejected');
  }

  const thinClueVerdict = await validateSituationBlueprint({
    queue,
    playerId: world.playerId,
    situation: {
      ...valid,
      secrets: [
        {
          ...valid.secrets![0]!,
          clues: [valid.secrets![0]!.clues[0]!],
        },
      ],
    },
  });
  if (thinClueVerdict.ok || thinClueVerdict.reason !== 'missing_clue_route') {
    throw new Error('thin clue route was not rejected');
  }

  const unsupportedKnowledgeVerdict = await validateSituationBlueprint({
    queue,
    playerId: world.playerId,
    situation: {
      ...valid,
      secrets: [
        {
          ...valid.secrets![0]!,
          knownByEntityIds: [world.playerId],
        },
      ],
    },
  });
  if (
    unsupportedKnowledgeVerdict.ok ||
    unsupportedKnowledgeVerdict.reason !== 'unsupported_npc_knowledge'
  ) {
    throw new Error('unsupported secret knower was not rejected');
  }

  const bridgeResult = await checkExistingQuestBridge(world);

  return {
    queueId: queue.id,
    projectedKind: projected.adventureKind,
    missingOwnerReason: missingOwnerVerdict.reason,
    itemReason: directItemVerdict.reason,
    clueReason: thinClueVerdict.reason,
    knowledgeReason: unsupportedKnowledgeVerdict.reason,
    missingTopologyBlueprintReason: missingTopologyBlueprintVerdict.reason,
    ownerMismatchBlueprintReason: ownerMismatchVerdict.reason,
    hiddenItemBlueprintReason: hiddenItemVerdict.reason,
    hiddenItemProvenanceReason: hiddenItemNoProvenanceVerdict.reason,
    bridge: bridgeResult,
  };
}

async function checkExistingQuestBridge(world: SupportWorld): Promise<unknown> {
  const existingQuestName = `Support Smoke Existing Chain ${world.suffix}`;
  const existingQuest = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'quest', $1, $2, $3::jsonb,
       ARRAY['cartridge'],
       'support-smoke', false
     )
     RETURNING id`,
    [
      existingQuestName,
      'Existing quest chain that situation generation must attach to, not duplicate.',
      JSON.stringify({
        stages: [
          { id: 'open', title: 'Open lead', next_stage: 'complication' },
          { id: 'complication', title: 'Complication' },
        ],
      }),
    ],
  );
  const existingQuestId = Number(existingQuest.rows[0]!.id);
  const bridgeTurnId = `support-smoke-existing-quest-bridge-${world.suffix}`;
  const bridgeSeed = `support-existing-quest-bridge-${world.suffix}`;
  const insertedQueue = await query<{
    id: number | string;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO adventure_queue
       (session_id, player_id, turn_id, status, source, adventure_kind,
        priority, seed, sequence, table_id, roll_result, context_snapshot,
        dedupe_key, available_after_turn_id)
     VALUES ($1, $2, $3, 'queued', 'manual_debug', 'quest_complication',
             50, $4, 1, $5, $6::jsonb, $7::jsonb,
             $8, $3)
     RETURNING id, created_at::text AS created_at, updated_at::text AS updated_at`,
    [
      world.sessionId,
      world.playerId,
      bridgeTurnId,
      bridgeSeed,
      ADVENTURE_TABLE_ID,
      JSON.stringify({
        tableId: ADVENTURE_TABLE_ID,
        seed: bridgeSeed,
        sequence: 1,
        selectedKind: 'quest_complication',
        fixture: 'existing_quest_bridge',
      }),
      JSON.stringify({
        mode: 'travel',
        currentLocationId: world.locationId,
        activeQuestCount: 1,
        turnTextPreview: 'support smoke existing quest bridge',
      }),
      `manual_debug:${bridgeTurnId}:quest_complication:${world.locationId}`,
    ],
  );
  const inserted = insertedQueue.rows[0];
  if (!inserted) throw new Error('existing quest bridge did not queue');
  const queue: AdventureQueueRow = {
    id: Number(inserted.id),
    sessionId: world.sessionId,
    playerId: world.playerId,
    turnId: bridgeTurnId,
    status: 'queued',
    source: 'manual_debug',
    adventureKind: 'quest_complication' as AdventureKind,
    priority: 50,
    seed: bridgeSeed,
    sequence: 1,
    tableId: ADVENTURE_TABLE_ID,
    rollResult: {
      tableId: ADVENTURE_TABLE_ID,
      seed: bridgeSeed,
      sequence: 1,
      selectedKind: 'quest_complication',
      fixture: 'existing_quest_bridge',
    },
    contextSnapshot: {
      mode: 'travel',
      currentLocationId: world.locationId,
      activeQuestCount: 1,
      turnTextPreview: 'support smoke existing quest bridge',
    },
    blueprint: null,
    dedupeKey: `manual_debug:${bridgeTurnId}:quest_complication:${world.locationId}`,
    availableAfterTurnId: bridgeTurnId,
    createdAt: inserted.created_at,
    updatedAt: inserted.updated_at,
  };
  const sideRoomName = `Support Smoke Linked Side Room ${world.suffix}`;
  const situation: SituationBlueprint = {
    schemaVersion: SITUATION_BLUEPRINT_SCHEMA_VERSION,
    queueId: queue.id,
    pressureType: 'quest_complication',
    proximity: 'caused_by_player',
    danger: 'safe',
    causeSources: [
      {
        kind: 'quest',
        id: existingQuestId,
        claim: 'The existing quest chain has room for a side complication.',
      },
    ],
    locations: [
      {
        proposedName: sideRoomName,
        topologyParentId: world.locationId,
        ownerEntityId: world.npcId,
        accessPolicy: 'public',
        accessReason:
          'the existing quest lead reveals supervised access to the side room',
        whyHere:
          'A side room near the existing quest lead can hold the complication.',
        hiddenUntilStage: 'complication',
      },
    ],
    clocks: [
      {
        key: `support_bridge_clock_${world.suffix}`,
        label: 'Existing quest bridge pressure',
        segments: 4,
        filled: 1,
        impulse: 'The side lead becomes more urgent if ignored.',
        tickOn: ['player ignores the side lead'],
      },
    ],
    projectedHook: {
      title: `Existing Quest Bridge ${world.suffix}`,
      playerFacingHook: `A side lead connects to the existing quest "${existingQuestName}" without creating a duplicate quest.`,
      acceptCondition: 'Attach this side lead to the existing quest chain.',
    },
    questProjection: {
      mode: 'attach_existing',
      existingQuestId,
      source: 'player_goal',
      bridgeSummary: 'Attach side lead to existing quest chain.',
      goalText: 'Follow the side lead as part of the existing quest chain.',
      tags: ['existing-quest-bridge'],
    },
  };
  const verdict = await validateSituationBlueprint({
    queue,
    situation,
    playerId: world.playerId,
  });
  if (!verdict.ok || !verdict.situation) {
    throw new Error(
      `bridge situation rejected: ${verdict.reason} ${verdict.message ?? ''}`,
    );
  }
  const projected = projectSituationToAdventureBlueprint({
    queue,
    situation: verdict.situation,
  });
  const blueprintVerdict = await validateAdventureBlueprint({
    queue,
    blueprint: projected,
    playerId: world.playerId,
  });
  if (!blueprintVerdict.ok) {
    throw new Error(
      `bridge projected blueprint rejected: ${blueprintVerdict.reason} ${blueprintVerdict.message ?? ''}`,
    );
  }
  await markAdventureReady(queue.id, projected);
  const applied = await applyReadyAdventureBlueprint(queue.id, baseCtx(world));
  if (!applied.ok) {
    throw new Error(
      `bridge apply failed: ${applied.reason} ${applied.message ?? ''}`,
    );
  }
  const activeRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM player_quests
      WHERE player_id = $1
        AND quest_entity_id = $2
        AND status = 'active'`,
    [world.playerId, existingQuestId],
  );
  if (activeRows !== 1) {
    throw new Error('existing quest bridge did not start existing quest');
  }
  const duplicateRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM entities
      WHERE kind = 'quest'
        AND display_name = $1`,
    [projected.suggestedQuest?.title ?? ''],
  );
  if (duplicateRows !== 0) {
    throw new Error('existing quest bridge created a duplicate quest entity');
  }
  const linkedLocationRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM entities
      WHERE kind = 'location'
        AND display_name = $1
        AND profile->>'source_quest_id' = $2
        AND profile->>'hidden_until_stage' = 'complication'`,
    [sideRoomName, String(existingQuestId)],
  );
  if (linkedLocationRows !== 1) {
    throw new Error(
      'existing quest bridge did not spawn linked hidden location',
    );
  }
  const linkedQuestRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM entities
      WHERE id = $1
        AND kind = 'quest'
        AND EXISTS (
          -- M-6: safe_jsonb_array hardens both the outer
          -- situation_links expansion and the nested clocks
          -- count against missing/non-array shapes.
          SELECT 1
            FROM jsonb_array_elements(safe_jsonb_array(profile->'situation_links')) AS link
           WHERE link->>'queue_id' = $2
             AND link->>'mode' = 'attach_existing'
             AND jsonb_array_length(safe_jsonb_array(link->'clocks')) = 1
        )`,
    [existingQuestId, String(queue.id)],
  );
  if (linkedQuestRows !== 1) {
    throw new Error(
      'existing quest bridge did not persist quest situation link',
    );
  }
  return {
    existingQuestId,
    queueId: queue.id,
    mode: projected.suggestedQuest?.mode,
    duplicateRows,
    linkedLocationRows,
    linkedQuestRows,
  };
}

async function checkBatchChildToolHistory(
  world: SupportWorld,
): Promise<unknown> {
  const history = world.session.activeTurn?.toolHistory ?? [];
  const children = history.filter((entry) => entry.source === 'batch_child');
  const memory = children.find(
    (entry) => entry.name === 'add_memory' && entry.operation_id === 'remember',
  );
  const xp = children.find(
    (entry) => entry.name === 'award_xp' && entry.operation_id === 'grant',
  );
  if (
    !memory ||
    typeof (memory.result as { id?: unknown } | undefined)?.id !== 'number'
  ) {
    throw new Error(
      'committed add_memory batch child history missing result id',
    );
  }
  if (
    !xp ||
    (xp.result as { xp_after?: unknown } | undefined)?.xp_after !== 7
  ) {
    throw new Error('committed award_xp batch child history missing result');
  }
  if (children.some((entry) => entry.operation_id === 'rolled-grant')) {
    throw new Error('rolled-back batch child history leaked');
  }
  return { batchChildren: children.length };
}

async function checkRuntimeFieldEvents(world: SupportWorld): Promise<unknown> {
  const setResult = await dispatch(
    'set_runtime_field',
    {
      field_id: world.signalFieldId,
      value: 'ready',
      source: 'support_smoke',
    },
    baseCtx(world),
  );
  if (!setResult.ok)
    throw new Error(`set_runtime_field failed: ${setResult.error}`);
  await waitUntil(
    () =>
      runtimeFieldEvents(world).some(
        (event) =>
          event.field_key === 'support_signal' &&
          event.owner_entity_id === world.playerId &&
          event.value === 'ready',
      ),
    'set_runtime_field runtime:field SSE',
  );

  const surfaceResult = await dispatch(
    'apply_surface',
    {
      location: world.locationName,
      type: 'smoke',
      severity: 1,
      area: 'central',
      lifetime_turns: 2,
    },
    baseCtx(world),
  );
  if (!surfaceResult.ok)
    throw new Error(`apply_surface failed: ${surfaceResult.error}`);
  await waitUntil(
    () =>
      runtimeFieldEvents(world).some(
        (event) =>
          event.field_key === 'active_surfaces' &&
          Array.isArray(event.value) &&
          event.value.some(
            (item) =>
              item &&
              typeof item === 'object' &&
              (item as Record<string, unknown>)['type'] === 'smoke',
          ),
      ),
    'apply_surface final active_surfaces SSE',
  );

  await query(
    `INSERT INTO runtime_values (field_id, value, source, updated_at)
     VALUES ($1, $2::jsonb, 'support_smoke_seed', now())
     ON CONFLICT (field_id)
     DO UPDATE SET value = EXCLUDED.value,
                   source = EXCLUDED.source,
                   updated_at = now()`,
    [
      world.conditionFieldId,
      JSON.stringify([
        { tag: 'stunned', severity: 1, applied_turn: -2, expires_turn: -1 },
      ]),
    ],
  );
  await decrementConditions(world.sessionId);
  await waitUntil(
    () =>
      runtimeFieldEvents(world).some(
        (event) =>
          event.field_key === 'conditions' &&
          Array.isArray(event.value) &&
          event.value.length === 0,
      ),
    'condition decay runtime:field SSE',
  );

  await query(
    `INSERT INTO runtime_values (field_id, value, source, updated_at)
     VALUES ($1, $2::jsonb, 'support_smoke_seed', now())
     ON CONFLICT (field_id)
     DO UPDATE SET value = EXCLUDED.value,
                   source = EXCLUDED.source,
                   updated_at = now()`,
    [
      world.surfaceFieldId,
      JSON.stringify([
        { type: 'smoke', severity: 1, applied_turn: -2, expires_turn: -1 },
      ]),
    ],
  );
  await decrementSurfaces(world.sessionId);
  await waitUntil(
    () =>
      runtimeFieldEvents(world).some(
        (event) =>
          event.field_key === 'active_surfaces' &&
          Array.isArray(event.value) &&
          event.value.length === 0,
      ),
    'surface decay runtime:field SSE',
  );

  return {
    runtimeFieldEvents: runtimeFieldEvents(world).length,
    signalFieldId: world.signalFieldId,
    surfaceFieldId: world.surfaceFieldId,
    conditionFieldId: world.conditionFieldId,
  };
}

async function checkRuntimeFieldPromptContext(
  world: SupportWorld,
): Promise<unknown> {
  const fieldId = await insertAllowedRuntimeField(world, {
    ownerEntityId: world.locationId,
    fieldKey: 'support_prompt_mode',
    scopePerPlayer: true,
  });
  const setResult = await dispatch(
    'set_runtime_field',
    {
      field_id: fieldId,
      value: 'ready',
      source: 'support_smoke_prompt_context',
    },
    baseCtx(world),
  );
  if (!setResult.ok) {
    throw new Error(
      `prompt context set_runtime_field failed: ${setResult.error}`,
    );
  }

  const context = await buildTurnContext(world.sessionId, world.playerId, {
    dialogueHistoryLimit: 1,
  });
  const required = [
    'Use only listed field_id values',
    'support_prompt_mode',
    `id ${fieldId}`,
    'type=string',
    'per-player',
    'source=overlay',
    'allowed=["idle","ready"]',
    'support smoke allowed-values field',
  ];
  for (const needle of required) {
    if (!context.dynamic.includes(needle)) {
      throw new Error(
        `runtime prompt context missing ${needle}: ${context.dynamic}`,
      );
    }
  }

  const eq = await evaluateObjective(
    {
      kind: 'field_threshold',
      owner_entity_id: world.locationId,
      field_key: 'support_prompt_mode',
      op: '==',
      value: 'ready',
    },
    {
      playerId: world.playerId,
      sessionId: world.sessionId,
      recentToolCalls: [],
    },
  );
  if (!eq.satisfied) {
    throw new Error(
      `overlay enum objective was not satisfied: ${JSON.stringify(eq)}`,
    );
  }
  const wrong = await evaluateObjective(
    {
      kind: 'field_threshold',
      owner_entity_id: world.locationId,
      field_key: 'support_prompt_mode',
      op: '==',
      value: 'idle',
    },
    {
      playerId: world.playerId,
      sessionId: world.sessionId,
      recentToolCalls: [],
    },
  );
  if (wrong.satisfied) {
    throw new Error(
      `overlay enum objective matched default instead of overlay: ${JSON.stringify(wrong)}`,
    );
  }

  return { fieldId, promptContext: true, objectiveOverlay: true };
}

async function checkNpcAgencyRuntimeHpContract(
  world: SupportWorld,
): Promise<unknown> {
  const currentHpFieldId = await insertRuntimeField(
    world.npcId,
    'current_hp',
    'int',
    12,
    'session',
  );
  const maxHpFieldId = await insertRuntimeField(
    world.npcId,
    'max_hp',
    'int',
    12,
    'session',
  );
  const movedNpcId = await insertEntity(
    'person',
    `Support Smoke Moved Agency NPC ${world.suffix}`,
    'Support smoke NPC present via current_location_id for agency.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({
        current_location_id: String(world.locationId),
        aggression: 1,
        initiative_cooldown_turns: 0,
      }),
      movedNpcId,
    ],
  );
  await insertRuntimeField(movedNpcId, 'current_hp', 'int', 1, 'session');
  await insertRuntimeField(movedNpcId, 'max_hp', 'int', 10, 'session');

  const intent = await evaluateNpcAgency(world.session, world.playerId);
  if (intent?.npcId === world.npcId) {
    throw new Error(
      'support NPC unexpectedly initiated from neutral full-HP state',
    );
  }
  if (intent?.npcId !== movedNpcId) {
    throw new Error(
      `current_location_id-only agency NPC was not considered: ${JSON.stringify(intent)}`,
    );
  }
  clearNpcAgencyState(world.session);

  return {
    npcId: world.npcId,
    movedNpcId,
    currentHpFieldId,
    maxHpFieldId,
    intent: intent?.npcId ?? null,
  };
}

async function checkCatalogueScoutExtraction(
  world: SupportWorld,
): Promise<unknown> {
  const name = `Support Smoke Spawned Key ${world.suffix}`;
  const id = await insertEntity('item', name, 'Support smoke spawned item.');
  const extracted = await extractNewEntities([
    {
      name: 'create_quest',
      args: { spawn_entities: [{ kind: 'item', display_name: name }] },
      result: { spawned: { [name]: id } },
      ok: true,
    },
  ]);
  if (!extracted.some((entity) => entity.id === id && entity.kind === 'item')) {
    throw new Error(
      'Catalogue Scout did not extract create_quest.spawned map entity',
    );
  }

  const existingName = `Support Smoke Duplicate Lens ${world.suffix}`;
  const existingId = await insertEntity(
    'item',
    existingName,
    'Existing duplicate.',
  );
  const spawnedId = await insertEntity(
    'item',
    existingName,
    'Spawned duplicate.',
  );
  await catalogueScoutHook.run(
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: world.session.activeTurn?.turnId ?? 'support-smoke-turn',
      signal: new AbortController().signal,
    },
    {
      text: 'support smoke catalogue scout',
      narrative: '',
      toolHistory: [
        {
          name: 'create_quest',
          args: {
            spawn_entities: [{ kind: 'item', display_name: existingName }],
          },
          result: { spawned: { [existingName]: spawnedId } },
          ok: true,
          source: 'batch_child',
          operation_id: 'spawn-dupe',
        },
      ],
    },
  );
  await waitUntil(
    () =>
      world.events.some((event) => event.event === 'entity:duplicate_warning'),
    'entity:duplicate_warning SSE',
  );
  return {
    extracted: extracted.length,
    duplicateExistingId: existingId,
    duplicateSpawnedId: spawnedId,
  };
}

async function checkNonUuidTelemetry(world: SupportWorld): Promise<unknown> {
  await query(
    `INSERT INTO turn_telemetry
       (session_id, turn_id, role, model_id, thinking, input_tokens,
        output_tokens, cache_hit_tokens, cache_miss_tokens, duration_ms,
        cost_usd, player_id, tier)
     VALUES ($1, $2, 'broker', 'support-smoke-model', false,
        2, 1, 0, 2, 10, 0.000001, $3, 'T4')`,
    [
      world.sessionId,
      `${world.session.activeTurn?.turnId}:telemetry`,
      world.playerId,
    ],
  );
  const rows = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM turn_telemetry
      WHERE session_id = $1`,
    [world.sessionId],
  );
  const count = Number(rows.rows[0]?.count ?? 0);
  if (count < 1) throw new Error('non-UUID telemetry insert was not readable');
  return { sessionId: world.sessionId, rows: count };
}

async function checkFrontendTelemetryIngest(
  world: SupportWorld,
): Promise<unknown> {
  const turnId = `support-smoke-frontend-${world.suffix}`;
  const traceId = `support-frontend-trace-${world.suffix}`;
  const response = await telemetryRoutes.request('/frontend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: {
        sessionId: world.sessionId,
        playerId: world.playerId,
        turnId,
        traceId,
      },
      events: [
        {
          schemaName: 'frontend.support_ui',
          eventName: 'support_ui_event',
          severity: 'info',
          properties: { support_smoke: true },
        },
      ],
      spans: [
        {
          name: 'frontend.support_span',
          status: 'ok',
          durationMs: 2,
          attributes: { support_smoke: true },
        },
      ],
      metrics: [
        {
          name: 'frontend.support_metric',
          unit: 'ms',
          sum: 2,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`frontend telemetry ingest failed: ${response.status}`);
  }
  const payload = (await response.json()) as { accepted?: number };
  if (payload.accepted !== 3) {
    throw new Error(
      `frontend telemetry accepted ${payload.accepted}, expected 3`,
    );
  }
  const eventRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM telemetry_events
      WHERE trace_id = $1 AND schema_name = 'frontend.support_ui'`,
    [traceId],
  );
  const spanRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM telemetry_spans
      WHERE trace_id = $1 AND name = 'frontend.support_span'`,
    [traceId],
  );
  const metricRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM telemetry_metrics
      WHERE trace_id = $1 AND name = 'frontend.support_metric'`,
    [traceId],
  );
  if (eventRows !== 1 || spanRows !== 1 || metricRows !== 1) {
    throw new Error(
      `frontend telemetry rows mismatch: event=${eventRows} span=${spanRows} metric=${metricRows}`,
    );
  }
  return { accepted: payload.accepted, eventRows, spanRows, metricRows };
}

async function checkDesktopTelemetryIngest(
  world: SupportWorld,
): Promise<unknown> {
  const traceId = `support-desktop-trace-${world.suffix}`;
  const response = await telemetryRoutes.request('/desktop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: {
        sessionId: world.sessionId,
        playerId: world.playerId,
        traceId,
        appVersion: 'support-smoke',
      },
      events: [
        {
          schemaName: 'desktop.support',
          eventName: 'support_desktop_event',
          severity: 'info',
          properties: { support_smoke: true },
        },
      ],
      spans: [
        {
          name: 'desktop.support_span',
          status: 'ok',
          durationMs: 3,
          attributes: { support_smoke: true },
        },
      ],
      artifacts: [
        {
          artifactType: 'desktop_support_log',
          path: `support-desktop-${world.suffix}.log`,
          mimeType: 'text/plain',
          metadata: { support_smoke: true },
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`desktop telemetry ingest failed: ${response.status}`);
  }
  const payload = (await response.json()) as { accepted?: number };
  if (payload.accepted !== 3) {
    throw new Error(
      `desktop telemetry accepted ${payload.accepted}, expected 3`,
    );
  }
  const eventRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM telemetry_events
      WHERE trace_id = $1 AND schema_name = 'desktop.support'
        AND source = 'desktop'`,
    [traceId],
  );
  const spanRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM telemetry_spans
      WHERE trace_id = $1 AND name = 'desktop.support_span'
        AND source = 'desktop'`,
    [traceId],
  );
  const artifactRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM telemetry_artifacts
      WHERE trace_id = $1 AND artifact_type = 'desktop_support_log'
        AND source = 'desktop'`,
    [traceId],
  );
  if (eventRows !== 1 || spanRows !== 1 || artifactRows !== 1) {
    throw new Error(
      `desktop telemetry rows mismatch: event=${eventRows} span=${spanRows} artifact=${artifactRows}`,
    );
  }
  return { accepted: payload.accepted, eventRows, spanRows, artifactRows };
}

async function checkTelemetryDiagnosticBundle(
  world: SupportWorld,
): Promise<unknown> {
  const traceId = `support-frontend-trace-${world.suffix}`;
  const bundle = await buildTelemetryBundle({
    since: '1970-01-01T00:00:00.000Z',
    limit: 50,
    traceLimit: 20,
  });
  if (bundle.schema !== 'greenhaven.telemetry_bundle.v1') {
    throw new Error(`unexpected telemetry bundle schema: ${bundle.schema}`);
  }
  if (bundle.summary.health.spans < 1 || bundle.summary.health.events < 1) {
    throw new Error(
      `telemetry bundle missing rows: ${JSON.stringify(bundle.summary.health)}`,
    );
  }
  const trace = bundle.traces.find((row) => row.trace_id === traceId);
  if (!trace) {
    throw new Error(`telemetry bundle missing frontend trace ${traceId}`);
  }
  const guiCoverage = bundle.canonical_counts.find(
    (row) => row.source === 'gui_events',
  );
  if (!guiCoverage) {
    throw new Error('telemetry bundle missing canonical gui_events count');
  }
  return {
    schema: bundle.schema,
    traces: bundle.traces.length,
    frontendTraceSpans: trace.summary.spans,
    canonicalCounts: bundle.canonical_counts.length,
  };
}

async function checkTelemetryRetentionFixture(
  world: SupportWorld,
): Promise<unknown> {
  const traceId = `support-retention-trace-${world.suffix}`;
  const turnId = `support-retention-turn-${world.suffix}`;
  const old = '2000-01-01T00:00:00.000Z';
  const artifact = await writeTelemetryJsonArtifact({
    artifactType: 'support_retention_bundle',
    filenamePrefix: 'support-retention',
    payload: { support_smoke: true, traceId },
    context: {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId,
      traceId,
    },
    source: 'support_smoke',
  });
  await query(
    `UPDATE telemetry_artifacts
        SET recorded_at = $2::timestamptz,
            redaction_tier = 'tier1_local_debug'
      WHERE trace_id = $1`,
    [traceId, old],
  );
  await query(
    `INSERT INTO telemetry_spans
       (recorded_at, trace_id, span_id, session_id, player_id, turn_id, name,
        kind, status, started_at, ended_at, duration_ms, attributes,
        redaction_tier, source)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6,
             'support.retention_old_span', 'internal', 'ok',
             $1::timestamptz, $1::timestamptz, 1, '{}'::jsonb,
             'tier1_local_debug', 'support_smoke')`,
    [
      old,
      traceId,
      `support-retention-span-${world.suffix}`,
      world.sessionId,
      world.playerId,
      turnId,
    ],
  );
  await query(
    `INSERT INTO telemetry_events
       (occurred_at, trace_id, session_id, player_id, turn_id, schema_name,
        schema_version, category, event_name, properties, redaction_tier,
        source)
     VALUES ($1::timestamptz, $2, $3, $4, $5, 'support.retention',
             1, 'support', 'old_event', '{}'::jsonb, 'tier1_local_debug',
             'support_smoke')`,
    [old, traceId, world.sessionId, world.playerId, turnId],
  );
  await query(
    `INSERT INTO telemetry_metrics
       (bucket_start, trace_id, session_id, player_id, turn_id, name, unit,
        aggregation, count, sum, attributes, source)
     VALUES ($1::timestamptz, $2, $3, $4, $5, 'support.retention_old_metric',
             'count', 'raw', 1, 1, '{}'::jsonb, 'support_smoke')`,
    [old, traceId, world.sessionId, world.playerId, turnId],
  );
  await query(
    `INSERT INTO performance_events
       (recorded_at, session_id, player_id, turn_id, trace_id, kind, phase,
        status, duration_ms, metadata)
     VALUES ($1::timestamptz, $2, $3, $4, $5, 'support',
             'support.retention_old_perf', 'ok', 1, '{}'::jsonb)`,
    [old, world.sessionId, world.playerId, turnId, traceId],
  );

  const result = await applyTelemetryRetention({
    safeDays: 30,
    debugDays: 7,
    sensitiveDays: 1,
    artifactDays: 7,
  });
  const survivors = await countRows(
    `SELECT
       (SELECT COUNT(*) FROM telemetry_spans WHERE trace_id = $1) +
       (SELECT COUNT(*) FROM telemetry_events WHERE trace_id = $1) +
       (SELECT COUNT(*) FROM telemetry_metrics WHERE trace_id = $1) +
       (SELECT COUNT(*) FROM telemetry_artifacts WHERE trace_id = $1) +
       (SELECT COUNT(*) FROM performance_events WHERE trace_id = $1)
       AS count`,
    [traceId],
  );
  if (survivors !== 0) {
    throw new Error(`retention left ${survivors} support rows for ${traceId}`);
  }
  if (await fileExists(artifact.path)) {
    throw new Error(`retention left managed artifact file: ${artifact.path}`);
  }
  return {
    deletedRows: result.deletedRows,
    artifactFiles: result.artifactFiles,
  };
}

async function checkTelemetryDeveloperExport(
  _world: SupportWorld,
): Promise<unknown> {
  const result = await buildTelemetryDeveloperExport({
    since: '1970-01-01T00:00:00.000Z',
    limit: 200,
    formats: ['jsonl', 'otlp'],
    write: true,
    postOtlp: true,
    otlpEndpoint: 'https://telemetry.example.invalid:4318',
  });
  if (!result.ok) {
    throw new Error('developer telemetry export did not return ok');
  }
  if (result.files.length !== 2) {
    throw new Error(
      `developer export wrote ${result.files.length} files, expected 2`,
    );
  }
  if (result.otlp_post?.skipped !== 'remote_endpoint_blocked') {
    throw new Error(
      `developer export did not block remote OTLP endpoint: ${JSON.stringify(result.otlp_post)}`,
    );
  }
  for (const file of result.files) {
    if (!(await fileExists(file.path))) {
      throw new Error(`developer export file missing: ${file.path}`);
    }
  }
  const artifactRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM telemetry_artifacts
      WHERE source = 'developer.telemetry_export'
        AND artifact_type IN ('developer_export_jsonl', 'developer_export_otlp')`,
    [],
  );
  if (artifactRows < 2) {
    throw new Error(`developer export artifact rows missing: ${artifactRows}`);
  }
  return {
    counts: result.counts,
    files: result.files.map((file) => ({
      artifactType: file.artifactType,
      sizeBytes: file.sizeBytes,
    })),
    otlpPost: result.otlp_post,
  };
}

async function checkCartridgeValidator(): Promise<unknown> {
  const result = await validateCartridge();
  if (!result.ok) {
    const errors = result.issues
      .filter((issue) => issue.severity === 'error')
      .slice(0, 8)
      .map((issue) =>
        [
          issue.code,
          issue.entityName ?? issue.entityId ?? '<global>',
          issue.path ?? '<root>',
          issue.message,
        ].join(' | '),
      )
      .join('; ');
    throw new Error(
      `cartridge validation failed with ${result.summary.errors} errors: ${errors}`,
    );
  }
  return result.summary;
}

async function checkNarratorJsonQuarantine(
  world: SupportWorld,
): Promise<unknown> {
  const fenced = [
    '[[Broker stage complete. Produce the prose for the following narration request:]]',
    '```json',
    JSON.stringify({
      text: 'Support smoke clean fenced prose.',
      author: world.locationName,
      tone: 'narrator',
      done: true,
    }),
    '```',
  ].join('\n');
  const multiObject = [
    JSON.stringify({ text: 'Support smoke stale prose.' }),
    JSON.stringify({ text: 'Support smoke fresh prose.' }),
  ].join('\n');
  const malformed = [
    '[Broker stage complete. Produce the prose for the following narration request:]',
    '```json',
    '{"text": ',
  ].join('\n');
  const functionDump = [
    'narrate(author="Mikka Quickgrin", tone="npc", text="Support smoke pseudo-call.", done=true)',
    'apply_runtime_field_patch(patches=[{field_id: 2004, value: 0.5}], source="support_smoke")',
    'add_memory(owner="Mikka Quickgrin", about=1198, text="Support smoke memory leak.", importance=0.6, tags=["support"])',
  ].join(' ');

  const cleanFenced = sanitiseNarrateText(fenced);
  if (cleanFenced !== 'Support smoke clean fenced prose.') {
    throw new Error(`fenced JSON was not unwrapped: ${cleanFenced}`);
  }
  const cleanMulti = sanitiseNarrateText(multiObject);
  if (cleanMulti !== 'Support smoke fresh prose.') {
    throw new Error(
      `multiple JSON objects did not choose the last text: ${cleanMulti}`,
    );
  }
  if (!isNarrateControlText(sanitiseNarrateText(malformed))) {
    throw new Error(
      'malformed broker handoff text was not recognised as control text',
    );
  }
  if (!isNarrateControlText(sanitiseNarrateText(functionDump))) {
    throw new Error(
      'function-call shaped tool dump was not recognised as control text',
    );
  }

  await query(
    `UPDATE players SET dialogue_partner_id = $1 WHERE entity_id = $2`,
    [world.npcId, world.playerId],
  );
  await insertChatMessage(
    world,
    world.playerId,
    'player',
    '{"text":"player typed json"}',
    100,
  );
  await insertChatMessage(world, world.npcId, 'npc', fenced, 101);
  await insertChatMessage(world, world.npcId, 'npc', malformed, 102);
  await insertChatMessage(world, world.npcId, 'npc', functionDump, 103);
  const playerPovUnderNpc = `I take ${world.npcName} by the hand and ask her to listen.`;
  await insertChatMessage(world, world.npcId, 'npc', playerPovUnderNpc, 104);

  const rendered = await renderDialogueState(
    world.npcId,
    world.playerId,
    world.sessionId,
    12,
  );
  if (
    rendered.includes('Broker stage complete') ||
    rendered.includes('```json')
  ) {
    throw new Error(
      'control-shaped narration leaked into dialogue prompt history',
    );
  }
  if (
    rendered.includes('apply_runtime_field_patch') ||
    rendered.includes('add_memory(')
  ) {
    throw new Error(
      'function-call shaped tool dump leaked into dialogue prompt history',
    );
  }
  if (!rendered.includes('Support smoke clean fenced prose.')) {
    throw new Error(
      'sanitised narration prose was not preserved in prompt history',
    );
  }
  if (!rendered.includes('{"text":"player typed json"}')) {
    throw new Error('player-authored JSON was unexpectedly sanitised');
  }
  if (rendered.includes(playerPovUnderNpc)) {
    throw new Error('player POV under NPC author leaked into prompt history');
  }

  return {
    fenced: cleanFenced.length,
    multiObject: cleanMulti.length,
    promptHistoryChars: rendered.length,
  };
}

async function checkNarrateQuarantineSystemEvent(
  world: SupportWorld,
): Promise<unknown> {
  const turnId = `${world.session.activeTurn?.turnId ?? 'support-smoke'}:quarantine-event`;
  const beforeEvents = countEvents(world, 'narrate:quarantined');
  await synthesiseNarrate(
    world.session,
    world.playerId,
    turnId,
    'narrate(author="Mikka Quickgrin", tone="npc", text="Support smoke pseudo-call.", done=true) add_memory(owner="Mikka Quickgrin", about=1198, text="Leak.", importance=0.6)',
    false,
  );
  await waitUntil(
    () => countEvents(world, 'narrate:quarantined') > beforeEvents,
    'narrate:quarantined SSE',
  );
  const chatRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM chat_messages
      WHERE session_id = $1
        AND payload->>'turn_id' = $2`,
    [world.sessionId, turnId],
  );
  if (chatRows !== 0) {
    throw new Error(`quarantined narration inserted ${chatRows} chat rows`);
  }
  const auditRows = await query<{ error: string | null; result: unknown }>(
    `SELECT error, result
       FROM tool_invocations
      WHERE session_id = $1
        AND turn_id = $2
        AND tool_name = 'narrate'
      ORDER BY id DESC`,
    [world.sessionId, turnId],
  );
  const latest = auditRows.rows[0];
  if (!latest?.error?.startsWith('quarantined:')) {
    throw new Error(
      'quarantined narration did not write a quarantine audit row',
    );
  }
  return {
    events: countEvents(world, 'narrate:quarantined') - beforeEvents,
    chatRows,
    auditRows: auditRows.rows.length,
  };
}

async function checkSessionTranscriptDiagnostics(
  world: SupportWorld,
): Promise<unknown> {
  const watchdogTurnId = `${world.session.activeTurn?.turnId ?? 'support-smoke'}:watchdog`;
  await insertChatMessage(
    world,
    world.playerId,
    'player',
    'Support smoke mutation turn without narration.',
    104,
    { turn_id: watchdogTurnId, source: 'user' },
  );
  await query(
    `INSERT INTO tool_invocations
       (session_id, player_id, turn_id, tool_name, args, result, error, duration_ms)
     VALUES ($1, $2, $3, 'award_xp', '{}'::jsonb, $4::jsonb, NULL, 1)`,
    [
      world.sessionId,
      world.playerId,
      watchdogTurnId,
      JSON.stringify({ ok: true, support_smoke: true }),
    ],
  );
  const longChainTurnId = `${world.session.activeTurn?.turnId ?? 'support-smoke'}:long-chain`;
  await insertChatMessage(
    world,
    world.playerId,
    'player',
    'Support smoke long mutation chain before narration.',
    105,
    { turn_id: longChainTurnId, source: 'user' },
  );
  for (const [index, toolName] of [
    'add_memory',
    'award_xp',
    'set_runtime_field',
    'advance_quest',
    'narrate',
  ].entries()) {
    await query(
      `INSERT INTO tool_invocations
         (session_id, player_id, turn_id, tool_name, args, result, error, duration_ms)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5::jsonb, NULL, $6)`,
      [
        world.sessionId,
        world.playerId,
        longChainTurnId,
        toolName,
        JSON.stringify({ ok: true, support_smoke: true }),
        index + 1,
      ],
    );
  }

  const diag = await buildSessionTranscriptDiagnostics({
    sessionId: world.sessionId,
    limit: 20,
  });
  if (diag.transcript.length === 0) {
    throw new Error('transcript diagnostic returned no rows');
  }
  const cleanPlayer = diag.transcript.find((row) =>
    row.preview.includes('player typed json'),
  );
  if (!cleanPlayer) {
    throw new Error('clean player row missing from transcript diagnostic');
  }
  if (diag.flagged_messages.some((row) => row.id === cleanPlayer.id)) {
    throw new Error('player-authored JSON row was flagged as contaminated');
  }
  if (!diag.flagged_messages.some((row) => row.has_json_fence)) {
    throw new Error('seeded JSON-fence row was not flagged');
  }
  if (!diag.flagged_messages.some((row) => row.has_handoff_marker)) {
    throw new Error('seeded handoff-marker row was not flagged');
  }
  const watchdog = diag.turn_watchdog.find(
    (row) => row.turn_id === watchdogTurnId,
  );
  if (!watchdog?.markers.includes('mutated_without_narration')) {
    throw new Error('watchdog did not flag mutation without narration');
  }
  const longChain = diag.turn_watchdog.find(
    (row) => row.turn_id === longChainTurnId,
  );
  if (!longChain?.markers.includes('long_mutation_chain_before_narrate')) {
    throw new Error('watchdog did not flag long mutation chain before narrate');
  }
  if (
    !diag.post_turn_slots.some(
      (slot) =>
        slot.slot_key === 'post.support_throwing' &&
        slot.slot_status === 'failed',
    )
  ) {
    throw new Error(
      'post-turn slot diagnostics did not include failed support slot',
    );
  }
  if (
    !diag.post_turn_slots.some(
      (slot) =>
        slot.slot_key === 'post.support_expired' &&
        slot.slot_status === 'expired',
    )
  ) {
    throw new Error(
      'post-turn slot diagnostics did not include expired support slot',
    );
  }
  if (!diag.adventure_queue_depth.some((row) => row.status === 'queued')) {
    throw new Error('adventure queue diagnostics did not include queued depth');
  }
  if (diag.duplicate_adventure_dedupe.length > 0) {
    throw new Error(
      'adventure queue diagnostics reported duplicate dedupe keys',
    );
  }
  if (diag.non_replayable_adventure_rolls.length > 0) {
    throw new Error(
      'adventure queue diagnostics reported non-replayable rolls',
    );
  }
  if (
    !diag.transcript.some((row) => row.tool_names_for_turn.includes('narrate'))
  ) {
    // The transcript check runs before synth_narrate_audit, so this is
    // allowed for old fixtures; keep the shape expectation light here.
    return {
      selected: diag.selected_session_id,
      transcript: diag.transcript.length,
      flagged: diag.flagged_messages.length,
      watchdog: diag.turn_watchdog.length,
      postTurnSlots: diag.post_turn_slots.length,
      adventureDepth: diag.adventure_queue_depth.length,
      toolJoin: 'none_yet',
    };
  }
  return {
    selected: diag.selected_session_id,
    transcript: diag.transcript.length,
    flagged: diag.flagged_messages.length,
    watchdog: diag.turn_watchdog.length,
    postTurnSlots: diag.post_turn_slots.length,
    adventureDepth: diag.adventure_queue_depth.length,
  };
}

async function checkMultiNpcDialogueParticipants(
  world: SupportWorld,
): Promise<unknown> {
  const secondNpcName = `Support Smoke Witness ${world.suffix}`;
  const secondNpcId = await insertEntity(
    'person',
    secondNpcName,
    'Second support smoke dialogue participant.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb)
                    || jsonb_build_object('home_id', $1::text)
      WHERE id = ANY($2::bigint[])`,
    [world.locationId, [world.npcId, secondNpcId]],
  );
  const movedNpcName = `Support Smoke Moved Dialogue Witness ${world.suffix}`;
  const movedNpcId = await insertEntity(
    'person',
    movedNpcName,
    'Dialogue candidate present via current_location_id only.',
  );
  await query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [
      JSON.stringify({ current_location_id: String(world.locationId) }),
      movedNpcId,
    ],
  );
  const candidates = await loadPresentNpcCandidates(world.playerId, {
    sessionId: world.sessionId,
  });
  if (!candidates.some((candidate) => candidate.id === movedNpcId)) {
    throw new Error(
      `dialogue candidates missed current_location_id NPC: ${movedNpcId}`,
    );
  }

  const turnId = world.session.activeTurn?.turnId ?? null;
  await maybeAutoEngageDialogue(
    world.playerId,
    `@${world.npcName}, hold that thought; @${secondNpcName}, you saw it too.`,
    { session: world.session, turnId },
  );

  const player = await query<{
    dialogue_partner_id: number | null;
    dialogue_participants: Record<string, unknown> | null;
  }>(
    `SELECT dialogue_partner_id,
            (metadata->'dialogue_participants') AS dialogue_participants
       FROM players
      WHERE entity_id = $1`,
    [world.playerId],
  );
  const row = player.rows[0];
  if (!row) throw new Error('support player missing after dialogue update');
  if (row.dialogue_partner_id !== world.npcId) {
    throw new Error(
      `focused dialogue partner drifted: expected ${world.npcId}, got ${row.dialogue_partner_id}`,
    );
  }

  const rawIds = row.dialogue_participants?.['participant_ids'];
  const participantIds = Array.isArray(rawIds)
    ? rawIds.map((id) => Number(id)).filter(Number.isFinite)
    : [];
  if (
    !participantIds.includes(world.npcId) ||
    !participantIds.includes(secondNpcId)
  ) {
    throw new Error(
      `participant set missing ids: ${JSON.stringify(participantIds)}`,
    );
  }

  const context = await buildTurnContext(world.sessionId, world.playerId, {
    dialogueHistoryLimit: 4,
  });
  if (!context.dynamic.includes('## DIALOGUE PARTICIPANTS')) {
    throw new Error('turn context missing DIALOGUE PARTICIPANTS block');
  }
  if (
    !context.dynamic.includes(`@${world.npcName}`) ||
    !context.dynamic.includes(`@${secondNpcName}`)
  ) {
    throw new Error('turn context did not render both dialogue participants');
  }
  if (!context.dynamic.includes('split them into separate narrate calls')) {
    throw new Error('one-author-per-bubble participant rule missing');
  }

  return {
    focused: row.dialogue_partner_id,
    participantIds,
    secondNpcId,
  };
}

async function checkProtagonistRendererValidation(
  world: SupportWorld,
): Promise<unknown> {
  const raw = `I take @${world.npcName} by the hand and say "Stay with me." [[1d20+2]]`;
  const acceptedCandidate: ProtagonistActionRendererOutput = {
    mode: 'render',
    changed: true,
    rendered_text: `I take @${world.npcName} by the hand and say "Stay with me." [[1d20+2]], keeping my grip steady.`,
    intent_summary: 'Player takes the NPC by the hand and speaks.',
    meaning_delta: 'none',
    preserved_elements: {
      actor: 'player_hero',
      targets: [world.npcName],
      actions: ['take by the hand', 'say'],
      direct_speech: ['"Stay with me."'],
      mechanical_tokens: ['[[1d20+2]]'],
    },
    confidence: 0.91,
    skipped_reason: null,
  };
  const accepted = validateProtagonistRenderCandidate(raw, acceptedCandidate, [
    world.npcName,
  ]);
  if (!accepted.ok) {
    throw new Error(`faithful render rejected: ${accepted.reason}`);
  }

  const droppedMention = validateProtagonistRenderCandidate(
    raw,
    {
      ...acceptedCandidate,
      rendered_text:
        'I take her by the hand and say "Stay with me." [[1d20+2]].',
    },
    [world.npcName],
  );
  if (droppedMention.ok) {
    throw new Error('render that dropped @mention was accepted');
  }

  const softenedMeaning = validateProtagonistRenderCandidate(
    raw,
    {
      ...acceptedCandidate,
      rendered_text: `I offer @${world.npcName} a careful nod and say "Stay with me." [[1d20+2]].`,
      meaning_delta: 'changed',
    },
    [world.npcName],
  );
  if (softenedMeaning.ok) {
    throw new Error('render with changed meaning was accepted');
  }

  const brokerText = composePlayerTextForBroker(
    raw,
    acceptedCandidate.rendered_text,
  );
  if (
    !brokerText.includes('[Player raw command - canonical intent]') ||
    !brokerText.includes('[Player bubble - visible player performance]')
  ) {
    throw new Error('broker player text did not preserve raw+visible sections');
  }

  return {
    accepted: true,
    droppedMentionReason: droppedMention.reason,
    softenedReason: softenedMeaning.reason,
  };
}

async function checkSynthNarrateAudit(world: SupportWorld): Promise<unknown> {
  const turnId = `${world.session.activeTurn?.turnId ?? 'support-smoke'}:synth-audit`;
  const beforeChat = await countRows(
    `SELECT COUNT(*)::int AS count FROM chat_messages
      WHERE session_id = $1 AND payload->>'turn_id' = $2`,
    [world.sessionId, turnId],
  );
  const beforeAudit = await countRows(
    `SELECT COUNT(*)::int AS count FROM tool_invocations
      WHERE session_id = $1 AND turn_id = $2 AND tool_name = 'narrate'`,
    [world.sessionId, turnId],
  );
  await synthesiseNarrate(
    world.session,
    world.playerId,
    turnId,
    'Support smoke synth narrate.',
    false,
    {
      text: 'Support smoke synth narrate.',
      author: world.npcName,
      tone: 'npc',
    },
  );
  const afterChat = await countRows(
    `SELECT COUNT(*)::int AS count FROM chat_messages
      WHERE session_id = $1 AND payload->>'turn_id' = $2`,
    [world.sessionId, turnId],
  );
  const auditRows = await query<{ args: unknown; result: unknown }>(
    `SELECT args, result
       FROM tool_invocations
      WHERE session_id = $1 AND turn_id = $2 AND tool_name = 'narrate'
      ORDER BY id DESC`,
    [world.sessionId, turnId],
  );
  if (afterChat - beforeChat !== 1) {
    throw new Error(
      `expected one synth chat row, got delta ${afterChat - beforeChat}`,
    );
  }
  if (auditRows.rows.length - beforeAudit !== 1) {
    throw new Error(
      `expected one synth narrate audit row, got delta ${auditRows.rows.length - beforeAudit}`,
    );
  }
  const latest = auditRows.rows[0];
  const args = (latest?.args ?? {}) as Record<string, unknown>;
  const result = (latest?.result ?? {}) as Record<string, unknown>;
  if (args['text'] !== 'Support smoke synth narrate.') {
    throw new Error('synth narrate audit args did not include final text');
  }
  if (result['source'] !== 'narrator_synth_fallback') {
    throw new Error(
      `unexpected synth narrate audit source: ${String(result['source'])}`,
    );
  }
  const history = world.session.activeTurn?.toolHistory ?? [];
  if (
    !history.some(
      (entry) =>
        entry.name === 'narrate' &&
        entry.ok === true &&
        (entry.result as Record<string, unknown> | undefined)?.['source'] ===
          'narrator_synth_fallback',
    )
  ) {
    throw new Error('synth narrate missing from activeTurn.toolHistory');
  }
  return {
    chatDelta: afterChat - beforeChat,
    auditRows: auditRows.rows.length,
  };
}

async function checkStateMutationGuardrails(
  world: SupportWorld,
): Promise<unknown> {
  const otherPlayerName = `Support Smoke Other Player ${world.suffix}`;
  const otherPlayerId = await insertEntity(
    'player',
    otherPlayerName,
    'Other player that must not receive current-player mutations.',
  );
  await query(
    `INSERT INTO players (entity_id, public_id, current_location_id)
     VALUES ($1, $2, $3)`,
    [otherPlayerId, randomUUID(), world.locationId],
  );

  const xpBefore = await readPlayerXp(world.playerId);
  const idTargetResult = await dispatch(
    'award_xp',
    { player_id: world.playerId, amount: 3, reason: 'support smoke id target' },
    baseCtx(world),
  );
  if (!idTargetResult.ok) {
    throw new Error(`player_id XP failed: ${idTargetResult.error}`);
  }
  const crossPlayerResult = await dispatch(
    'award_xp',
    {
      player: otherPlayerName,
      amount: 3,
      reason: 'support smoke cross-player reject',
    },
    baseCtx(world),
  );
  if (crossPlayerResult.ok) {
    throw new Error('cross-player XP by display_name was not rejected');
  }
  const xpAfterIdTarget = await readPlayerXp(world.playerId);
  const otherPlayerXp = await readPlayerXp(otherPlayerId);
  if (xpAfterIdTarget !== xpBefore + 3 || otherPlayerXp !== 0) {
    throw new Error(
      `player_id targeting wrote wrong XP: active ${xpBefore}->${xpAfterIdTarget}, other=${otherPlayerXp}`,
    );
  }

  const idResult = await dispatch(
    'change_stat',
    {
      player_id: world.playerId,
      stat_key: 'support_focus',
      delta: 1,
      reason: 'support smoke id-first target',
    },
    baseCtx(world),
  );
  if (!idResult.ok)
    throw new Error(`player_id change_stat failed: ${idResult.error}`);

  const questId = await insertGuardrailQuest(world, {
    title: `Support Smoke Guardrail Quest ${world.suffix}`,
    rewardXp: 11,
  });
  const startedBefore = await countQuestEventRows(
    world.sessionId,
    'quest:started',
    questId,
  );
  const firstStart = await dispatch(
    'start_quest',
    { quest: String(questId), player_id: world.playerId },
    baseCtx(world),
  );
  const secondStart = await dispatch(
    'start_quest',
    { quest: String(questId), player_id: world.playerId },
    baseCtx(world),
  );
  if (!firstStart.ok || !secondStart.ok) {
    throw new Error(
      `start_quest idempotency failed: ${firstStart.error ?? secondStart.error}`,
    );
  }
  const secondStartData = secondStart.data as Record<string, unknown>;
  if (
    secondStartData['changed'] !== false ||
    secondStartData['reason'] !== 'already_active'
  ) {
    throw new Error(
      `start_quest repeat was not a no-op: ${JSON.stringify(secondStart.data)}`,
    );
  }
  if (
    (await countQuestEventRows(world.sessionId, 'quest:started', questId)) -
      startedBefore !==
    1
  ) {
    throw new Error('start_quest emitted duplicate quest:started events');
  }

  const duplicateSpawnName = `Support Smoke Existing Threat ${world.suffix}`;
  const duplicateSpawnId = await insertEntity(
    'person',
    duplicateSpawnName,
    'Existing support-smoke threat reused by create_quest.',
  );
  const duplicateQuest = await dispatch(
    'create_quest',
    {
      title: `Support Smoke Reuse Threat ${world.suffix}`,
      summary:
        'Support smoke quest must start even when spawn_entities reuses an exact duplicate.',
      giver: world.npcName,
      goal_text: 'Investigate the reused support-smoke threat and report back.',
      auto_start: true,
      spawn_entities: [
        {
          kind: 'person',
          display_name: duplicateSpawnName,
          summary: 'Exact duplicate that should be reused, not re-spawned.',
          profile: { current_location_id: world.locationId },
          tags: ['threat'],
        },
      ],
    },
    baseCtx(world),
  );
  if (!duplicateQuest.ok) {
    throw new Error(
      `create_quest exact duplicate spawn was rejected: ${duplicateQuest.error}`,
    );
  }
  const duplicateQuestData = duplicateQuest.data as Record<string, unknown>;
  const duplicateQuestId = Number(duplicateQuestData['quest_id']);
  const duplicateSpawned = duplicateQuestData['spawned'] as
    | Record<string, unknown>
    | undefined;
  if (Number(duplicateSpawned?.[duplicateSpawnName]) !== duplicateSpawnId) {
    throw new Error(
      `create_quest did not reuse exact duplicate spawn: ${JSON.stringify(duplicateQuestData)}`,
    );
  }
  const duplicateQuestRows = await query<{ status: string }>(
    `SELECT status FROM player_quests WHERE player_id = $1 AND quest_entity_id = $2`,
    [world.playerId, duplicateQuestId],
  );
  if (duplicateQuestRows.rows[0]?.status !== 'active') {
    throw new Error('create_quest exact duplicate spawn did not auto-start');
  }

  const advancedBefore = await countQuestEventRows(
    world.sessionId,
    'quest:advanced',
    questId,
  );
  const firstAdvance = await dispatch(
    'advance_quest',
    { quest: String(questId), player_id: world.playerId, to_stage: 'done' },
    baseCtx(world),
  );
  const secondAdvance = await dispatch(
    'advance_quest',
    { quest: String(questId), player_id: world.playerId, to_stage: 'done' },
    baseCtx(world),
  );
  if (!firstAdvance.ok || !secondAdvance.ok) {
    throw new Error(
      `advance_quest idempotency failed: ${firstAdvance.error ?? secondAdvance.error}`,
    );
  }
  const secondAdvanceData = secondAdvance.data as Record<string, unknown>;
  if (
    secondAdvanceData['changed'] !== false ||
    secondAdvanceData['reason'] !== 'already_at_target'
  ) {
    throw new Error(
      `advance_quest repeat was not a no-op: ${JSON.stringify(secondAdvance.data)}`,
    );
  }
  if (
    (await countQuestEventRows(world.sessionId, 'quest:advanced', questId)) -
      advancedBefore !==
    1
  ) {
    throw new Error('advance_quest emitted duplicate quest:advanced events');
  }

  const xpBeforeComplete = await readPlayerXp(world.playerId);
  const completedBefore = await countQuestEventRows(
    world.sessionId,
    'quest:completed',
    questId,
  );
  const firstComplete = await dispatch(
    'complete_quest',
    { quest: String(questId), player_id: world.playerId, outcome: 'completed' },
    baseCtx(world),
  );
  const secondComplete = await dispatch(
    'complete_quest',
    { quest: String(questId), player_id: world.playerId, outcome: 'completed' },
    baseCtx(world),
  );
  if (!firstComplete.ok || !secondComplete.ok) {
    throw new Error(
      `complete_quest idempotency failed: ${firstComplete.error ?? secondComplete.error}`,
    );
  }
  const xpAfterComplete = await readPlayerXp(world.playerId);
  const secondCompleteData = secondComplete.data as Record<string, unknown>;
  if (xpAfterComplete !== xpBeforeComplete + 11) {
    throw new Error(
      `quest reward applied more than once or not at all: ${xpBeforeComplete}->${xpAfterComplete}`,
    );
  }
  if (
    secondCompleteData['changed'] !== false ||
    secondCompleteData['reason'] !== 'already_terminal'
  ) {
    throw new Error(
      `complete_quest repeat was not terminal no-op: ${JSON.stringify(secondComplete.data)}`,
    );
  }
  if (
    (await countQuestEventRows(world.sessionId, 'quest:completed', questId)) -
      completedBefore !==
    1
  ) {
    throw new Error('complete_quest emitted duplicate quest:completed events');
  }

  const duplicateQuestBatch = await dispatch(
    'batch_mutate_world',
    {
      reason: 'support smoke duplicate quest operation',
      atomic: true,
      operations: [
        {
          id: 'advance',
          tool: 'advance_quest',
          args: {
            quest: String(questId),
            player_id: world.playerId,
            to_stage: 'done',
          },
        },
        {
          id: 'complete',
          tool: 'complete_quest',
          args: { quest: String(questId), player_id: world.playerId },
        },
      ],
    },
    baseCtx(world),
  );
  if (
    duplicateQuestBatch.ok ||
    !duplicateQuestBatch.error?.includes('duplicate_quest_operation')
  ) {
    throw new Error(
      `duplicate quest batch was not rejected: ${duplicateQuestBatch.error}`,
    );
  }

  const allowedFieldId = await insertAllowedRuntimeField(world);
  const badPatch = await dispatch(
    'apply_runtime_field_patch',
    {
      patches: [{ field_id: allowedFieldId, value: 'bad' }],
      source: 'support_smoke_guardrail',
    },
    baseCtx(world),
  );
  if (badPatch.ok)
    throw new Error('invalid runtime patch unexpectedly succeeded');
  if (
    badPatch.suggestion?.['field_key'] !== 'support_mode' ||
    !Array.isArray(badPatch.suggestion?.['allowed_values'])
  ) {
    throw new Error(
      `runtime patch suggestion missing field metadata: ${JSON.stringify(badPatch)}`,
    );
  }

  const paymentQuestId = await insertGuardrailQuest(world, {
    title: `Support Smoke Failed Payment Quest ${world.suffix}`,
    rewardXp: 0,
  });
  await dispatch(
    'start_quest',
    { quest: String(paymentQuestId), player_id: world.playerId },
    baseCtx(world),
  );
  const paymentItemId = await insertSupportItem(world);
  const failedPayment = await dispatch(
    'batch_mutate_world',
    {
      reason: 'support smoke failed payment rollback',
      atomic: true,
      operations: [
        {
          id: 'memory-before-payment',
          tool: 'add_memory',
          args: {
            owner: world.npcName,
            about: world.playerId,
            text: `Support smoke failed payment memory ${world.suffix}`,
            importance: 0.5,
          },
        },
        {
          id: 'payment',
          tool: 'inventory_transfer',
          args: {
            from: world.npcName,
            to_player_id: world.playerId,
            item: `support_coin_${world.suffix}`,
            count: 1,
          },
        },
        {
          id: 'complete-after-payment',
          tool: 'complete_quest',
          args: { quest: String(paymentQuestId), player_id: world.playerId },
        },
      ],
    },
    baseCtx(world),
  );
  if (failedPayment.ok)
    throw new Error('failed NPC payment batch unexpectedly succeeded');
  const committedPaymentMemory = await countNpcMemoriesByExactText(
    `Support smoke failed payment memory ${world.suffix}`,
  );
  const paymentQuest = await query<{ status: string }>(
    `SELECT status FROM player_quests WHERE player_id = $1 AND quest_entity_id = $2`,
    [world.playerId, paymentQuestId],
  );
  if (committedPaymentMemory !== 0) {
    throw new Error('failed payment memory committed despite batch rollback');
  }
  if (paymentQuest.rows[0]?.status !== 'active') {
    throw new Error(
      `failed payment quest changed status: ${paymentQuest.rows[0]?.status}`,
    );
  }

  return {
    activeXpAfterIdTarget: xpAfterIdTarget,
    otherPlayerXp,
    questId,
    duplicateQuestId,
    paymentQuestId,
    paymentItemId,
  };
}

async function checkActorResourceGrounding(
  world: SupportWorld,
): Promise<unknown> {
  const coinSlug = `support_coin_${world.suffix}`;
  await insertSupportItem(world);

  const missingNpcPayment = await dispatch(
    'inventory_transfer',
    {
      from: world.npcName,
      to_player_id: world.playerId,
      item: coinSlug,
      count: 1,
    },
    baseCtx(world),
  );
  if (missingNpcPayment.ok) {
    throw new Error('NPC payment succeeded without coins');
  }

  const grantCoins = await dispatch(
    'inventory_transfer',
    {
      from: null,
      to: world.npcName,
      item: coinSlug,
      count: 2,
    },
    baseCtx(world),
  );
  if (!grantCoins.ok) {
    throw new Error(`NPC coin setup failed: ${grantCoins.error}`);
  }

  const npcPayment = await dispatch(
    'inventory_transfer',
    {
      from: world.npcName,
      to_player_id: world.playerId,
      item: coinSlug,
      count: 2,
    },
    baseCtx(world),
  );
  if (!npcPayment.ok) {
    throw new Error(`NPC payment with coins failed: ${npcPayment.error}`);
  }

  const overpay = await dispatch(
    'inventory_transfer',
    {
      from: world.npcName,
      to_player_id: world.playerId,
      item: coinSlug,
      count: 1,
    },
    baseCtx(world),
  );
  if (overpay.ok) {
    throw new Error('NPC overpayment succeeded after coins were exhausted');
  }

  await query(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value,
        allowed_values, scope, scope_per_player, description)
     VALUES ($1, 'current_hp', 'int', '10'::jsonb, NULL, 'session', false,
             'support smoke combat HP')
     ON CONFLICT (owner_entity_id, field_key) DO NOTHING`,
    [world.npcId],
  );
  await query(
    `INSERT INTO runtime_values (field_id, value, source)
     SELECT id, default_value, 'support_smoke'
       FROM runtime_fields
      WHERE owner_entity_id = $1 AND field_key = 'current_hp'
     ON CONFLICT (field_id) DO NOTHING`,
    [world.npcId],
  );

  const scriptedAttack = await maybeScriptAction(
    world.session,
    world.playerId,
    `attack:${world.npcId}`,
    `support-smoke-scripted-unarmed-${world.suffix}`,
  );
  const scriptedText = scriptedAttack?.contextInjection ?? '';
  if (!scriptedText.includes('unarmed_strike')) {
    throw new Error(
      `scripted attack did not ground missing weapons as unarmed: ${scriptedText}`,
    );
  }

  const weaponSlug = `support_blade_${world.suffix}`;
  await query(
    `INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour)
     VALUES ($1, 'weapon', 1.00, false, 1,
             '{"damage_die":"1d6","damage_type":"slashing"}'::jsonb)
     ON CONFLICT (slug) DO NOTHING`,
    [weaponSlug],
  );

  const missingNpcWeaponTurn = `support-smoke-npc-missing-weapon-${world.suffix}`;
  await forceCombatSuccess(world, missingNpcWeaponTurn, world.playerId, 'npc');
  const missingNpcWeapon = await dispatch(
    'damage',
    {
      target_id: world.playerId,
      attacker_id: world.npcId,
      amount: 1,
      type: 'slashing',
      source: weaponSlug,
    },
    { ...baseCtx(world), turnId: missingNpcWeaponTurn },
  );
  if (missingNpcWeapon.ok) {
    throw new Error('NPC weapon damage succeeded without the weapon');
  }

  const grantWeaponToNpc = await dispatch(
    'inventory_transfer',
    { from: null, to: world.npcName, item: weaponSlug, count: 1 },
    baseCtx(world),
  );
  if (!grantWeaponToNpc.ok) {
    throw new Error(`NPC weapon setup failed: ${grantWeaponToNpc.error}`);
  }

  const npcWeaponTurn = `support-smoke-npc-weapon-${world.suffix}`;
  await forceCombatSuccess(world, npcWeaponTurn, world.playerId, 'npc');
  const npcWeaponDamage = await dispatch(
    'damage',
    {
      target_id: world.playerId,
      attacker_id: world.npcId,
      amount: 1,
      type: 'slashing',
      source: weaponSlug,
    },
    { ...baseCtx(world), turnId: npcWeaponTurn },
  );
  if (!npcWeaponDamage.ok) {
    throw new Error(
      `NPC weapon damage failed despite held weapon: ${npcWeaponDamage.error}`,
    );
  }

  const missingPlayerWeaponTurn = `support-smoke-player-missing-weapon-${world.suffix}`;
  await forceCombatSuccess(
    world,
    missingPlayerWeaponTurn,
    world.npcId,
    'player',
  );
  const missingPlayerWeapon = await dispatch(
    'damage',
    {
      target_id: world.npcId,
      attacker_id: world.playerId,
      amount: 1,
      type: 'slashing',
      source: weaponSlug,
    },
    { ...baseCtx(world), turnId: missingPlayerWeaponTurn },
  );
  if (missingPlayerWeapon.ok) {
    throw new Error('player weapon damage succeeded without the weapon');
  }

  const grantWeaponToPlayer = await dispatch(
    'inventory_transfer',
    { from: null, to_player_id: world.playerId, item: weaponSlug, count: 1 },
    baseCtx(world),
  );
  if (!grantWeaponToPlayer.ok) {
    throw new Error(`player weapon setup failed: ${grantWeaponToPlayer.error}`);
  }

  const playerWeaponTurn = `support-smoke-player-weapon-${world.suffix}`;
  await forceCombatSuccess(world, playerWeaponTurn, world.npcId, 'player');
  const playerWeaponDamage = await dispatch(
    'damage',
    {
      target_id: world.npcId,
      attacker_id: world.playerId,
      amount: 1,
      type: 'slashing',
      source: weaponSlug,
    },
    { ...baseCtx(world), turnId: playerWeaponTurn },
  );
  if (!playerWeaponDamage.ok) {
    throw new Error(
      `player weapon damage failed despite held weapon: ${playerWeaponDamage.error}`,
    );
  }

  return {
    npcPayment: (npcPayment.data as Record<string, unknown>)['transferred'],
    npcWeaponRejected: missingNpcWeapon.error,
    playerWeaponRejected: missingPlayerWeapon.error,
    weaponSlug,
  };
}

async function checkDynamicItemMaterialization(
  world: SupportWorld,
): Promise<unknown> {
  const itemName = `Support Smoke Notebook ${world.suffix}`;
  const created = await dispatch(
    'create_entity',
    {
      kind: 'item',
      display_name: itemName,
      summary: 'Support smoke dynamic notebook.',
      profile: {
        holder_entity_id: world.locationId,
        count: 1,
        provenance: 'Placed in the current support-smoke location.',
      },
      tags: ['quest-item'],
    },
    baseCtx(world),
  );
  if (!created.ok) {
    throw new Error(`dynamic item create_entity failed: ${created.error}`);
  }
  const createdData = created.data as Record<string, unknown>;
  const itemEntityId = Number(createdData['id']);
  const inventoryItem = createdData['inventory_item'] as
    | Record<string, unknown>
    | undefined;
  const slug = String(inventoryItem?.['slug'] ?? '');
  if (!Number.isInteger(itemEntityId) || itemEntityId <= 0 || !slug) {
    throw new Error(
      `create_entity did not return inventory item data: ${JSON.stringify(createdData)}`,
    );
  }

  const itemRows = await query<{
    id: number;
    slug: string;
    legacy_entity_id: number;
  }>(
    `SELECT id, slug, legacy_entity_id
       FROM items
      WHERE legacy_entity_id = $1`,
    [itemEntityId],
  );
  if (itemRows.rows[0]?.slug !== slug) {
    throw new Error(
      `dynamic item missing items bridge: ${JSON.stringify(itemRows.rows)}`,
    );
  }

  const placedRows = await query<{ count: number | string }>(
    `SELECT count
       FROM inventory_entries
      WHERE holder_entity_id = $1
        AND item_entity_id = $2`,
    [world.locationId, itemEntityId],
  );
  if (Number(placedRows.rows[0]?.count ?? 0) !== 1) {
    throw new Error(
      `dynamic item was not placed in holder inventory: ${JSON.stringify(placedRows.rows)}`,
    );
  }

  const take = await dispatch(
    'inventory_transfer',
    {
      from: world.locationName,
      to_player_id: world.playerId,
      item: itemName,
      count: 1,
      reason: 'Support smoke takes materialized notebook.',
    },
    baseCtx(world),
  );
  if (!take.ok) {
    throw new Error(
      `materialized item transfer to player failed: ${take.error}`,
    );
  }

  const give = await dispatch(
    'give_to_npc',
    {
      item_slug: slug,
      npc: world.npcName,
      quantity: 1,
    },
    baseCtx(world),
  );
  if (!give.ok) {
    throw new Error(`materialized item give_to_npc failed: ${give.error}`);
  }

  const npcRows = await query<{ count: number | string }>(
    `SELECT count
       FROM inventory_entries
      WHERE holder_entity_id = $1
        AND item_entity_id = $2`,
    [world.npcId, itemEntityId],
  );
  if (Number(npcRows.rows[0]?.count ?? 0) !== 1) {
    throw new Error(
      `NPC did not receive materialized item: ${JSON.stringify(npcRows.rows)}`,
    );
  }

  const duplicateName = `Support Smoke Duplicate Lens ${world.suffix}`;
  const duplicateSlug = duplicateName
    .trim()
    .replace(/'/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
  const canonicalDuplicate = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'item', $1, 'Support smoke canonical duplicate item.',
       '{"inventory_item":true,"category":"material"}'::jsonb,
       ARRAY['item','material'],
       'support-smoke', false
     )
     RETURNING id`,
    [duplicateName],
  );
  const staleHeldDuplicate = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'item', $1, 'Support smoke stale held duplicate item.',
       '{"inventory_item":true,"category":"material"}'::jsonb,
       ARRAY['item','material'],
       'support-smoke', false
     )
     RETURNING id`,
    [duplicateName],
  );
  await query(
    `INSERT INTO items
       (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
     VALUES ($1, 'material', 0, true, 99, '{}'::jsonb, $2)`,
    [duplicateSlug, canonicalDuplicate.rows[0]!.id],
  );
  await query(
    `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count, metadata)
     VALUES ($1, $2, 1, '{"source":"support_smoke_stale_duplicate"}'::jsonb)`,
    [world.locationId, staleHeldDuplicate.rows[0]!.id],
  );
  const duplicateTake = await dispatch(
    'inventory_transfer',
    {
      from: world.locationName,
      to_player_id: world.playerId,
      item: duplicateName,
      count: 1,
      reason: 'Support smoke takes the holder-specific duplicate item.',
    },
    baseCtx(world),
  );
  if (!duplicateTake.ok) {
    throw new Error(
      `duplicate holder item transfer chose the wrong legacy entity: ${duplicateTake.error}`,
    );
  }

  const directPlayer = await dispatch(
    'create_entity',
    {
      kind: 'item',
      display_name: `Support Smoke Direct Player Item ${world.suffix}`,
      summary: 'Support smoke invalid direct player holder.',
      profile: {
        holder_entity_id: world.playerId,
        provenance: 'Invalid direct player grant fixture.',
      },
      tags: ['quest-item'],
    },
    baseCtx(world),
  );
  if (
    directPlayer.ok ||
    !directPlayer.error?.includes('item_spawn_direct_player_holder')
  ) {
    throw new Error(
      `direct player item spawn was not rejected: ${JSON.stringify(directPlayer)}`,
    );
  }

  const fixtureName = `Support Smoke Fixture Item ${world.suffix}`;
  const fixture = await dispatch(
    'create_entity',
    {
      kind: 'item',
      display_name: fixtureName,
      summary: 'Support smoke fixture item.',
      profile: { holder_entity_id: world.locationId },
      tags: ['fixture', 'obstacle'],
    },
    baseCtx(world),
  );
  if (!fixture.ok) {
    throw new Error(`fixture create_entity failed: ${fixture.error}`);
  }
  const fixtureEntityId = Number(
    (fixture.data as Record<string, unknown>)['id'],
  );
  const fixtureBridge = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM items
      WHERE legacy_entity_id = $1`,
    [fixtureEntityId],
  );
  if (fixtureBridge !== 0) {
    throw new Error(
      'fixture item was incorrectly materialized as inventory item',
    );
  }

  return {
    itemEntityId,
    slug,
    transferred: (give.data as Record<string, unknown>)['transferred'],
    duplicateTransferred: (duplicateTake.data as Record<string, unknown>)[
      'transferred'
    ],
    directPlayerRejected: directPlayer.error,
  };
}

async function checkDeliveryQuestItemState(
  world: SupportWorld,
): Promise<unknown> {
  const turnId = `support-smoke-delivery-quest-item-${world.suffix}`;
  const queue = await insertReadyAdventureQueue({
    world,
    turnId,
    adventureKind: 'quest_complication',
  });
  const itemName = `Support Smoke Delivery Crate ${world.suffix}`;
  const blueprint: AdventureBlueprint = {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: queue.id,
    adventureKind: 'quest_complication',
    title: `Support Delivery ${world.suffix}`,
    summary: 'Support smoke delivery quest with a concrete carried item.',
    playerFacingHook: `@${world.npcName} offers a delivery job involving @${itemName}.`,
    danger: 'risky',
    suggestedQuest: {
      mode: 'create_new',
      source: 'npc_giver',
      giverEntityId: world.npcId,
      title: `Support Delivery ${world.suffix}`,
      summary: 'Deliver the support-smoke crate without losing track of it.',
      goal_text: `Carry @${itemName} only after the item state changes holder.`,
      stages: [
        {
          id: 'accept_delivery',
          title: 'Accept delivery',
          next_stage: 'carry_item',
        },
        { id: 'carry_item', title: 'Carry the item', next_stage: 'hand_off' },
        { id: 'hand_off', title: 'Hand off the item' },
      ],
      tags: ['delivery'],
    },
    itemPlacements: [
      {
        itemDisplayName: itemName,
        holderEntityId: world.npcId,
        count: 1,
      },
    ],
  };

  await markAdventureReady(queue.id, blueprint);
  const applied = await applyReadyAdventureBlueprint(queue.id, {
    sessionId: world.sessionId,
    playerId: world.playerId,
    turnId,
    signal: world.session.activeTurn?.abortController.signal,
  });
  if (!applied.ok) {
    throw new Error(
      `delivery quest blueprint failed: ${applied.reason} ${applied.message ?? ''}`,
    );
  }
  const questId = readObjectNumber(applied.questResult, 'quest_id');
  if (questId == null)
    throw new Error('delivery quest result missing quest_id');

  const questRow = await query<{ profile: Record<string, unknown> }>(
    `SELECT profile FROM entities WHERE id = $1 AND kind = 'quest'`,
    [questId],
  );
  const questItems = Array.isArray(questRow.rows[0]?.profile?.['quest_items'])
    ? (questRow.rows[0]!.profile['quest_items'] as Array<
        Record<string, unknown>
      >)
    : [];
  const linked = questItems.find((item) => item['display_name'] === itemName);
  const itemEntityId = Number(linked?.['entity_id']);
  if (!Number.isInteger(itemEntityId) || itemEntityId <= 0) {
    throw new Error(
      `delivery quest did not link item placement: ${JSON.stringify(questItems)}`,
    );
  }

  const npcHolderRows = await query<{ count: number | string }>(
    `SELECT count
       FROM inventory_entries
      WHERE holder_entity_id = $1
        AND item_entity_id = $2`,
    [world.npcId, itemEntityId],
  );
  if (Number(npcHolderRows.rows[0]?.count ?? 0) !== 1) {
    throw new Error('delivery quest item is not held by the NPC source');
  }
  const playerRows = await query<{ quantity: number | string }>(
    `SELECT COALESCE(SUM(pi.quantity), 0)::int AS quantity
       FROM items i
       JOIN player_inventory pi ON pi.item_id = i.id
      WHERE i.legacy_entity_id = $1
        AND pi.player_id = $2`,
    [itemEntityId, world.playerId],
  );
  if (Number(playerRows.rows[0]?.quantity ?? 0) !== 0) {
    throw new Error('delivery quest item was implicitly granted to the player');
  }

  const activeQuestContext = await renderActiveQuestsState(
    world.playerId,
    'en',
  );
  if (
    !activeQuestContext.includes('Quest items') ||
    !activeQuestContext.includes(itemName) ||
    !activeQuestContext.includes(`@${world.npcName}`)
  ) {
    throw new Error(
      `active quest context did not surface item holder: ${activeQuestContext}`,
    );
  }
  const locationContext = await renderNeighbours(
    world.locationId,
    world.playerId,
    'en',
  );
  if (
    !locationContext.includes('holds:') ||
    !locationContext.includes(itemName)
  ) {
    throw new Error(
      `people-here context did not surface NPC held item: ${locationContext}`,
    );
  }

  const implicitTurnId = `${turnId}-implicit`;
  const implicitQueue = await insertReadyAdventureQueue({
    world,
    turnId: implicitTurnId,
    adventureKind: 'social_hook',
  });
  const implicitItemName = `Support Smoke Sealed Envelope ${world.suffix}`;
  const implicitBlueprint: AdventureBlueprint = {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: implicitQueue.id,
    adventureKind: 'social_hook',
    title: `Support Implicit Delivery ${world.suffix}`,
    summary: 'Support smoke delivery quest without explicit item placement.',
    playerFacingHook: `@${world.npcName} offers a courier job involving @${implicitItemName}.`,
    danger: 'safe',
    suggestedQuest: {
      mode: 'create_new',
      source: 'npc_giver',
      giverEntityId: world.npcId,
      title: `Support Implicit Delivery ${world.suffix}`,
      summary: 'Deliver the support-smoke envelope without losing track of it.',
      goal_text: `Deliver @${implicitItemName} from @${world.npcName} after taking it from the giver.`,
      stages: [
        {
          id: 'accept_delivery',
          title: 'Accept delivery',
          next_stage: 'carry_item',
        },
        { id: 'carry_item', title: 'Carry the item', next_stage: 'hand_off' },
        { id: 'hand_off', title: 'Hand off the item' },
      ],
      tags: ['delivery'],
    },
  };
  await markAdventureReady(implicitQueue.id, implicitBlueprint);
  const implicitApplied = await applyReadyAdventureBlueprint(implicitQueue.id, {
    sessionId: world.sessionId,
    playerId: world.playerId,
    turnId: implicitTurnId,
    signal: world.session.activeTurn?.abortController.signal,
  });
  if (!implicitApplied.ok) {
    throw new Error(
      `implicit delivery quest blueprint failed: ${implicitApplied.reason} ${implicitApplied.message ?? ''}`,
    );
  }
  const implicitQuestId = readObjectNumber(
    implicitApplied.questResult,
    'quest_id',
  );
  if (implicitQuestId == null) {
    throw new Error('implicit delivery quest result missing quest_id');
  }
  const implicitQuestRow = await query<{ profile: Record<string, unknown> }>(
    `SELECT profile FROM entities WHERE id = $1 AND kind = 'quest'`,
    [implicitQuestId],
  );
  const implicitQuestItems = Array.isArray(
    implicitQuestRow.rows[0]?.profile?.['quest_items'],
  )
    ? (implicitQuestRow.rows[0]!.profile['quest_items'] as Array<
        Record<string, unknown>
      >)
    : [];
  const implicitLinked = implicitQuestItems.find(
    (item) => item['display_name'] === implicitItemName,
  );
  const implicitItemEntityId = Number(implicitLinked?.['entity_id']);
  if (!Number.isInteger(implicitItemEntityId) || implicitItemEntityId <= 0) {
    throw new Error(
      `implicit delivery quest did not create/link delivery item: ${JSON.stringify(implicitQuestItems)}`,
    );
  }
  const implicitHolderRows = await query<{ count: number | string }>(
    `SELECT count
       FROM inventory_entries
      WHERE holder_entity_id = $1
        AND item_entity_id = $2`,
    [world.npcId, implicitItemEntityId],
  );
  if (Number(implicitHolderRows.rows[0]?.count ?? 0) !== 1) {
    throw new Error(
      'implicit delivery quest item is not held by the NPC source',
    );
  }

  return {
    questId,
    itemEntityId,
    implicitQuestId,
    implicitItemEntityId,
    holder: world.npcName,
    activeQuestContext: activeQuestContext.includes(itemName),
    peopleHereContext: locationContext.includes(itemName),
  };
}

async function forceCombatSuccess(
  world: SupportWorld,
  turnId: string,
  targetId: number,
  roller: 'player' | 'npc',
): Promise<void> {
  const result = await dispatch(
    'dice_check',
    {
      d: 20,
      modifier: 100,
      dc: 1,
      category: 'combat',
      roller,
      target_id: targetId,
      label: `support smoke forced combat success ${turnId}`,
    },
    { ...baseCtx(world), turnId },
  );
  if (!result.ok) {
    throw new Error(`forced combat dice failed: ${result.error}`);
  }
}

async function checkApplySurfaceSourceGrounding(
  world: SupportWorld,
): Promise<unknown> {
  const activeBefore = world.session.activeTurn;
  const turnId = `support-smoke-surface-source-${world.suffix}`;
  world.session.activeTurn = {
    turnId,
    abortController: new AbortController(),
    startedAt: Date.now(),
    toolHistory: [],
  };
  try {
    const missingSource = await dispatch(
      'apply_surface',
      {
        location: world.locationName,
        type: 'oil',
        severity: 1,
        area: 'central',
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (
      missingSource.ok ||
      !missingSource.error?.includes('surface_source_ungrounded')
    ) {
      throw new Error(
        `apply_surface missing source was not rejected: ${JSON.stringify(missingSource)}`,
      );
    }

    const sourceName = `Support Smoke Oil Lamp ${world.suffix}`;
    const itemEntityId = await insertEntity(
      'item',
      sourceName,
      'Support smoke present source item.',
    );
    await query(
      `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count)
       VALUES ($1, $2, 1)`,
      [world.locationId, itemEntityId],
    );

    const presentSource = await dispatch(
      'apply_surface',
      {
        location: world.locationName,
        type: 'oil',
        severity: 1,
        area: 'central',
        source: sourceName,
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (!presentSource.ok) {
      throw new Error(
        `apply_surface present source was rejected: ${JSON.stringify(presentSource)}`,
      );
    }

    return {
      missingSource: missingSource.error,
      presentSource: (presentSource.data as Record<string, unknown>)[
        'applied_surface'
      ],
    };
  } finally {
    world.session.activeTurn = activeBefore;
  }
}

async function checkNpcVoiceGroundingGuard(): Promise<unknown> {
  const numberVerdict = validateVoiceGrounding(
    {
      voiced_text: 'I saw 3 sealed crates.',
      internal_reflection: '',
      links_to_memory_id: null,
      link_reason: '',
    },
    {
      draftText: 'I saw sealed crates.',
      ownerName: 'Support NPC',
      aboutName: 'Support Player',
      recentUtterances: [],
      pastMemories: [],
    },
  );
  if (
    numberVerdict.ok ||
    !numberVerdict.reason.includes('ungrounded_voice_number')
  ) {
    throw new Error(
      `NPC Voice number grounding did not reject: ${JSON.stringify(numberVerdict)}`,
    );
  }

  const mentionVerdict = validateVoiceGrounding(
    {
      voiced_text: 'I should tell @Unsupported Scout.',
      internal_reflection: '',
      links_to_memory_id: null,
      link_reason: '',
    },
    {
      draftText: 'I should tell someone.',
      ownerName: 'Support NPC',
      aboutName: 'Support Player',
      recentUtterances: [],
      pastMemories: [],
    },
  );
  if (
    mentionVerdict.ok ||
    !mentionVerdict.reason.includes('ungrounded_voice_mention')
  ) {
    throw new Error(
      `NPC Voice mention grounding did not reject: ${JSON.stringify(mentionVerdict)}`,
    );
  }

  const grounded = validateVoiceGrounding(
    {
      voiced_text: 'I saw 2 sealed crates near @Support Player.',
      internal_reflection: '',
      links_to_memory_id: null,
      link_reason: '',
    },
    {
      draftText: 'I saw 2 sealed crates near @Support Player.',
      ownerName: 'Support NPC',
      aboutName: 'Support Player',
      recentUtterances: [],
      pastMemories: [],
    },
  );
  if (!grounded.ok) {
    throw new Error(
      `NPC Voice rejected grounded output: ${JSON.stringify(grounded)}`,
    );
  }

  return {
    numberGuard: numberVerdict.reason,
    mentionGuard: mentionVerdict.reason,
  };
}

async function checkVoiceWardenCandidateGuard(): Promise<unknown> {
  const candidates = ['Support Archivist', 'Support Barkeeper'];
  const accepted = sanitizeSuggestedSpeakerName(
    'Support Archivist',
    candidates,
  );
  const rejected = sanitizeSuggestedSpeakerName('Support Player', candidates);
  const absent = sanitizeSuggestedSpeakerName(null, candidates);
  if (accepted !== 'Support Archivist') {
    throw new Error(`Voice Warden dropped a valid candidate: ${accepted}`);
  }
  if (rejected !== null || absent !== null) {
    throw new Error(
      `Voice Warden accepted a non-candidate speaker: ${JSON.stringify({ rejected, absent })}`,
    );
  }
  return { accepted, rejected };
}

async function checkFinalizationGuardrails(
  world: SupportWorld,
): Promise<unknown> {
  const activeBefore = world.session.activeTurn;
  const turnId = `support-smoke-finalization-${world.suffix}`;
  world.session.activeTurn = {
    turnId,
    abortController: new AbortController(),
    startedAt: Date.now(),
    toolHistory: [],
  };
  try {
    const itemId = await insertSupportItem(world);
    const failedTransfer = await dispatch(
      'inventory_transfer',
      {
        from: world.npcName,
        to_player_id: world.playerId,
        item: `support_coin_${world.suffix}`,
        count: 1,
      },
      { ...baseCtx(world), turnId },
    );
    if (failedTransfer.ok) {
      throw new Error('fixture transfer unexpectedly succeeded');
    }

    const blockedMemory = await dispatch(
      'add_memory',
      {
        owner: world.npcName,
        about: world.playerId,
        text: `Support smoke unsafe paid canon ${world.suffix}`,
        importance: 0.6,
      },
      { ...baseCtx(world), turnId },
    );
    if (
      blockedMemory.ok ||
      !blockedMemory.error?.includes('payment_canon_guard')
    ) {
      throw new Error(
        `failed payment did not block add_memory: ${JSON.stringify(blockedMemory)}`,
      );
    }

    const blockedBatch = await dispatch(
      'batch_mutate_world',
      {
        reason: 'support smoke unsafe payment canon batch',
        atomic: true,
        operations: [
          {
            id: 'canon-memory',
            tool: 'add_memory',
            args: {
              owner: world.npcName,
              about: world.playerId,
              text: `Support smoke unsafe batch paid canon ${world.suffix}`,
              importance: 0.6,
            },
          },
        ],
      },
      { ...baseCtx(world), turnId },
    );
    if (
      blockedBatch.ok ||
      !blockedBatch.error?.includes('payment_canon_guard')
    ) {
      throw new Error(
        `failed payment did not block unsafe batch: ${JSON.stringify(blockedBatch)}`,
      );
    }

    world.session.activeTurn.toolHistory = [
      {
        name: 'apply_surface',
        args: {
          location: world.locationName,
          type: 'fire',
          severity: 1,
          area: 'central',
          source: 'missing torch',
        },
        ok: false,
        error: 'surface_source_ungrounded: support fixture',
        source: 'ai_sdk',
      },
    ];
    const blockedWorldMemory = await dispatch(
      'add_memory',
      {
        owner: world.npcName,
        about: world.playerId,
        text: `Support smoke unsafe world fact canon ${world.suffix}`,
        importance: 0.6,
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (
      blockedWorldMemory.ok ||
      !blockedWorldMemory.error?.includes('world_fact_canon_guard')
    ) {
      throw new Error(
        `failed world fact did not block add_memory: ${JSON.stringify(blockedWorldMemory)}`,
      );
    }

    world.session.activeTurn.toolHistory = [
      { name: 'add_memory', args: {}, ok: true, source: 'ai_sdk' },
      { name: 'award_xp', args: {}, ok: true, source: 'ai_sdk' },
      { name: 'string_award', args: {}, ok: true, source: 'ai_sdk' },
      { name: 'set_runtime_field', args: {}, ok: true, source: 'ai_sdk' },
      { name: 'advance_quest', args: {}, ok: true, source: 'ai_sdk' },
    ];
    const overBudget = await dispatch(
      'award_xp',
      {
        player_id: world.playerId,
        amount: 1,
        reason: 'support smoke over budget',
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (
      overBudget.ok ||
      !overBudget.error?.includes('mutation_budget_exceeded')
    ) {
      throw new Error(
        `mutation budget did not reject: ${JSON.stringify(overBudget)}`,
      );
    }

    world.session.activeTurn.brokerToolProfile = 'scene_trade';
    world.session.activeTurn.toolHistory = [];
    const blockedWrongSalePayment = await dispatch(
      'batch_mutate_world',
      {
        reason: 'support smoke wrong scene-trade payment direction',
        atomic: true,
        operations: [
          {
            id: 'pay-wrong-way',
            tool: 'inventory_transfer',
            args: {
              from_player_id: world.playerId,
              to: world.npcName,
              item: itemId,
              count: 4,
              reason: 'wrong-way sale payment',
            },
          },
          {
            id: 'handoff-item',
            tool: 'inventory_transfer',
            args: {
              from_player_id: world.playerId,
              to: world.npcName,
              item: `Support Smoke Relic ${world.suffix}`,
              count: 1,
              reason: 'player sells scene relic',
            },
          },
        ],
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (
      blockedWrongSalePayment.ok ||
      !blockedWrongSalePayment.error?.includes(
        'scene_trade_payment_direction_guard',
      )
    ) {
      throw new Error(
        `wrong scene-trade payment direction was not rejected: ${JSON.stringify(blockedWrongSalePayment)}`,
      );
    }

    world.session.activeTurn.toolHistory = [];
    const blockedMintedBuyerFunds = await dispatch(
      'batch_mutate_world',
      {
        reason: 'support smoke scene-trade unproven buyer funds',
        atomic: true,
        operations: [
          {
            id: 'mint-buyer-funds',
            tool: 'inventory_transfer',
            args: {
              from: null,
              to: world.npcId,
              item: itemId,
              count: 50,
              reason: 'unsupported buyer till mint',
            },
          },
          {
            id: 'pay-player',
            tool: 'inventory_transfer',
            args: {
              from: world.npcId,
              to_player_id: world.playerId,
              item: itemId,
              count: 4,
              reason: 'buyer pays player',
            },
          },
          {
            id: 'take-relic',
            tool: 'inventory_transfer',
            args: {
              from_player_id: world.playerId,
              to: world.npcId,
              item: `Support Smoke Relic ${world.suffix}`,
              count: 1,
              reason: 'player sells scene relic',
            },
          },
        ],
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (
      blockedMintedBuyerFunds.ok ||
      !blockedMintedBuyerFunds.error?.includes('scene_trade_buyer_funds_guard')
    ) {
      throw new Error(
        `scene-trade minted buyer funds were not rejected: ${JSON.stringify(blockedMintedBuyerFunds)}`,
      );
    }

    world.session.activeTurn.toolHistory = [];
    const sceneRelic = await insertSupportRelicAtLocation(world);
    const locationIdBatch = await dispatch(
      'batch_mutate_world',
      {
        reason: 'support smoke scene item pickup via canonical location id',
        atomic: true,
        operations: [
          {
            id: 'pickup-scene-relic',
            tool: 'inventory_transfer',
            args: {
              from: world.locationId,
              to_player_id: world.playerId,
              item: sceneRelic.entityId,
              count: 1,
              reason: 'support smoke validates canonical batch child transfer',
            },
          },
        ],
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (!locationIdBatch.ok) {
      throw new Error(
        `canonical location id batch transfer failed: ${JSON.stringify(locationIdBatch)}`,
      );
    }
    const playerRelicQty = await readPlayerItemQuantity(
      world.playerId,
      sceneRelic.slug,
    );
    const locationRelicQty = await readLegacyInventoryQuantity(
      world.locationId,
      sceneRelic.entityId,
    );
    if (playerRelicQty !== 1 || locationRelicQty !== 1) {
      throw new Error(
        `canonical location transfer wrote wrong counts: ${JSON.stringify({ playerRelicQty, locationRelicQty })}`,
      );
    }

    const rejectedInventedAliasBatch = await dispatch(
      'batch_mutate_world',
      {
        reason: 'support smoke rejects invented inventory_transfer keys',
        atomic: true,
        operations: [
          {
            id: 'pickup-scene-relic-alias',
            tool: 'inventory_transfer',
            args: {
              from_location_id: world.locationId,
              to_player_id: world.playerId,
              item: sceneRelic.entityId,
              count: 1,
              reason: 'invented alias key must be rejected',
            },
          },
        ],
      },
      { ...baseCtx(world), turnId, toolHistorySource: 'ai_sdk' },
    );
    if (
      rejectedInventedAliasBatch.ok ||
      !rejectedInventedAliasBatch.error?.includes('from_location_id')
    ) {
      throw new Error(
        `invented inventory_transfer key was not rejected: ${JSON.stringify(rejectedInventedAliasBatch)}`,
      );
    }
    const playerRelicQtyAfterRejectedAlias = await readPlayerItemQuantity(
      world.playerId,
      sceneRelic.slug,
    );
    const locationRelicQtyAfterRejectedAlias =
      await readLegacyInventoryQuantity(world.locationId, sceneRelic.entityId);
    if (
      playerRelicQtyAfterRejectedAlias !== playerRelicQty ||
      locationRelicQtyAfterRejectedAlias !== locationRelicQty
    ) {
      throw new Error(
        `rejected alias transfer changed inventory: ${JSON.stringify({
          playerRelicQty,
          locationRelicQty,
          playerRelicQtyAfterRejectedAlias,
          locationRelicQtyAfterRejectedAlias,
        })}`,
      );
    }

    world.session.activeTurn.toolHistory = [];
    world.session.activeTurn.brokerToolProfile = undefined;
    const beforeChat = await countRows(
      `SELECT COUNT(*)::int AS count FROM chat_messages WHERE session_id = $1 AND payload->>'turn_id' = $2`,
      [world.sessionId, turnId],
    );
    const badNarrate = await dispatch(
      'narrate',
      {
        author: world.npcName,
        tone: 'npc',
        text: `@${world.npcName} is framed from outside for support smoke. The scene describes posture, distance, and consequence rather than a matching speaker bubble.`,
        done: true,
      },
      { ...baseCtx(world), turnId },
    );
    if (badNarrate.ok || !badNarrate.error?.includes('voice/author mismatch')) {
      throw new Error(
        `deterministic voice guard did not reject: ${JSON.stringify(badNarrate)}`,
      );
    }
    const afterChat = await countRows(
      `SELECT COUNT(*)::int AS count FROM chat_messages WHERE session_id = $1 AND payload->>'turn_id' = $2`,
      [world.sessionId, turnId],
    );
    if (afterChat !== beforeChat) {
      throw new Error('rejected voice mismatch persisted a chat row');
    }

    return {
      itemId,
      paymentGuard: blockedMemory.error,
      batchGuard: blockedBatch.error,
      worldFactGuard: blockedWorldMemory.error,
      budgetGuard: overBudget.error,
      sceneTradeGuard: blockedWrongSalePayment.error,
      sceneTradeBuyerFundsGuard: blockedMintedBuyerFunds.error,
      canonicalLocationBatch: locationIdBatch.ok,
      rejectedInventedAlias: rejectedInventedAliasBatch.error,
      voiceGuard: badNarrate.error,
    };
  } finally {
    world.session.activeTurn = activeBefore;
  }
}

async function checkRuntimeContextPlayerScope(
  world: SupportWorld,
): Promise<unknown> {
  const narrateTurnId = `support-smoke-scope-narrate-${world.suffix}`;
  const narrateResult = await dispatch(
    'narrate',
    {
      author: world.npcName,
      tone: 'npc',
      text: `I keep this support line scoped to ${world.playerName}.`,
      done: true,
    },
    { ...baseCtx(world), turnId: narrateTurnId },
  );
  if (!narrateResult.ok) {
    throw new Error(`scope narrate failed: ${JSON.stringify(narrateResult)}`);
  }
  const narrateRows = await query<{
    player_id: number | string | null;
    location_entity_id: number | string | null;
    npc_entity_id: number | string | null;
  }>(
    `SELECT player_id, location_entity_id, npc_entity_id
       FROM chat_messages
      WHERE session_id = $1 AND payload->>'turn_id' = $2
      ORDER BY id DESC
      LIMIT 1`,
    [world.sessionId, narrateTurnId],
  );
  const narrateRow = narrateRows.rows[0];
  if (!narrateRow) throw new Error('scope narrate row not persisted');
  if (Number(narrateRow.player_id) !== world.playerId) {
    throw new Error(
      `narrate player_id not scoped: ${JSON.stringify(narrateRow)}`,
    );
  }
  if (Number(narrateRow.location_entity_id) !== world.locationId) {
    throw new Error(
      `narrate location_entity_id not scoped: ${JSON.stringify(narrateRow)}`,
    );
  }
  if (Number(narrateRow.npc_entity_id) !== world.npcId) {
    throw new Error(
      `narrate npc_entity_id not scoped: ${JSON.stringify(narrateRow)}`,
    );
  }

  const otherPlayerId = await insertEntity(
    'player',
    `Support Smoke Stale Player ${world.suffix}`,
    'Wrong-player support smoke fixture.',
  );
  await query(
    `INSERT INTO players (entity_id, public_id, current_location_id)
     VALUES ($1, $2, $3)`,
    [otherPlayerId, randomUUID(), world.locationId],
  );

  const currentMarker = `CURRENT_SCOPE_MARKER_${world.suffix}`;
  const staleMarker = `STALE_SCOPE_LEAK_${world.suffix}`;
  const turnIndex = await query<{ n: number }>(
    `SELECT COALESCE(MAX(turn_index), 0) + 1 AS n
       FROM chat_messages WHERE session_id = $1`,
    [world.sessionId],
  );
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload, player_id)
     VALUES ($1, $2, 'player', $3, $4, '{}'::jsonb, $5)`,
    [
      world.sessionId,
      world.playerId,
      currentMarker,
      turnIndex.rows[0]!.n,
      world.playerId,
    ],
  );
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload, player_id)
     VALUES ($1, $2, 'player', $3, $4, '{}'::jsonb, $5)`,
    [
      world.sessionId,
      otherPlayerId,
      `${staleMarker}_OWNED`,
      turnIndex.rows[0]!.n + 1,
      otherPlayerId,
    ],
  );
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload, player_id)
     VALUES ($1, $2, 'player', $3, $4, '{}'::jsonb, NULL)`,
    [
      world.sessionId,
      otherPlayerId,
      `${staleMarker}_LEGACY_NULL`,
      turnIndex.rows[0]!.n + 2,
    ],
  );

  const context = await buildTurnContext(world.sessionId, world.playerId, {
    dialogueHistoryLimit: 12,
  });
  if (!context.dynamic.includes(currentMarker)) {
    throw new Error('current player marker missing from turn context');
  }
  if (context.dynamic.includes(staleMarker)) {
    throw new Error('wrong-player marker leaked into turn context');
  }

  const excludedTurnId = `support-smoke-current-turn-${world.suffix}`;
  const excludedMarker = `EXCLUDED_CURRENT_TURN_MARKER_${world.suffix}`;
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload, player_id)
     VALUES ($1, $2, 'player', $3, $4, $5::jsonb, $6)`,
    [
      world.sessionId,
      world.playerId,
      excludedMarker,
      turnIndex.rows[0]!.n + 3,
      JSON.stringify({ turn_id: excludedTurnId }),
      world.playerId,
    ],
  );
  const excludedContext = await buildTurnContext(
    world.sessionId,
    world.playerId,
    {
      dialogueHistoryLimit: 12,
      excludeTurnId: excludedTurnId,
    },
  );
  if (excludedContext.dynamic.includes(excludedMarker)) {
    throw new Error('current turn marker leaked into broker dialogue history');
  }
  if (!excludedContext.dynamic.includes(currentMarker)) {
    throw new Error('excluding current turn removed prior player history');
  }
  await query(
    `DELETE FROM chat_messages
      WHERE session_id = $1 AND payload->>'turn_id' = $2`,
    [world.sessionId, excludedTurnId],
  );

  const questTurnId = `support-smoke-scope-quest-${world.suffix}`;
  const questTitle = `Scope Quest ${world.suffix}`.slice(0, 80);
  const questResult = await dispatch(
    'create_quest',
    {
      title: questTitle,
      summary: `Support smoke quest summary ${world.suffix}`,
      giver: world.npcName,
      stages: [{ id: 'open', title: 'Open' }],
      auto_start: false,
      tags: [],
    },
    { ...baseCtx(world), turnId: questTurnId },
  );
  if (!questResult.ok) {
    throw new Error(
      `scope create_quest failed: ${JSON.stringify(questResult)}`,
    );
  }
  const data = questResult.data as Record<string, unknown>;
  const goalText = String(data['goal_text'] ?? '');
  if (!goalText.includes(currentMarker)) {
    throw new Error(`generated goal_text missed current marker: ${goalText}`);
  }
  if (goalText.includes(staleMarker)) {
    throw new Error(`generated goal_text included stale marker: ${goalText}`);
  }

  return {
    narratePlayerId: Number(narrateRow.player_id),
    contextScoped: true,
    questId: data['quest_id'],
  };
}

async function checkSessionResetLifecycle(
  world: SupportWorld,
): Promise<unknown> {
  const turnId = `support-smoke-reset-${world.suffix}`;
  await insertChatMessage(
    world,
    world.playerId,
    'player',
    'support reset chat fixture',
    900,
  );
  await query(
    `INSERT INTO gui_events
       (session_id, player_id, turn_id, lane, phase, event_type, payload)
     VALUES ($1, $2, $3, 'post_response', 'support', 'support:reset_fixture',
             '{}'::jsonb)`,
    [world.sessionId, world.playerId, turnId],
  );
  await query(
    `INSERT INTO tool_invocations
       (session_id, player_id, turn_id, tool_name, args, result, duration_ms)
     VALUES ($1, $2, $3, 'support_reset_tool', '{}'::jsonb, '{}'::jsonb, 1)`,
    [world.sessionId, world.playerId, turnId],
  );
  await query(
    `INSERT INTO turn_telemetry
       (session_id, turn_id, role, model_id, input_tokens, output_tokens,
        duration_ms, cost_usd)
     VALUES ($1, $2, 'broker', 'support-smoke', 1, 1, 1, 0)`,
    [world.sessionId, turnId],
  );
  await query(
    `INSERT INTO performance_events
       (session_id, player_id, turn_id, kind, phase, status, duration_ms,
        metadata)
     VALUES ($1, $2, $3, 'support', 'support.reset_fixture', 'ok', 1,
             '{}'::jsonb)`,
    [world.sessionId, world.playerId, turnId],
  );
  await query(
    `INSERT INTO telemetry_sessions
       (session_id, player_id, build_id, app_version, cartridge_id,
        cartridge_version, consent_mode, attributes)
     VALUES ($1, $2, 'support-smoke', 'support-smoke',
             'support-cartridge', 'support-smoke', 'local_only',
             '{}'::jsonb)`,
    [world.sessionId, world.playerId],
  );
  await query(
    `INSERT INTO telemetry_spans
       (trace_id, span_id, session_id, player_id, turn_id, name, kind,
        status, started_at, ended_at, duration_ms, attributes, source)
     VALUES ($1, $2, $3, $4, $5, 'support.reset_fixture', 'internal',
             'ok', now(), now(), 1, '{}'::jsonb, 'support_smoke')`,
    [
      `support-trace-${world.suffix}`,
      `support-span-${world.suffix}`,
      world.sessionId,
      world.playerId,
      turnId,
    ],
  );
  await query(
    `INSERT INTO telemetry_events
       (trace_id, span_id, session_id, player_id, turn_id, schema_name,
        schema_version, category, event_name, properties, source)
     VALUES ($1, $2, $3, $4, $5, 'support.reset', 1, 'support',
             'support.reset_fixture', '{}'::jsonb, 'support_smoke')`,
    [
      `support-trace-${world.suffix}`,
      `support-span-${world.suffix}`,
      world.sessionId,
      world.playerId,
      turnId,
    ],
  );
  await query(
    `INSERT INTO telemetry_metrics
       (trace_id, session_id, player_id, turn_id, name, unit, aggregation,
        count, sum, attributes, source)
     VALUES ($1, $2, $3, $4, 'support.reset_fixture', 'count', 'raw',
             1, 1, '{}'::jsonb, 'support_smoke')`,
    [`support-trace-${world.suffix}`, world.sessionId, world.playerId, turnId],
  );
  const resetArtifact = await writeTelemetryJsonArtifact({
    artifactType: 'support_reset_fixture',
    filenamePrefix: 'support-reset',
    payload: { support_smoke: true, turnId },
    context: {
      traceId: `support-trace-${world.suffix}`,
      spanId: `support-span-${world.suffix}`,
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId,
    },
    source: 'support_smoke',
  });
  await query(
    `INSERT INTO telemetry_eval_scores
       (trace_id, span_id, session_id, player_id, turn_id, evaluator_id,
        evaluator_version, score, label, metadata, source)
     VALUES ($1, $2, $3, $4, $5, 'support.reset', '1', 1, 'pass',
             '{}'::jsonb, 'support_smoke')`,
    [
      `support-trace-${world.suffix}`,
      `support-span-${world.suffix}`,
      world.sessionId,
      world.playerId,
      turnId,
    ],
  );
  await query(
    `INSERT INTO turn_ingress_queue
       (session_id, player_id, turn_id, status, text, queue_index)
     VALUES ($1, $2, $3, 'queued', 'support reset queued turn', 900001)`,
    [world.sessionId, world.playerId, `${turnId}-queued`],
  );
  const queueRow = await query<{ id: number | string }>(
    `INSERT INTO adventure_queue
       (session_id, player_id, turn_id, status, source, adventure_kind,
        priority, seed, sequence, table_id, roll_result, context_snapshot,
        dedupe_key)
     VALUES ($1, $2, $3, 'queued', 'manual_debug', 'quest_hook',
             50, $4, 1, $5, '{}'::jsonb, '{}'::jsonb, $6)
     RETURNING id`,
    [
      world.sessionId,
      world.playerId,
      turnId,
      `reset-seed-${world.suffix}`,
      ADVENTURE_TABLE_ID,
      `support-reset:${world.suffix}`,
    ],
  );
  await query(
    `INSERT INTO adventure_oracle_rolls
       (adventure_queue_id, session_id, player_id, turn_id, seed, sequence,
        die, raw_roll, table_id, candidates, selected_kind)
     VALUES ($1, $2, $3, $4, $5, 1, 'd20', 7, $6, '[]'::jsonb, 'quest_hook')`,
    [
      Number(queueRow.rows[0]!.id),
      world.sessionId,
      world.playerId,
      turnId,
      `reset-seed-${world.suffix}`,
      ADVENTURE_TABLE_ID,
    ],
  );
  await query(
    `UPDATE players
        SET dialogue_partner_id = $1,
            metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'dialogue_participants',
                         jsonb_build_object(
                           'focused_partner_id', $1::bigint,
                           'participant_ids', jsonb_build_array($1::bigint),
                           'updated_at_turn', $2::text,
                           'source', 'tool'
                         )
                       )
      WHERE entity_id = $3`,
    [world.npcId, turnId, world.playerId],
  );

  world.session.activeTurn = {
    turnId,
    abortController: new AbortController(),
    startedAt: Date.now(),
    done: sleep(5),
  };
  openPresentationBarrier(world.session, {
    turnId,
    pendingVisibleSlots: 1,
    deadlineMs: 10_000,
  });
  if (!currentPresentationBarrier(world.session)) {
    throw new Error('reset smoke failed to open presentation barrier');
  }

  const before = await sessionResetCounts(world.sessionId);
  for (const [table, count] of Object.entries(before)) {
    if (count < 1) {
      throw new Error(`reset smoke fixture missing ${table} rows`);
    }
  }

  const result = await resetSessionState(world.session, world.playerId, {
    turnWaitMs: 250,
  });
  const after = await sessionResetCounts(world.sessionId);
  const survivors = Object.entries(after).filter(([, count]) => count !== 0);
  if (survivors.length > 0) {
    throw new Error(`session reset survivors: ${JSON.stringify(survivors)}`);
  }
  if (world.session.activeTurn) {
    throw new Error('session reset left activeTurn attached');
  }
  if (world.session.resetTurnIds.has(turnId)) {
    throw new Error('session reset left settled reset turn id in memory');
  }
  if (currentPresentationBarrier(world.session)) {
    throw new Error('session reset left presentation barrier open');
  }
  if (await fileExists(resetArtifact.path)) {
    throw new Error(
      `session reset left telemetry artifact file: ${resetArtifact.path}`,
    );
  }

  const player = await query<{
    dialogue_partner_id: number | null;
    metadata: Record<string, unknown> | null;
  }>(`SELECT dialogue_partner_id, metadata FROM players WHERE entity_id = $1`, [
    world.playerId,
  ]);
  const row = player.rows[0];
  const dialogueState = row?.metadata?.['dialogue_participants'] as
    | Record<string, unknown>
    | undefined;
  if (row?.dialogue_partner_id != null) {
    throw new Error('session reset left dialogue_partner_id set');
  }
  if (dialogueState?.['source'] !== 'session_reset') {
    throw new Error('session reset did not mark dialogue state source');
  }
  if (
    !Array.isArray(dialogueState?.['participant_ids']) ||
    dialogueState['participant_ids'].length !== 0
  ) {
    throw new Error('session reset left dialogue participants set');
  }

  return {
    cancelledTurnId: result.cancelledTurnId,
    activeTurnTimedOut: result.activeTurnTimedOut,
    before,
    after,
  };
}

async function sessionResetCounts(
  sessionId: string,
): Promise<Record<string, number>> {
  return {
    chat_messages: await countRows(
      `SELECT COUNT(*)::int AS count FROM chat_messages WHERE session_id = $1`,
      [sessionId],
    ),
    gui_events: await countRows(
      `SELECT COUNT(*)::int AS count FROM gui_events WHERE session_id = $1`,
      [sessionId],
    ),
    tool_invocations: await countRows(
      `SELECT COUNT(*)::int AS count FROM tool_invocations WHERE session_id = $1`,
      [sessionId],
    ),
    turn_telemetry: await countRows(
      `SELECT COUNT(*)::int AS count FROM turn_telemetry WHERE session_id = $1`,
      [sessionId],
    ),
    performance_events: await countRows(
      `SELECT COUNT(*)::int AS count FROM performance_events WHERE session_id = $1`,
      [sessionId],
    ),
    telemetry_sessions: await countRows(
      `SELECT COUNT(*)::int AS count FROM telemetry_sessions WHERE session_id = $1`,
      [sessionId],
    ),
    telemetry_spans: await countRows(
      `SELECT COUNT(*)::int AS count FROM telemetry_spans WHERE session_id = $1`,
      [sessionId],
    ),
    telemetry_events: await countRows(
      `SELECT COUNT(*)::int AS count FROM telemetry_events WHERE session_id = $1`,
      [sessionId],
    ),
    telemetry_metrics: await countRows(
      `SELECT COUNT(*)::int AS count FROM telemetry_metrics WHERE session_id = $1`,
      [sessionId],
    ),
    telemetry_artifacts: await countRows(
      `SELECT COUNT(*)::int AS count FROM telemetry_artifacts WHERE session_id = $1`,
      [sessionId],
    ),
    telemetry_eval_scores: await countRows(
      `SELECT COUNT(*)::int AS count FROM telemetry_eval_scores WHERE session_id = $1`,
      [sessionId],
    ),
    turn_ingress_queue: await countRows(
      `SELECT COUNT(*)::int AS count FROM turn_ingress_queue WHERE session_id = $1`,
      [sessionId],
    ),
    adventure_queue: await countRows(
      `SELECT COUNT(*)::int AS count FROM adventure_queue WHERE session_id = $1`,
      [sessionId],
    ),
    adventure_oracle_rolls: await countRows(
      `SELECT COUNT(*)::int AS count FROM adventure_oracle_rolls WHERE session_id = $1`,
      [sessionId],
    ),
  };
}

async function checkResetWorldDynamicCleanup(
  world: SupportWorld,
): Promise<unknown> {
  const npcStringsFieldId = await insertRuntimeField(
    world.npcId,
    `support_strings_${world.suffix}`,
    'json',
    {},
    'permanent',
  );
  const locationPlayerListFieldId = await insertRuntimeField(
    world.locationId,
    `support_player_ids_${world.suffix}`,
    'json',
    [],
    'permanent',
  );
  await query(
    `INSERT INTO runtime_values (field_id, value, source)
     VALUES
       ($1, $2::jsonb, 'support_dirty_surface'),
       ($3, $4::jsonb, 'support_dirty_strings'),
       ($5, $6::jsonb, 'support_dirty_player_list'),
       ($7, $8::jsonb, 'support_dirty_player_field')
     ON CONFLICT (field_id)
       DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`,
    [
      world.surfaceFieldId,
      JSON.stringify([{ tag: 'oil', source: `player:${world.playerId}` }]),
      npcStringsFieldId,
      JSON.stringify({ [String(world.playerId)]: 3 }),
      locationPlayerListFieldId,
      JSON.stringify([world.playerId]),
      world.signalFieldId,
      JSON.stringify('dirty'),
    ],
  );
  await query(
    `INSERT INTO player_proficient_skills (player_id, skill_name, proficiency_level)
     VALUES ($1, 'Support Smoke Skill', 1)
     ON CONFLICT (player_id, skill_name)
       DO UPDATE SET proficiency_level = EXCLUDED.proficiency_level`,
    [world.playerId],
  );

  const dynamicTagged = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'item', $1, 'Dynamic tagged support item.',
       '{}'::jsonb, ARRAY['dynamic']::text[],
       NULL, true
     )
     RETURNING id`,
    [`Support Smoke Dynamic Tagged ${world.suffix}`],
  );
  const dynamicOrigin = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'quest', $1, 'Dynamic origin support quest.',
       '{"origin":"dynamic"}'::jsonb, ARRAY['quest']::text[],
       NULL, true
     )
     RETURNING id`,
    [`Support Smoke Dynamic Origin ${world.suffix}`],
  );
  await query(
    `INSERT INTO transitions
       (owner_entity_id, description, when_json, set_json, goto_entity_id, priority)
     VALUES ($1, 'support dynamic goto', '{}'::jsonb, '{}'::jsonb, $2, 1)`,
    [world.locationId, dynamicTagged.rows[0]!.id],
  );

  const before = await countDynamicEntities();
  if (before < 2)
    throw new Error(`expected dynamic fixtures before reset, got ${before}`);

  const result = await resetWorldState();
  const after = await countDynamicEntities();
  if (after !== 0) {
    throw new Error(`dynamic entities survived reset: ${after}`);
  }
  if (result.dynamicEntitiesRemoved < 2) {
    throw new Error(
      `reset reported too few dynamic removals: ${result.dynamicEntitiesRemoved}`,
    );
  }
  const transitionRows = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM transitions
      WHERE goto_entity_id = $1`,
    [dynamicTagged.rows[0]!.id],
  );
  if (Number(transitionRows.rows[0]?.count ?? 0) !== 0) {
    throw new Error('transition pointing to dynamic entity survived reset');
  }
  const supportLocation = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM entities WHERE id = $1`,
    [world.locationId],
  );
  if (Number(supportLocation.rows[0]?.count ?? 0) !== 1) {
    throw new Error('non-dynamic cartridge/support entity was removed');
  }
  const survivors = {
    players: await countRows(`SELECT COUNT(*)::int AS count FROM players`, []),
    player_proficient_skills: await countRows(
      `SELECT COUNT(*)::int AS count FROM player_proficient_skills`,
      [],
    ),
    player_runtime_fields: await countRows(
      `SELECT COUNT(*)::int AS count
         FROM runtime_fields
        WHERE owner_entity_id = $1`,
      [world.playerId],
    ),
    player_runtime_values: await countRows(
      `SELECT COUNT(*)::int AS count
         FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1`,
      [world.playerId],
    ),
  };
  const nonZeroSurvivors = Object.entries(survivors).filter(
    ([, count]) => count !== 0,
  );
  if (nonZeroSurvivors.length > 0) {
    throw new Error(
      `player-owned reset survivors: ${JSON.stringify(nonZeroSurvivors)}`,
    );
  }
  const staticRuntime = await query<{
    surface_value: unknown;
    strings_value: unknown;
    player_list_value: unknown;
  }>(
    `SELECT
       (SELECT value FROM runtime_values WHERE field_id = $1) AS surface_value,
       (SELECT value FROM runtime_values WHERE field_id = $2) AS strings_value,
       (SELECT value FROM runtime_values WHERE field_id = $3) AS player_list_value`,
    [world.surfaceFieldId, npcStringsFieldId, locationPlayerListFieldId],
  );
  const runtimeRow = staticRuntime.rows[0];
  if (JSON.stringify(runtimeRow?.surface_value) !== JSON.stringify([])) {
    throw new Error(
      `static surface runtime value was not reset: ${JSON.stringify(runtimeRow?.surface_value)}`,
    );
  }
  if (JSON.stringify(runtimeRow?.strings_value) !== JSON.stringify({})) {
    throw new Error(
      `static strings runtime value was not reset: ${JSON.stringify(runtimeRow?.strings_value)}`,
    );
  }
  if (JSON.stringify(runtimeRow?.player_list_value) !== JSON.stringify([])) {
    throw new Error(
      `static player-id list runtime value was not reset: ${JSON.stringify(runtimeRow?.player_list_value)}`,
    );
  }

  return {
    before,
    after,
    removed: result.dynamicEntitiesRemoved,
    originEntity: dynamicOrigin.rows[0]!.id,
    staticRuntime: runtimeRow,
  };
}

async function countDynamicEntities(): Promise<number> {
  const rows = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM entities WHERE ${DYNAMIC_ENTITY_WHERE_SQL}`,
  );
  return Number(rows.rows[0]?.count ?? 0);
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ count: number | string }>(sql, params);
  return Number(rows.rows[0]?.count ?? 0);
}

async function insertReadyAdventureQueue(opts: {
  world: SupportWorld;
  turnId: string;
  adventureKind: AdventureKind;
}): Promise<{ id: number }> {
  const inserted = await query<{ id: number }>(
    `INSERT INTO adventure_queue
       (session_id, player_id, turn_id, status, source, adventure_kind,
        priority, seed, sequence, table_id, roll_result, context_snapshot,
        dedupe_key, available_after_turn_id)
     VALUES (
        $1, $2, $3, 'queued', 'manual_debug', $4,
        50, $5, 1, $6, $7::jsonb, $8::jsonb,
        $9, $3
     )
     RETURNING id`,
    [
      opts.world.sessionId,
      opts.world.playerId,
      opts.turnId,
      opts.adventureKind,
      `support-delivery-${opts.world.suffix}`,
      ADVENTURE_TABLE_ID,
      JSON.stringify({ selectedKind: opts.adventureKind, sequence: 1 }),
      JSON.stringify({
        currentLocationId: opts.world.locationId,
        mode: 'exploration',
        activeQuestCount: 0,
      }),
      `support-delivery:${opts.world.suffix}:${opts.turnId}`,
    ],
  );
  return { id: Number(inserted.rows[0]!.id) };
}

async function insertGuardrailQuest(
  _world: SupportWorld,
  opts: { title: string; rewardXp: number },
): Promise<number> {
  const profile = {
    stages: [
      { id: 'open', title: 'Open', next_stage: 'done' },
      { id: 'done', title: 'Done' },
    ],
    rewards: opts.rewardXp > 0 ? { xp: opts.rewardXp } : {},
  };
  const inserted = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'quest', $1, 'Support smoke guardrail quest.', $2::jsonb,
       ARRAY['quest'],
       'support-smoke', false
     )
     RETURNING id`,
    [opts.title, JSON.stringify(profile)],
  );
  return Number(inserted.rows[0]!.id);
}

async function insertActiveSupportQuest(
  world: SupportWorld,
  opts: {
    title: string;
    startedAtSql: 'now()' | "now() - interval '10 days'";
    profileExtra?: Record<string, unknown>;
  },
): Promise<number> {
  const profile = {
    stages: [
      { id: 'open', title: 'Open', next_stage: 'done' },
      { id: 'done', title: 'Done' },
    ],
    goal: opts.title,
    ...(opts.profileExtra ?? {}),
  };
  const inserted = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'quest', $1, 'Support smoke active quest.', $2::jsonb,
       ARRAY['quest'],
       'support-smoke', false
     )
     RETURNING id`,
    [opts.title, JSON.stringify(profile)],
  );
  const questId = Number(inserted.rows[0]!.id);
  const startedAtExpr =
    opts.startedAtSql === "now() - interval '10 days'"
      ? "now() - interval '10 days'"
      : 'now()';
  await query(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase, current_stage_id, started_at)
     VALUES ($1, $2, 'active', 1, 'open', ${startedAtExpr})`,
    [world.playerId, questId],
  );
  return questId;
}

async function insertAllowedRuntimeField(
  world: SupportWorld,
  opts: {
    ownerEntityId?: number;
    fieldKey?: string;
    scopePerPlayer?: boolean;
  } = {},
): Promise<number> {
  const ownerEntityId = opts.ownerEntityId ?? world.playerId;
  const fieldKey = opts.fieldKey ?? 'support_mode';
  const scopePerPlayer = opts.scopePerPlayer ?? false;
  const inserted = await query<{ id: number }>(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value,
        allowed_values, scope, scope_per_player, description)
     VALUES ($1, $2, 'string', '"idle"'::jsonb,
             '["idle","ready"]'::jsonb, 'session', $3,
             'support smoke allowed-values field')
     RETURNING id`,
    [ownerEntityId, fieldKey, scopePerPlayer],
  );
  return Number(inserted.rows[0]!.id);
}

async function insertSupportItem(world: SupportWorld): Promise<number> {
  const inserted = await query<{ id: number }>(
    `INSERT INTO items (slug, category, stackable, max_stack, behaviour)
     VALUES ($1, 'currency', true, 999, '{}'::jsonb)
     ON CONFLICT (slug) DO UPDATE SET category = EXCLUDED.category
     RETURNING id`,
    [`support_coin_${world.suffix}`],
  );
  return Number(inserted.rows[0]!.id);
}

async function insertSupportRelicAtLocation(world: SupportWorld): Promise<{
  displayName: string;
  entityId: number;
  itemId: number;
  slug: string;
}> {
  const displayName = `Support Smoke Scene Relic ${world.suffix}`;
  const slug = `support_smoke_scene_relic_${world.suffix}`;
  const entityId = await insertEntity(
    'item',
    displayName,
    'Support smoke scene relic held by a location inventory ledger.',
  );
  const item = await query<{ id: number }>(
    `INSERT INTO items
       (slug, category, stackable, max_stack, behaviour, legacy_entity_id)
     VALUES ($1, 'material', true, 99, '{}'::jsonb, $2)
     ON CONFLICT (slug) DO UPDATE SET legacy_entity_id = EXCLUDED.legacy_entity_id
     RETURNING id`,
    [slug, entityId],
  );
  await query(
    `INSERT INTO inventory_entries
       (holder_entity_id, item_entity_id, count, metadata)
     VALUES ($1, $2, 2, $3::jsonb)
     ON CONFLICT (holder_entity_id, item_entity_id)
     DO UPDATE SET count = EXCLUDED.count,
                   metadata = EXCLUDED.metadata`,
    [
      world.locationId,
      entityId,
      JSON.stringify({ source: 'support_smoke_canonical_location_transfer' }),
    ],
  );
  return {
    displayName,
    entityId,
    itemId: Number(item.rows[0]!.id),
    slug,
  };
}

async function insertEntity(
  kind: string,
  displayName: string,
  summary: string,
): Promise<number> {
  // ARCH-19 Phases 2B+4 — support-smoke fixture entities land with
  // cartridge_id = 'support-smoke' as the canonical scope. The
  // legacy `'support-smoke'` tag was retired by migration 0124.
  // Players keep cartridge_id NULL since the predicate's
  // `kind = 'player'` branch already scopes them across cartridges.
  const cartridgeId = kind === 'player' ? null : 'support-smoke';
  const inserted = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       $1, $2, $3, '{}'::jsonb, ARRAY[]::text[],
       $4, false
     )
     RETURNING id`,
    [kind, displayName, summary, cartridgeId],
  );
  return Number(inserted.rows[0]!.id);
}

async function insertChatMessage(
  world: SupportWorld,
  authorId: number,
  tone: string,
  text: string,
  turnIndex: number,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload, player_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      world.sessionId,
      authorId,
      tone,
      text,
      turnIndex,
      JSON.stringify(payload),
      world.playerId,
    ],
  );
}

async function insertRuntimeField(
  ownerEntityId: number,
  fieldKey: string,
  valueType: string,
  defaultValue: unknown,
  scope: string,
): Promise<number> {
  const inserted = await query<{ id: number }>(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value,
        allowed_values, scope, scope_per_player, description)
     VALUES ($1, $2, $3, $4::jsonb, NULL, $5, false, 'support smoke field')
     RETURNING id`,
    [ownerEntityId, fieldKey, valueType, JSON.stringify(defaultValue), scope],
  );
  return Number(inserted.rows[0]!.id);
}

function baseCtx(world: SupportWorld) {
  return {
    sessionId: world.sessionId,
    playerId: world.playerId,
    turnId: world.session.activeTurn?.turnId,
    signal: world.session.activeTurn?.abortController.signal,
  };
}

function readObjectNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function readPlayerXp(playerId: number): Promise<number> {
  const row = await query<{ current_xp: number | string }>(
    `SELECT current_xp FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return Number(row.rows[0]?.current_xp ?? 0);
}

async function readPlayerItemQuantity(
  playerId: number,
  slug: string,
): Promise<number> {
  const row = await query<{ quantity: number | string }>(
    `SELECT quantity
       FROM player_inventory pi
       JOIN items i ON i.id = pi.item_id
      WHERE pi.player_id = $1
        AND i.slug = $2`,
    [playerId, slug],
  );
  return Number(row.rows[0]?.quantity ?? 0);
}

async function readLegacyInventoryQuantity(
  holderEntityId: number,
  itemEntityId: number,
): Promise<number> {
  const row = await query<{ count: number | string }>(
    `SELECT count
       FROM inventory_entries
      WHERE holder_entity_id = $1
        AND item_entity_id = $2`,
    [holderEntityId, itemEntityId],
  );
  return Number(row.rows[0]?.count ?? 0);
}

async function readPlayerLocation(playerId: number): Promise<number> {
  const row = await query<{ current_location_id: number | string | null }>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const locationId = Number(row.rows[0]?.current_location_id ?? 0);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new Error(`player ${playerId} has no current_location_id`);
  }
  return locationId;
}

function countEvents(world: SupportWorld, eventName: string): number {
  return world.events.filter((event) => event.event === eventName).length;
}

async function countQuestEventRows(
  sessionId: string,
  eventType: 'quest:started' | 'quest:advanced' | 'quest:completed',
  questId: number,
): Promise<number> {
  return countRows(
    `SELECT COUNT(*)::int AS count
       FROM gui_events
      WHERE session_id = $1
        AND event_type = $2
        AND payload->>'questId' = $3`,
    [sessionId, eventType, String(questId)],
  );
}

function turnEvents(
  world: SupportWorld,
  turnId: string,
): Array<{ event?: string; data?: string; id?: string }> {
  return world.events.filter((event) => {
    if (!event.data) return false;
    try {
      const parsed = JSON.parse(event.data) as { turnId?: unknown };
      return parsed.turnId === turnId;
    } catch {
      return false;
    }
  });
}

function parseEventData(
  data: string | undefined,
): Record<string, unknown> | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function runtimeFieldEvents(world: SupportWorld): Array<{
  owner_entity_id: number;
  field_key: string;
  value: unknown;
  source: string;
}> {
  return world.events
    .filter((event) => event.event === 'runtime:field' && event.data)
    .flatMap((event) => {
      try {
        const parsed = JSON.parse(event.data ?? 'null') as {
          owner_entity_id?: unknown;
          field_key?: unknown;
          value?: unknown;
          source?: unknown;
        };
        if (
          typeof parsed.owner_entity_id !== 'number' ||
          typeof parsed.field_key !== 'string'
        ) {
          return [];
        }
        return [
          {
            owner_entity_id: parsed.owner_entity_id,
            field_key: parsed.field_key,
            value: parsed.value,
            source: typeof parsed.source === 'string' ? parsed.source : '',
          },
        ];
      } catch {
        return [];
      }
    });
}

function guiEventEnvelopes(
  world: SupportWorld,
): Array<{ eventId: number; type: string; payload: unknown }> {
  return world.events
    .filter((event) => event.event === 'gui:event' && event.data)
    .flatMap((event) => {
      try {
        const parsed = JSON.parse(event.data ?? 'null') as {
          eventId?: unknown;
          type?: unknown;
          payload?: unknown;
        };
        if (
          typeof parsed.eventId !== 'number' ||
          typeof parsed.type !== 'string'
        ) {
          return [];
        }
        return [
          {
            eventId: parsed.eventId,
            type: parsed.type,
            payload: parsed.payload,
          },
        ];
      } catch {
        return [];
      }
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 1500,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function errorDetails(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { message: String(err) };
}
