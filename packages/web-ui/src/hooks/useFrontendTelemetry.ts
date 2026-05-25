import {useEffect} from 'react';
import {setFrontendTelemetryContext} from '../lib/frontendTelemetry';

export function useFrontendTelemetry(
  playerIdValue: unknown,
  turnId: string | null | undefined,
): void {
  useEffect(() => {
    const playerId = Number(playerIdValue ?? 0);
    setFrontendTelemetryContext({
      playerId: Number.isFinite(playerId) && playerId > 0 ? playerId : null,
    });
  }, [playerIdValue]);

  useEffect(() => {
    setFrontendTelemetryContext({
      turnId: turnId ?? null,
      traceId: turnId ?? null,
    });
  }, [turnId]);
}
