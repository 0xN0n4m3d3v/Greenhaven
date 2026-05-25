import { z } from 'zod';

const optionalString = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().optional(),
);

const nullableString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().nullable().default(null),
);

const nullableUrlString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().url().nullable().default(null),
);

const optionalPositiveInt = z.preprocess((value) => {
  if (value == null || value === '') return undefined;
  return typeof value === 'number' ? value : Number(value);
}, z.number().int().positive().optional());

const optionalNonNegativeInt = z.preprocess((value) => {
  if (value == null || value === '') return undefined;
  return typeof value === 'number' ? value : Number(value);
}, z.number().int().nonnegative().optional());

const optionalFlag = z.preprocess((value) => {
  if (value == null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return value;
}, z.boolean().optional());

const authCookieSecure = z.preprocess(
  (value) => {
    if (value == null || value === '') return undefined;
    if (value === '1') return 'on';
    if (value === '0') return 'off';
    return value;
  },
  z.enum(['auto', 'on', 'off']).optional(),
);

const ConfigSchema = z.object({
  port: optionalPositiveInt.default(7777),
  databaseUrl: nullableUrlString,
  pgliteDataDir: nullableString,
  pgPoolMax: optionalPositiveInt.default(30),
  pgSslRejectUnauthorized: optionalFlag.default(true),

  authSecret: z.string().min(32),
  authDisabled: optionalFlag.default(false),
  authCookieSecure: authCookieSecure.default('auto'),

  turnWatchdogMs: optionalPositiveInt.default(120_000),
  postTurnSpecialistWatchdogMs: optionalPositiveInt.default(90_000),
  postTurnSlotWatchdogMs: optionalPositiveInt.default(120_000),
  mutationBudget: optionalPositiveInt.default(5),

  gameplayLogDir: optionalString,
  gameplayLogMaxString: optionalPositiveInt.default(60_000),

  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  isDesktop: optionalFlag.default(false),
  webUiDist: nullableString,
  dataDir: nullableString,

  debugRoutesEnabled: optionalFlag.default(false),
  debugKey: nullableString,
  debugSse: optionalFlag.default(false),
  adminKey: nullableString,

  deepseekApiKey: nullableString,
  featherlessApiKey: nullableString,
  brokerModel: nullableString,
  narratorModel: nullableString,
  locationIntroModel: z.string().default('deepseek-chat'),
  cavemanPrompts: optionalFlag.default(false),

  devtoolsTmp: optionalString,
  contentReportDir: optionalString,
  telemetryOtlpEndpoint: z
    .string()
    .url()
    .default('https://telemetry.example.invalid:4318'),
  telemetryAllowRemoteExport: optionalFlag.default(false),

  livePlaytestTurnWatchdogMs: optionalNonNegativeInt,
});

export type Config = z.infer<typeof ConfigSchema>;

export type ConfigEnvKey =
  | 'ADMIN_KEY'
  | 'AUTH_COOKIE_SECURE'
  | 'AUTH_DISABLED'
  | 'AUTH_SECRET'
  | 'DATABASE_URL'
  | 'DEEPSEEK_API_KEY'
  | 'FEATHERLESS_API_KEY'
  | 'GEMINI_WEB_PORT'
  | 'GREENHAVEN_BROKER_MODEL'
  | 'GREENHAVEN_CAVEMAN_PROMPTS'
  | 'GREENHAVEN_CONTENT_REPORT_DIR'
  | 'GREENHAVEN_DATA_DIR'
  | 'GREENHAVEN_DEBUG_KEY'
  | 'GREENHAVEN_DEBUG_ROUTES'
  | 'GREENHAVEN_DEBUG_SSE'
  | 'GREENHAVEN_DESKTOP'
  | 'GREENHAVEN_DEVTOOLS_TMP'
  | 'GREENHAVEN_GAMEPLAY_LOG_DIR'
  | 'GREENHAVEN_GAMEPLAY_LOG_MAX_STRING'
  | 'GREENHAVEN_LOCATION_INTRO_MODEL'
  | 'GREENHAVEN_MUTATION_BUDGET'
  | 'GREENHAVEN_NARRATOR_MODEL'
  | 'GREENHAVEN_POST_TURN_SLOT_WATCHDOG_MS'
  | 'GREENHAVEN_POST_TURN_SPECIALIST_WATCHDOG_MS'
  | 'GREENHAVEN_TELEMETRY_ALLOW_REMOTE_EXPORT'
  | 'GREENHAVEN_TELEMETRY_OTLP_ENDPOINT'
  | 'GREENHAVEN_TURN_WATCHDOG_MS'
  | 'GREENHAVEN_WEB_UI_DIST'
  | 'NODE_ENV'
  | 'PGPOOL_MAX'
  | 'PGLITE_DATA_DIR'
  | 'PGSSL_REJECT_UNAUTHORIZED';

// SEC-7 / DEEP-14 — fatal production guards. Anything that
// **must not exist** in a `NODE_ENV=production` deploy is enforced
// here, between the schema parse and the frozen-return. The
// historical behavior was a once-per-minute warning from
// `requireAuth`, which is too easy to miss in log noise; this hard
// exit makes the misconfiguration impossible to ignore. Tests cover
// the guard via the exported helper plus the integrated
// `readEnv()` path so the contract is pinned without booting the
// full server.
export function enforceFatalConfigGuards(cfg: Config): void {
  if (cfg.nodeEnv === 'production' && cfg.authDisabled) {
    console.error(
      '[config] FATAL: AUTH_DISABLED=1 is forbidden in production.',
    );
    process.exit(1);
  }
}

function readEnv(): Config {
  const env = process.env;
  const result = ConfigSchema.safeParse({
    port: env['GEMINI_WEB_PORT'],
    databaseUrl: env['DATABASE_URL'] ?? null,
    pgliteDataDir: env['PGLITE_DATA_DIR'] ?? null,
    pgPoolMax: env['PGPOOL_MAX'],
    pgSslRejectUnauthorized: env['PGSSL_REJECT_UNAUTHORIZED'],

    authSecret: env['AUTH_SECRET'],
    authDisabled: env['AUTH_DISABLED'],
    authCookieSecure: env['AUTH_COOKIE_SECURE'],

    turnWatchdogMs: env['GREENHAVEN_TURN_WATCHDOG_MS'],
    postTurnSpecialistWatchdogMs:
      env['GREENHAVEN_POST_TURN_SPECIALIST_WATCHDOG_MS'],
    postTurnSlotWatchdogMs: env['GREENHAVEN_POST_TURN_SLOT_WATCHDOG_MS'],
    mutationBudget: env['GREENHAVEN_MUTATION_BUDGET'],

    gameplayLogDir: env['GREENHAVEN_GAMEPLAY_LOG_DIR'],
    gameplayLogMaxString: env['GREENHAVEN_GAMEPLAY_LOG_MAX_STRING'],

    nodeEnv: env['NODE_ENV'] ?? 'development',
    isDesktop: env['GREENHAVEN_DESKTOP'],
    webUiDist: env['GREENHAVEN_WEB_UI_DIST'] ?? null,
    dataDir: env['GREENHAVEN_DATA_DIR'] ?? null,

    debugRoutesEnabled: env['GREENHAVEN_DEBUG_ROUTES'],
    debugKey: env['GREENHAVEN_DEBUG_KEY'] ?? null,
    debugSse: env['GREENHAVEN_DEBUG_SSE'],
    adminKey: env['ADMIN_KEY'] ?? null,

    deepseekApiKey: env['DEEPSEEK_API_KEY'] ?? null,
    featherlessApiKey: env['FEATHERLESS_API_KEY'] ?? null,
    brokerModel: env['GREENHAVEN_BROKER_MODEL'] ?? null,
    narratorModel: env['GREENHAVEN_NARRATOR_MODEL'] ?? null,
    locationIntroModel: env['GREENHAVEN_LOCATION_INTRO_MODEL'],
    cavemanPrompts: env['GREENHAVEN_CAVEMAN_PROMPTS'],

    devtoolsTmp: env['GREENHAVEN_DEVTOOLS_TMP'],
    contentReportDir: env['GREENHAVEN_CONTENT_REPORT_DIR'],
    telemetryOtlpEndpoint: env['GREENHAVEN_TELEMETRY_OTLP_ENDPOINT'],
    telemetryAllowRemoteExport: env['GREENHAVEN_TELEMETRY_ALLOW_REMOTE_EXPORT'],

    livePlaytestTurnWatchdogMs: env['GREENHAVEN_TURN_WATCHDOG_MS'],
  });
  if (!result.success) {
    console.error('[config] invalid configuration:', result.error.issues);
    process.exit(1);
  }
  enforceFatalConfigGuards(result.data);
  return Object.freeze(result.data);
}

let cached: Config | null = null;

export function config(): Config {
  if (!cached) cached = readEnv();
  return cached;
}

export function rawConfigEnv(key: ConfigEnvKey): string | undefined {
  return process.env[key];
}

export function setConfigEnv(key: ConfigEnvKey, value: string): void {
  assertConfigUncached(`set ${key}`);
  process.env[key] = value;
}

export function clearConfigEnv(key: ConfigEnvKey): void {
  assertConfigUncached(`clear ${key}`);
  delete process.env[key];
}

export function configEnvSnapshot(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function assertConfigUncached(action: string): void {
  if (cached) {
    throw new Error(
      `[config] cannot ${action} after config() has been read; set runtime env before bootstrapping modules`,
    );
  }
}
