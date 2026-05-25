// FEAT-CART-LIB-5 — Worlds & Heroes screen labels.
//
// Boot-phase screen, so we localize inline (boot lives outside
// TranslationProvider). Matches the pattern `MainMenu.newGameLabels`
// uses. EN + RU are the pinned languages for this slice; other
// locales fall back to EN.

import {repairMojibakeRecord} from '../../lib/mojibake';

export interface LibraryText {
  // Frame
  title: string;
  subtitle: string;
  back: string;
  enterGame: string;
  loading: string;
  error: string;
  // Sections
  worldsHeading: string;
  heroesHeading: string;
  selectedHeading: string;
  // Cartridge card
  cartridgeVersion: string;
  cartridgeContent: string;
  cartridgeStartingLocation: string;
  cartridgeValidation: string;
  cartridgeNoStart: string;
  defaultBadge: string;
  installReady: string;
  installNotReady: string;
  importRequired: string;
  // Hero card
  heroLevel: string;
  heroNoCartridge: string;
  heroLastSeen: string;
  heroCurrentWorld: string;
  noHeroes: string;
  // Create hero
  createHero: string;
  createHeroSubmit: string;
  createHeroCancel: string;
  createHeroNameLabel: string;
  createHeroNamePlaceholder: string;
  createHeroIntro: string;
  createHeroSheetTitle: string;
  createHeroSheetCommit: string;
  createHeroBusy: string;
  // Compatibility / history panel
  compatibilityHeading: string;
  compatibilityHero: string;
  compatibilityWorld: string;
  compatibilityMode: string;
  compatibilityBlockers: string;
  compatibilityInstallState: string;
  compatibilityStartingLocation: string;
  compatibilityLastLocation: string;
  compatibilityLastSession: string;
  compatibilityPlaythroughId: string;
  compatibilityResetGeneration: string;
  compatibilityOtherWorlds: string;
  compatibilityNoOtherWorlds: string;
  compatibilityStatusAvailable: string;
  compatibilityStatusActive: string;
  compatibilityStatusIncompatible: string;
  compatibilityStatusArchived: string;
  // Preview pair (legacy keys still consumed)
  previewLoading: string;
  modeContinue: string;
  modeFirstSpawn: string;
  modeRepair: string;
  blockerInstallCacheNotReady: string;
  blockerHeroIncompatible: string;
  blockerNoStartingLocation: string;
  previewLastLocation: string;
  previewStartingAt: string;
  // Forge entry
  forgeHeading: string;
  forgeDescription: string;
  forgePathLabel: string;
  forgeNoPath: string;
  forgeCopyPath: string;
  forgeCopied: string;
  // Actions
  actionLaunch: string;
  actionNewGame: string;
  actionImport: string;
  actionReimport: string;
  actionResetWorld: string;
  actionDeleteHero: string;
  actionDeleteWorld: string;
  confirmCancel: string;
  confirmBusy: string;
  confirmNewGameTitle: string;
  confirmResetWorldTitle: string;
  confirmResetWorldBody: string;
  confirmDeleteHeroTitle: string;
  confirmDeleteHeroBody: string;
  confirmDeleteWorldTitle: string;
  confirmDeleteWorldBody: string;
  newGameConfirm: string;
  // Import wizard
  importTitle: string;
  importSourceKind: string;
  importSourcePath: string;
  importSourceKindObsidian: string;
  importSourceKindForge: string;
  importSourceKindAgent: string;
  importCreate: string;
  importCancel: string;
  importApply: string;
  importAcceptWarnings: string;
  importStatus: string;
  importPhase: string;
  importValidation: string;
  importDiffHeading: string;
  importDiffNew: string;
  importDiffChanged: string;
  importDiffUnchanged: string;
  importDiffDeprecated: string;
  importDiffBlocked: string;
  importClose: string;
  importApplied: string;
  importFailed: string;
  importPathPlaceholder: string;
  importBrowse: string;
  importBrowseBusy: string;
  importBrowseTitle: string;
  importBrowseUnavailable: string;
  importFolderBrowserHeading: string;
  importFolderBrowserUseCurrent: string;
  importFolderBrowserParent: string;
  importFolderBrowserEmpty: string;
  importFolderBrowserCandidate: string;
  importFolderBrowserForge: string;
  // Job statuses (localized)
  jobStatusQueued: string;
  jobStatusRunning: string;
  jobStatusReady: string;
  jobStatusFailed: string;
  jobStatusCancelled: string;
  jobStatusApplying: string;
  jobStatusApplied: string;
  // FEAT-ENGINE-BASELINE-6 — default Forge project quick-import entry.
  defaultForgeHeading: string;
  defaultForgeReady: string;
  defaultForgeMissing: string;
  defaultForgeImport: string;
  emptyLibraryTitle: string;
  emptyLibraryBody: string;
  // FEAT-HERO-CONTINUITY-5 — hero card extras + continuity sections.
  heroVisitedWorlds: string;
  heroVisitedWorldsNone: string;
  continuityHeading: string;
  continuityCarriesHeading: string;
  continuityStaysHeading: string;
  continuityAdjustedHeading: string;
  continuityCompanionsHeading: string;
  continuityNoCarries: string;
  continuityNoStays: string;
  continuityNoAdjustments: string;
  continuityNoCompanions: string;
  // Carry-row codes (hero_core).
  carryLevelXp: string;
  carryStats: string;
  carrySkills: string;
  carryTitles: string;
  carryProgression: string;
  carryWallet: string;
  carryPortableArtifacts: string;
  // Stays-row codes (universe_local).
  localCurrentLocation: string;
  localCurrentScene: string;
  localInventory: string;
  localQuests: string;
  localNotices: string;
  localNpcMemories: string;
  localRelationshipStrings: string;
  localCompanionsRoster: string;
  // Companion status labels (player-facing).
  companionTravels: string;
  companionWaits: string;
  companionRequiresAdapter: string;
  companionSuppressed: string;
  companionNative: string;
  // Companion reason codes.
  companionReasonNoBond: string;
  companionReasonPortable: string;
  companionReasonWorldBound: string;
  companionReasonRequiresAdapter: string;
  companionReasonSuppressed: string;
  // Adjusted-row codes (compatibility warnings + policy hints).
  warningInventoryLocalOnly: string;
  warningQuestsLocalOnly: string;
  warningRelationshipsLocalOnly: string;
  warningMemoriesSummaryOnly: string;
  warningCurrentLocationLocalOnly: string;
  warningCompanionsLocalOnly: string;
  warningSuppressedArtifact: string;
  policyDefaultCompanionsLocal: string;
  policyDefaultMemoriesSummary: string;
  policyCompanionsPortableAllowed: string;
  policyMissingStartingLocation: string;
  // Continuity copy under action buttons (New Game / Reimport).
  newGameCarryoverNote: string;
  reimportCarryoverNote: string;
  // Companion capsule snippet labels.
  companionCapsuleHeading: string;
  companionCapsuleMemoriesLabel: string;
  companionCapsuleInventoryLabel: string;
  companionCapsuleStringsLabel: string;
  // Empty preview state.
  continuityFirstArrival: string;
  continuityReturning: string;
}

