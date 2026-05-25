/**
 * Debug specialist smoke-test routes (ARCH-18 thin layer).
 *
 * Business logic lives in DebugService. This file is Hono wiring,
 * request parsing, service calls, and response shaping only.
 *
 *   POST /api/debug/reset-world
 *   POST /api/debug/clear-dialogue-partner
 *   POST /api/debug/synth-event
 *   POST /api/debug/run-quest-watcher          (Spec 39)
 *   POST /api/debug/run-combat-director        (Spec 40)
 *   POST /api/debug/run-intimacy-coordinator   (Spec 41)
 *   POST /api/debug/run-catalogue-scout        (Spec 42)
 *   POST /api/debug/run-npc-voice              (Spec 43)
 *   POST /api/debug/run-scene-painter          (Spec 44)
 *   POST /api/debug/run-dialogue-anchor        (Spec 45)
 *   POST /api/debug/run-movement-warden        (Spec 46)
 *   POST /api/debug/run-reward-calibrator      (Spec 47)
 *   POST /api/debug/run-cartridge-steward      (Spec 48)
 *   POST /api/debug/run-quest-pacer            (Spec 49)
 *   POST /api/debug/verify-specialists         (Spec 50)
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { DebugService, type RouteOutcome } from '../services/DebugService.js';

export const debugRoutes = new Hono();

async function readBody(c: Context): Promise<Record<string, unknown>> {
  return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}

function respond(c: Context, outcome: RouteOutcome): Response {
  return c.json(outcome.body, outcome.status as ContentfulStatusCode);
}

debugRoutes.post('/debug/reset-world', async (c) =>
  respond(c, await DebugService.resetWorld()),
);

debugRoutes.post('/debug/clear-dialogue-partner', async (c) =>
  respond(c, await DebugService.clearDialoguePartner(c.req.query('playerId'))),
);

debugRoutes.post('/debug/synth-event', async (c) =>
  respond(c, await DebugService.emitSyntheticEvent(await readBody(c))),
);

debugRoutes.post('/debug/run-quest-watcher', async (c) =>
  respond(c, await DebugService.runQuestWatcher(await readBody(c))),
);

debugRoutes.post('/debug/run-combat-director', async (c) =>
  respond(c, await DebugService.runCombatDirector(await readBody(c))),
);

debugRoutes.post('/debug/run-intimacy-coordinator', async (c) =>
  respond(c, await DebugService.runIntimacyCoordinator(await readBody(c))),
);

debugRoutes.post('/debug/run-catalogue-scout', async (c) =>
  respond(c, await DebugService.runCatalogueScout(await readBody(c))),
);

debugRoutes.post('/debug/run-npc-voice', async (c) =>
  respond(c, await DebugService.runNpcVoice(await readBody(c))),
);

debugRoutes.post('/debug/run-scene-painter', async (c) =>
  respond(c, await DebugService.runScenePainter(await readBody(c))),
);

debugRoutes.post('/debug/run-dialogue-anchor', async (c) =>
  respond(c, await DebugService.runDialogueAnchor(await readBody(c))),
);

debugRoutes.post('/debug/run-movement-warden', async (c) =>
  respond(c, await DebugService.runMovementWarden(await readBody(c))),
);

debugRoutes.post('/debug/run-reward-calibrator', async (c) =>
  respond(c, await DebugService.runRewardCalibrator(await readBody(c))),
);

debugRoutes.post('/debug/run-cartridge-steward', async (c) =>
  respond(c, await DebugService.runCartridgeSteward(await readBody(c))),
);

debugRoutes.post('/debug/run-quest-pacer', async (c) =>
  respond(c, await DebugService.runQuestPacer(await readBody(c))),
);

debugRoutes.post('/debug/verify-specialists', async (c) => {
  const body = await readBody(c);
  const routeApp = (c.env as Record<string, unknown>)['__app'] as
    | { fetch?: (req: Request) => Promise<Response> }
    | undefined;
  const outcome = await DebugService.verifySpecialists({
    playerId: typeof body['playerId'] === 'number' ? body['playerId'] : 1000,
    routeApp,
  });
  return respond(c, outcome);
});
