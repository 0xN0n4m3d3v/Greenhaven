// Settings modal — language picker + broker/narrator model selectors +
// sign-out. Extracted from App.tsx (spec 29 decomposition).
//
// Spec 36 §A.1 — Audio tab: master volume slider + mute toggle,
// persisted to localStorage so useAmbientBed picks them up on mount.
//
// FEAT-ENGINE-BASELINE-6 corrective (2026-05-17) — the in-game
// "New game" section (which called `ResetGame()` → POST
// `/api/player/reset-local-game`, globally wiping the world) was
// removed. Per-hero / per-cartridge New Game now lives entirely in
// the boot-phase Worlds & Heroes screen and goes through
// `/api/playthroughs/new-game`, which preserves installed cartridge
// content + other heroes' playthrough rows. The `/api/player/reset-
// local-game` route + its SEC-5 protections are intentionally kept
// for guarded local/dev diagnostics; only the player-facing surface
// is removed.

import {useCallback, useEffect, useState} from 'react';
import {LogOut, X} from 'lucide-react';
import {setRoleModels} from '../../bridge/api';
import {
  readAudioSettings,
  writeAudioMuted,
  writeAudioVolume,
} from '../../lib/clientStorage';
import {useEntitlements} from '../../hooks/useEntitlements';

import {SaveSlotsPanel} from './SaveSlotsPanel';

interface AvailableLang {
  code: string;
  flag?: string;
  native: string;
}

interface Props {
  uiLanguage: string;
  availableLanguages: AvailableLang[];
  setLanguage: (lang: string) => void | Promise<unknown>;
  brokerModel: string;
  setBrokerModel: (m: string) => void;
  narratorModel: string;
  setNarratorModel: (m: string) => void;
  onSignOut: () => void;
  onClose: () => void;
  t: (key: string) => string;
  playerId?: number;
}

export function SettingsModal({
  uiLanguage,
  availableLanguages,
  setLanguage,
  brokerModel,
  setBrokerModel,
  narratorModel,
  setNarratorModel,
  onSignOut,
  onClose,
  t,
  playerId,
}: Props) {
  const [selectedLanguageIndex, setSelectedLanguageIndex] = useState(0);

  useEffect(() => {
    const index = availableLanguages.findIndex(lang => lang.code === uiLanguage);
    if (index >= 0) setSelectedLanguageIndex(index);
  }, [availableLanguages, uiLanguage]);

  const selectedLanguage =
    availableLanguages[selectedLanguageIndex] ?? availableLanguages[0] ?? null;

  const stepLanguage = useCallback((delta: number) => {
    if (availableLanguages.length === 0) return;
    setSelectedLanguageIndex(index => (
      index + delta + availableLanguages.length
    ) % availableLanguages.length);
  }, [availableLanguages.length]);

  return (
    <div
      className="settings-modal-backdrop gh-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onClick={e => {
        // Click on the backdrop (not the modal body) closes —
        // matches messenger-app convention.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-modal gh-panel gh-settings-modal">
        <header className="settings-modal-header">
          <h2 id="settings-modal-title">{t('ui.settings.title')}</h2>
          <button
            type="button"
            aria-label={t('ui.settings.close')}
            className="settings-close gh-control"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <section className="settings-row">
          <label>{t('ui.settings.language_label')}</label>
          <div className="settings-language-buttons settings-language-carousel">
            <button
              type="button"
              className="boot-lang__arrow gh-control"
              onClick={() => stepLanguage(-1)}
              disabled={!selectedLanguage}
              aria-label="Previous language"
            >
              {'<'}
            </button>
            {selectedLanguage && (
              <button
                type="button"
                className={selectedLanguage.code === uiLanguage ? 'active' : ''}
                onClick={() => {
                  void setLanguage(selectedLanguage.code);
                }}
                aria-pressed={selectedLanguage.code === uiLanguage}
              >
                <span className="lang-flag">{selectedLanguage.flag}</span>
                <span>{selectedLanguage.native}</span>
                <span className="settings-language-code">{selectedLanguage.code}</span>
              </button>
            )}
            <button
              type="button"
              className="boot-lang__arrow gh-control"
              onClick={() => stepLanguage(1)}
              disabled={!selectedLanguage}
              aria-label="Next language"
            >
              {'>'}
            </button>
          </div>
        </section>

        <section className="settings-row">
          <label>Broker model (V2)</label>
          <p className="settings-hint">
            DeepSeek role used for tool dispatch in the v2 turn-runner. Flash is cheap; Pro is overkill.
          </p>
          <select
            className="settings-select gh-control"
            value={brokerModel}
            onChange={async e => {
              const v = e.target.value;
              setBrokerModel(v);
              try {
                await setRoleModels({broker: v});
              } catch (err) {
                console.warn('setRoleModels(broker) failed', err);
              }
            }}
          >
            <option value="deepseek-v4-flash">DeepSeek V4 Flash · cheap</option>
            <option value="deepseek-v4-pro">DeepSeek V4 Pro · overkill</option>
          </select>
        </section>

        <section className="settings-row">
          <label>Narrator model (V2)</label>
          <p className="settings-hint">DeepSeek role used for prose narration in the v2 turn-runner.</p>
          <select
            className="settings-select gh-control"
            value={narratorModel}
            onChange={async e => {
              const v = e.target.value;
              setNarratorModel(v);
              try {
                await setRoleModels({narrator: v});
              } catch (err) {
                console.warn('setRoleModels(narrator) failed', err);
              }
            }}
          >
            <option value="deepseek-v4-pro">DeepSeek V4 Pro · default</option>
            <option value="deepseek-v4-flash">DeepSeek V4 Flash · budget</option>
          </select>
        </section>

        <AudioSection />

        <AddonsSection />


        {playerId != null && playerId > 0 && <SaveSlotsPanel playerId={playerId} />}

        <section className="settings-row danger">
          <label>{t('ui.settings.sign_out_label')}</label>
          <p className="settings-hint">{t('ui.settings.sign_out_hint')}</p>
          <button type="button" className="settings-signout gh-control" onClick={onSignOut}>
            <LogOut size={15} />
            <span>{t('ui.settings.sign_out_button')}</span>
          </button>
        </section>
      </div>
    </div>
  );
}