const EN: LibraryText = {
  title: 'Worlds & Heroes',
  subtitle: 'Choose a world, choose a hero, then enter the game.',
  back: 'Back to menu',
  enterGame: 'Enter game',
  loading: 'Loading…',
  error: 'Could not load library.',
  worldsHeading: 'Installed worlds',
  heroesHeading: 'Heroes',
  selectedHeading: 'Compatibility',
  cartridgeVersion: 'Version',
  cartridgeContent: 'Content',
  cartridgeStartingLocation: 'Starts at',
  cartridgeValidation: 'Validation',
  cartridgeNoStart: 'No starting location set',
  defaultBadge: 'Default',
  installReady: 'Ready to play',
  installNotReady: 'Install not ready',
  importRequired: 'Import required',
  heroLevel: 'Level',
  heroNoCartridge: 'No active world',
  heroLastSeen: 'Last played',
  heroCurrentWorld: 'Active world',
  noHeroes: 'No heroes yet. Use Create Hero in the top bar.',
  createHero: '+ Create hero',
  createHeroSubmit: 'Retry',
  createHeroCancel: 'Cancel',
  createHeroNameLabel: 'Hero name',
  createHeroNamePlaceholder: 'A name your hero will be known by',
  createHeroIntro: 'Fill the full hero sheet. The name belongs in the sheet.',
  createHeroSheetTitle: 'Hero sheet',
  createHeroSheetCommit: 'Save hero',
  createHeroBusy: 'Preparing hero sheet…',
  compatibilityHeading: 'Compatibility',
  compatibilityHero: 'Hero',
  compatibilityWorld: 'World',
  compatibilityMode: 'Status',
  compatibilityBlockers: 'Blockers',
  compatibilityInstallState: 'Install state',
  compatibilityStartingLocation: 'Starting location',
  compatibilityLastLocation: 'Last location',
  compatibilityLastSession: 'Last session id',
  compatibilityPlaythroughId: 'Playthrough id',
  compatibilityResetGeneration: 'Reset generation',
  compatibilityOtherWorlds: 'This hero in other worlds',
  compatibilityNoOtherWorlds: 'No other recorded runs.',
  compatibilityStatusAvailable: 'Available',
  compatibilityStatusActive: 'Active',
  compatibilityStatusIncompatible: 'Incompatible',
  compatibilityStatusArchived: 'Archived',
  previewLoading: 'Checking compatibility…',
  modeContinue: 'Resume this run',
  modeFirstSpawn: 'Begin first run',
  modeRepair: 'Cannot launch yet',
  blockerInstallCacheNotReady: 'Install cache is not ready — import this world first.',
  blockerHeroIncompatible: 'This hero is not compatible with this world.',
  blockerNoStartingLocation: 'This world has no scoped starting location yet.',
  previewLastLocation: 'Last location',
  previewStartingAt: 'Starting location',
  forgeHeading: 'Forge workbench',
  forgeDescription: 'Obsidian is the human source. Forge is the structured review workbench that compiles the vault into a cartridge.',
  forgePathLabel: 'Source path',
  forgeNoPath: 'No Forge / source path recorded for this world.',
  forgeCopyPath: 'Copy path',
  forgeCopied: 'Copied',
  actionLaunch: 'Enter world',
  actionNewGame: 'New game in this world',
  actionImport: 'Import world…',
  actionReimport: 'Reimport this world…',
  actionResetWorld: 'Reset world runs',
  actionDeleteHero: 'Delete hero',
  actionDeleteWorld: 'Delete world',
  confirmCancel: 'Cancel',
  confirmBusy: 'Working…',
  confirmNewGameTitle: 'Start a new run?',
  confirmResetWorldTitle: 'Reset this world?',
  confirmResetWorldBody: 'All hero runs in this world will be cleared. The installed cartridge content stays in place and can be played again without reimporting.',
  confirmDeleteHeroTitle: 'Delete this hero?',
  confirmDeleteHeroBody: 'This removes the hero, their local progress, and their session history from this device. Other installed worlds stay installed.',
  confirmDeleteWorldTitle: 'Delete this world?',
  confirmDeleteWorldBody: 'This removes the installed cartridge, its imported static content, and every local run in this world. Heroes themselves are not deleted.',
  newGameConfirm: 'Start a new run for this hero in this world? Existing run state for this pair will be respawned.',
  importTitle: 'Import / reimport world',
  importSourceKind: 'Source',
  importSourcePath: 'Path',
  importSourceKindObsidian: 'Obsidian vault',
  importSourceKindForge: 'Forge project',
  importSourceKindAgent: 'Agent pack',
  importCreate: 'Start preview',
  importCancel: 'Cancel job',
  importApply: 'Apply',
  importAcceptWarnings: 'Accept warnings',
  importStatus: 'Status',
  importPhase: 'Phase',
  importValidation: 'Errors / warnings',
  importDiffHeading: 'Diff',
  importDiffNew: 'new',
  importDiffChanged: 'changed',
  importDiffUnchanged: 'unchanged',
  importDiffDeprecated: 'deprecated',
  importDiffBlocked: 'blocked',
  importClose: 'Close',
  importApplied: 'Apply succeeded',
  importFailed: 'Job failed',
  importPathPlaceholder: 'C:/path/to/vault-or-pack',
  importBrowse: 'Browse...',
  importBrowseBusy: 'Opening...',
  importBrowseTitle: 'Select Obsidian cartridge folder',
  importBrowseUnavailable: 'Could not open the native folder picker. Use the local folder browser below or paste the path manually.',
  importFolderBrowserHeading: 'Local folder browser',
  importFolderBrowserUseCurrent: 'Use this folder',
  importFolderBrowserParent: 'Parent folder',
  importFolderBrowserEmpty: 'No child folders here.',
  importFolderBrowserCandidate: 'Obsidian candidate',
  importFolderBrowserForge: 'Forge project',
  jobStatusQueued: 'Queued',
  jobStatusRunning: 'Running',
  jobStatusReady: 'Ready',
  jobStatusFailed: 'Failed',
  jobStatusCancelled: 'Cancelled',
  jobStatusApplying: 'Applying',
  jobStatusApplied: 'Applied',
  defaultForgeHeading: 'Default Greenhaven world',
  defaultForgeReady: 'A generated Forge project is on disk — import it to install the default world.',
  defaultForgeMissing: 'No generated Forge project on disk. Run `npm run cartridge:default:build` to generate one.',
  defaultForgeImport: 'Import default world',
  emptyLibraryTitle: 'No worlds installed yet',
  emptyLibraryBody: 'Greenhaven needs at least one installed world before you can play. Import the default Greenhaven world below or open the import wizard for your own Forge / Obsidian source.',
  heroVisitedWorlds: 'Visited worlds',
  heroVisitedWorldsNone: 'None yet',
  continuityHeading: 'Hero continuity',
  continuityCarriesHeading: 'Carries with hero',
  continuityStaysHeading: 'Stays in this world',
  continuityAdjustedHeading: 'Adjusted by this world',
  continuityCompanionsHeading: 'Companions',
  continuityNoCarries: 'Nothing carries over yet.',
  continuityNoStays: 'No local state to leave behind.',
  continuityNoAdjustments: 'No adjustments from this world.',
  continuityNoCompanions: 'No companions traveling with this hero.',
  carryLevelXp: 'Level / XP',
  carryStats: 'Stats',
  carrySkills: 'Skills',
  carryTitles: 'Titles',
  carryProgression: 'Progression tracks',
  carryWallet: 'Progression points',
  carryPortableArtifacts: 'Portable artifacts',
  localCurrentLocation: 'Current location',
  localCurrentScene: 'Current scene',
  localInventory: 'Inventory',
  localQuests: 'Quests',
  localNotices: 'Notices',
  localNpcMemories: 'NPC memories',
  localRelationshipStrings: 'Relationships',
  localCompanionsRoster: 'Local companions',
  companionTravels: 'Travels with you',
  companionWaits: 'Waits in another world',
  companionRequiresAdapter: 'Needs adapter',
  companionSuppressed: 'Suppressed here',
  companionNative: 'Local to this world',
  companionReasonNoBond: 'No travel contract yet.',
  companionReasonPortable: 'Bond is portable and this world accepts it.',
  companionReasonWorldBound: 'Bond is world-bound.',
  companionReasonRequiresAdapter: 'This world needs a compatible adapter.',
  companionReasonSuppressed: 'Target world policy blocks this companion.',
  warningInventoryLocalOnly: 'Inventory stays in this world.',
  warningQuestsLocalOnly: 'Quests stay in this world.',
  warningRelationshipsLocalOnly: 'Relationships stay in this world.',
  warningMemoriesSummaryOnly: 'NPC memories stay in this world.',
  warningCurrentLocationLocalOnly: 'Current location stays in this world.',
  warningCompanionsLocalOnly: 'Companions stay in this world unless bonded.',
  warningSuppressedArtifact: 'This artifact is suppressed by the target world.',
  policyDefaultCompanionsLocal: 'This world keeps companions local unless contracted.',
  policyDefaultMemoriesSummary: 'NPC memories summarize without crossing worlds.',
  policyCompanionsPortableAllowed: 'This world accepts portable companion contracts.',
  policyMissingStartingLocation: 'This world has no starting location set yet.',
  newGameCarryoverNote: 'Start a new run in this world. Your hero core stays. This world\'s local run state resets. Installed world content is reused. Traveling companions stay bonded to the hero; world-local companions reset with this world\'s run.',
  reimportCarryoverNote: 'Update this world\'s cartridge content. Hero identity and existing playthrough state are preserved unless the compatibility report marks a conflict.',
  companionCapsuleHeading: 'Capsule',
  companionCapsuleMemoriesLabel: 'memories',
  companionCapsuleInventoryLabel: 'items',
  companionCapsuleStringsLabel: 'strings',
  continuityFirstArrival: 'First arrival',
  continuityReturning: 'Returning',
};

