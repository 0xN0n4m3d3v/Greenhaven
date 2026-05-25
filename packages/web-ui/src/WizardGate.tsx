// WizardGate — first-session character creation gate.
//
// On mount, fetches the player's profile via the bridge. If
// profile.created === true, renders the main App. Otherwise renders
// the unified CharacterCreator; on confirm we re-fetch the profile
// before falling through to <App />.

import {Suspense, lazy, useEffect, useState} from 'react';
import {useAmbientBed} from './hooks/useAmbientBed';
import {readAudioSettings} from './lib/clientStorage';
import {GetCurrentPlayerId, GetPlayerProfile, type PlayerProfile} from './bridge/api';
import {Atmosphere} from './components/atmosphere/Atmosphere';
import {MagneticCursor} from './components/cursor/MagneticCursor';
import {CartridgeMusicController} from './components/media/CartridgeMusicController';
import {TooltipProvider} from './components/ui/tooltip';
import {useTranslation} from './i18n';

const App = lazy(() => import('./App'));
const InspirationBadge = lazy(() =>
  import('./components/banners/InspirationBadge').then((module) => ({
    default: module.InspirationBadge,
  })),
);
const CharacterCreator = lazy(() =>
  import('./components/character/creator/CharacterCreator').then((module) => ({
    default: module.CharacterCreator,
  })),
);
const Toaster = lazy(() =>
  import('./components/ui/toaster').then((module) => ({
    default: module.Toaster,
  })),
);

type Phase =
  | {kind: 'loading'}
  | {kind: 'wizard'; playerId: number}
  | {kind: 'app'; playerId: number}
  | {kind: 'error'; message: string};

export function WizardGate() {
  const [phase, setPhase] = useState<Phase>({kind: 'loading'});
  const {t} = useTranslation();
  const tx = (key: string, fallback: string) => {
    const v = t(key);
    return v === key ? fallback : v;
  };
  const audioSettings = readAudioSettings();
  useAmbientBed(audioSettings.volume, audioSettings.muted);

  const fetchProfile = async () => {
    try {
      const playerId = await GetCurrentPlayerId();
      const {profile} = await GetPlayerProfile(playerId);
      if ((profile as PlayerProfile).created === true) {
        setPhase({kind: 'app', playerId});
      } else {
        setPhase({kind: 'wizard', playerId});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPhase({kind: 'error', message: msg});
    }
  };

  useEffect(() => {
    void fetchProfile();
  }, []);

  if (phase.kind === 'loading') {
    return (
      <>
        <Atmosphere preset="embers" />
        <main className="gh-boot-screen" role="status" aria-live="polite">
          {/*
          <div className="gh-boot-mark">Greenhaven</div>
          */}
          <p className="gh-boot-hint">
            <em>{tx('gh.boot.opening', 'opening the room…')}</em>
          </p>
          <div className="gh-boot-spinner" aria-hidden />
        </main>
      </>
    );
  }

  if (phase.kind === 'error') {
    return (
      <>
        <Atmosphere preset="embers" />
        <main className="gh-boot-screen" role="alert">
          {/*
          <div className="gh-boot-mark">Greenhaven</div>
          */}
          <p className="gh-boot-hint">
            {tx('gh.boot.silence', 'The room is silent. We could not reach the world.')}
          </p>
          <pre className="gh-boot-error">{phase.message}</pre>
          <button
            type="button"
            className="gh-boot-retry"
            onClick={() => {
              setPhase({kind: 'loading'});
              void fetchProfile();
            }}
          >
            {tx('gh.boot.retry', 'try again')}
          </button>
        </main>
      </>
    );
  }

  if (phase.kind === 'wizard') {
    return (
      <TooltipProvider>
        <Atmosphere preset="embers" />
        <Suspense fallback={<BootLoading t={tx} />}>
          <CharacterCreator
            playerId={phase.playerId}
            onComplete={() => {
              setPhase({kind: 'loading'});
              void fetchProfile();
            }}
          />
        </Suspense>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Atmosphere preset="embers" />
      <Suspense fallback={null}>
        <InspirationBadge playerId={phase.playerId} />
      </Suspense>
      <MagneticCursor />
      <Suspense fallback={<BootLoading t={tx} />}>
        <App />
      </Suspense>
      <CartridgeMusicController />
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
    </TooltipProvider>
  );
}

function BootLoading({
  t,
}: {
  t: (key: string, fallback: string) => string;
}) {
  return (
    <main className="gh-boot-screen" role="status" aria-live="polite">
      {/*
      <div className="gh-boot-mark">Greenhaven</div>
      */}
      <p className="gh-boot-hint">
        <em>{t('gh.boot.opening', 'opening the room…')}</em>
      </p>
      <div className="gh-boot-spinner" aria-hidden />
    </main>
  );
}
