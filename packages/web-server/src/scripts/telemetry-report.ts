export {};

// `telemetry-report` CLI. The DB-bound pieces stay here; the pure
// argv parser, env-redirect helper, error coercion, and structured
// readiness-report fallback live in
// `./telemetry-report-cli.ts` so they can be unit-tested without
// loading `db.js` / `migrate.js`. See that sibling module's
// docstring for the full env / lifecycle contract.

import {
  coerceErrorMessage,
  maybeRedirectPglite,
  parseTelemetryReportArgs,
  readinessReportFallback,
  type TelemetryReportArgs,
} from './telemetry-report-cli.js';

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

let parsedArgs: TelemetryReportArgs | null = null;
try {
  const args = parseTelemetryReportArgs(process.argv.slice(2));
  parsedArgs = args;
  await maybeRedirectPglite(args);

  const result = await runCommand(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  const message = coerceErrorMessage(err);
  const fallback = readinessReportFallback(parsedArgs, message);
  if (fallback) {
    process.stdout.write(`${JSON.stringify(fallback, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({ok: false, error: message}, null, 2)}\n`,
    );
  }
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

async function runCommand(args: TelemetryReportArgs): Promise<unknown> {
  const {runMigrations} = await import('../migrate.js');
  await runMigrations();
  const {applyTelemetryRetention, writeTelemetryJsonArtifact} = await import(
    '../telemetryArtifacts.js'
  );
  const {buildTelemetryDeveloperExport} = await import(
    '../devtools/telemetryDeveloperExport.js'
  );
  const {
    buildTelemetryBundle,
    buildTelemetrySummary,
    getTelemetryTrace,
    getTelemetryTurn,
    listTelemetryErrors,
    listTelemetryQuality,
    narrateSanitiserReadinessReport,
    sinceIso,
  } = await import('../devtools/telemetryDiagnostics.js');
  const {closeDb} = await import('../db.js');
  const since = args.since ?? sinceIso(args.minutes);
  try {
    const result =
      args.command === 'trace'
        ? await getTelemetryTrace(args.id!)
        : args.command === 'turn'
          ? await getTelemetryTurn(args.id!)
          : args.command === 'bundle'
            ? await maybePersistBundle(
                await buildTelemetryBundle({
                  since,
                  limit: args.limit,
                  traceLimit: args.traceLimit,
                }),
                args.write,
                writeTelemetryJsonArtifact,
              )
            : args.command === 'retention'
              ? await applyTelemetryRetention({
                  safeDays: args.safeDays,
                  debugDays: args.debugDays,
                  sensitiveDays: args.sensitiveDays,
                  artifactDays: args.artifactDays,
                  maxArtifactBytes: args.maxArtifactBytes,
                  dryRun: args.dryRun,
                })
              : args.command === 'export'
                ? await buildTelemetryDeveloperExport({
                    since,
                    limit: args.limit,
                    formats: args.formats,
                    write: args.write,
                    postOtlp: args.postOtlp,
                    otlpEndpoint: args.otlpEndpoint,
                    allowRemote: args.allowRemote,
                  })
                : args.command === 'errors'
                  ? {
                      since,
                      ...(await listTelemetryErrors({since, limit: args.limit})),
                    }
                  : args.command === 'quality'
                    ? {
                        since,
                        ...(await listTelemetryQuality({
                          since,
                          limit: args.limit,
                        })),
                      }
                    : args.command === 'narrate-sanitiser'
                      ? await narrateSanitiserReadinessReport({
                          since,
                          limit: args.limit,
                        })
                      : await buildTelemetrySummary({since, limit: args.limit});
    return result;
  } finally {
    await closeDb();
  }
}

async function maybePersistBundle<T extends {schema: string}>(
  bundle: T,
  persist: boolean,
  writeTelemetryJsonArtifact: typeof import('../telemetryArtifacts.js').writeTelemetryJsonArtifact,
): Promise<T | (T & {persisted_artifact: unknown})> {
  if (!persist) return bundle;
  const persisted = await writeTelemetryJsonArtifact({
    artifactType: 'diagnostic_bundle',
    filenamePrefix: 'telemetry-bundle',
    payload: bundle,
    context: {
      traceId: `telemetry-bundle-${Date.now()}`,
    },
    metadata: {schema: bundle.schema},
    source: 'cli.telemetry_bundle',
  });
  return {...bundle, persisted_artifact: persisted};
}