function repairLibraryText(text: LibraryText): LibraryText {
  return repairMojibakeRecord(
    text as unknown as Record<string, string>,
  ) as unknown as LibraryText;
}

export function libraryText(_language: string): LibraryText {
  // Worlds & Heroes is the launcher for an English-first cartridge library.
  // Keep the shell in English even when the runtime language is switched.
  return repairLibraryText(EN);
}

/** Map a backend job status code to its localized label. Returns
 *  the raw code for unknown values so a future enum entry is still
 *  readable rather than blank. */
export function jobStatusLabel(text: LibraryText, code: string): string {
  switch (code) {
    case 'queued':
      return text.jobStatusQueued;
    case 'running':
      return text.jobStatusRunning;
    case 'ready':
      return text.jobStatusReady;
    case 'failed':
      return text.jobStatusFailed;
    case 'cancelled':
      return text.jobStatusCancelled;
    case 'applying':
      return text.jobStatusApplying;
    case 'applied':
      return text.jobStatusApplied;
    default:
      return code;
  }
}

// FEAT-HERO-CONTINUITY-5 — backend → localized label mappers. Each
// returns the raw code on unknown values so a future backend enum entry
// remains readable instead of blank in the GUI.

export function continuityCarryLabel(text: LibraryText, code: string): string {
  switch (code) {
    case 'level_xp':
      return text.carryLevelXp;
    case 'stats':
      return text.carryStats;
    case 'skills':
      return text.carrySkills;
    case 'titles':
      return text.carryTitles;
    case 'progression':
      return text.carryProgression;
    case 'wallet':
      return text.carryWallet;
    case 'portable_artifacts':
      return text.carryPortableArtifacts;
    default:
      return code;
  }
}