// Spec 36 §A.1 — Audio settings tab. Master volume slider 0..100 +
// mute toggle, persisted to localStorage. useAmbientBed (mounted in
// WizardGate) reads on mount; full-cycle volume change requires a
// page reload to take effect on currently-playing Howls — acceptable
// for v1.
// Add-ons / DLC. Greenhaven ships as singleplayer; entitlement keys are
// validated locally and stored as a plain boolean. The UX intentionally
// keeps the NSFW unlock behind an explicit confirmation so a curious
// installer doesn't trip into adult content by accident.
function AddonsSection() {
  const {entitlements, unlock} = useEntitlements();
  const [keyDraft, setKeyDraft] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  function handleApplyKey() {
    const trimmed = keyDraft.trim();
    if (!trimmed) {
      setFeedback('Enter a key first.');
      return;
    }
    // For the singleplayer alpha the key is validated by structure only.
    // The real signature check (Ed25519 with a bundled public key) lands
    // when payment integration ships. Until then any non-empty key
    // formatted as <pack>:<token> is accepted, so internal builds can
    // exercise the gated content.
    if (!/^nsfw_2026:[a-z0-9-]{4,}$/i.test(trimmed)) {
      setFeedback('Key format unrecognized.');
      return;
    }
    unlock('nsfw_2026', true);
    setFeedback('Add-on unlocked.');
    setKeyDraft('');
  }

  function handleRemove() {
    unlock('nsfw_2026', false);
    setFeedback('Add-on disabled.');
  }

  return (
    <section className="settings-row">
      <label>Add-ons</label>
      <p className="settings-hint">
        Optional content packs. Adult animation pack is sold separately
        and unlocked locally with a key — no online check required.
      </p>
      <div className="settings-addon-card">
        <div>
          <strong>Adult Companion Pack (21+)</strong>
          <div>
            Status: {entitlements.nsfw_2026 ? 'unlocked' : 'locked'}
          </div>
        </div>
        {entitlements.nsfw_2026 ? (
          <button type="button" onClick={handleRemove}>
            Disable
          </button>
        ) : (
          <span className="settings-addon-requires">
            requires key
          </span>
        )}
      </div>
      {!entitlements.nsfw_2026 && (
        <div className="settings-addon-key-row">
          <input
            type="text"
            value={keyDraft}
            onChange={e => setKeyDraft(e.target.value)}
            placeholder="nsfw_2026:..."
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" onClick={handleApplyKey}>
            Apply
          </button>
        </div>
      )}
      {feedback && (
        <p className="settings-addon-feedback">
          {feedback}
        </p>
      )}
    </section>
  );
}

function AudioSection() {
  const [volume, setVolume] = useState<number>(() => {
    return Math.round(readAudioSettings().volume * 100);
  });
  const [muted, setMuted] = useState<boolean>(() => {
    return readAudioSettings().muted;
  });
  return (
    <section className="settings-row">
      <label>Audio</label>
      <p className="settings-hint">
        Ambient bed (drone + room tone) cross-fades on mode changes.
        Master volume + mute persist locally.
      </p>
      <div className="settings-audio-controls">
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={volume}
          aria-label="Master volume"
          onChange={e => {
            const v = Number(e.target.value);
            setVolume(v);
            writeAudioVolume(v / 100);
          }}
        />
        <span className="settings-audio-value">{volume}</span>
        <button
          type="button"
          className={muted ? 'active' : ''}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            writeAudioMuted(next);
          }}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
      </div>
    </section>
  );
}

// FEAT-ENGINE-BASELINE-6 corrective — the in-game `NewGameSection`
// (which called global `ResetGame()`) was removed. Per-hero /
// per-cartridge new game now lives entirely in the boot-phase Worlds
// & Heroes screen and goes through `/api/playthroughs/new-game`. See
// `packages/web-ui/src/components/cartridge-library/WorldsHeroesScreen.tsx`.