export function continuityLocalLabel(text: LibraryText, code: string): string {
  switch (code) {
    case 'current_location':
      return text.localCurrentLocation;
    case 'current_scene':
      return text.localCurrentScene;
    case 'inventory':
      return text.localInventory;
    case 'quests':
      return text.localQuests;
    case 'notices':
      return text.localNotices;
    case 'npc_memories':
      return text.localNpcMemories;
    case 'relationship_strings':
      return text.localRelationshipStrings;
    case 'companions_roster':
      return text.localCompanionsRoster;
    default:
      return code;
  }
}

export function continuityCompanionStatusLabel(
  text: LibraryText,
  status: string,
): string {
  switch (status) {
    case 'portable_companion':
      return text.companionTravels;
    case 'world_bound':
      return text.companionWaits;
    case 'requires_adapter':
      return text.companionRequiresAdapter;
    case 'suppressed':
      return text.companionSuppressed;
    case 'native_local':
      return text.companionNative;
    default:
      return status;
  }
}

export function continuityCompanionReasonLabel(
  text: LibraryText,
  reason: string,
): string {
  switch (reason) {
    case 'no_bond_contract':
      return text.companionReasonNoBond;
    case 'portable_contract':
      return text.companionReasonPortable;
    case 'world_bound':
      return text.companionReasonWorldBound;
    case 'requires_adapter':
      return text.companionReasonRequiresAdapter;
    case 'bond_suppressed':
      return text.companionReasonSuppressed;
    default:
      return reason;
  }
}

export function continuityWarningLabel(
  text: LibraryText,
  code: string,
): string {
  switch (code) {
    case 'inventory_local_only':
      return text.warningInventoryLocalOnly;
    case 'quests_local_only':
      return text.warningQuestsLocalOnly;
    case 'relationships_local_only':
      return text.warningRelationshipsLocalOnly;
    case 'memories_summary_only':
      return text.warningMemoriesSummaryOnly;
    case 'current_location_local_only':
      return text.warningCurrentLocationLocalOnly;
    case 'companions_local_only':
      return text.warningCompanionsLocalOnly;
    default:
      return code;
  }
}
