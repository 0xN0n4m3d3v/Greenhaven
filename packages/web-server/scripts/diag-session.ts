// One-shot inspector — what happened in today's chat sessions?
// Usage: npx tsx --env-file=.env scripts/diag-session.ts
import {query} from '../src/db.js';

async function main() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  console.log(`\n═══ Activity for ${today} ═══\n`);

  // Aggregate over last 7 days too — gives pattern info beyond a single
  // session. Lets us see whether memory/quests/combat are systematically
  // under-firing or this is just a quiet day.
  const span = await query<{
    tool_name: string;
    n_today: number;
    n_7d: number;
  }>(
    `WITH today AS (
       SELECT tool_name, COUNT(*)::int AS n FROM tool_invocations
        WHERE invoked_at::date = $1::date GROUP BY tool_name
     ), wk AS (
       SELECT tool_name, COUNT(*)::int AS n FROM tool_invocations
        WHERE invoked_at::date >= ($1::date - INTERVAL '6 days') GROUP BY tool_name
     )
     SELECT COALESCE(t.tool_name, w.tool_name) AS tool_name,
            COALESCE(t.n, 0) AS n_today,
            COALESCE(w.n, 0) AS n_7d
       FROM today t FULL OUTER JOIN wk w USING (tool_name)
      ORDER BY n_7d DESC, n_today DESC`,
    [today],
  );
  console.log('── Tool invocation breakdown (today vs last 7 days) ──');
  for (const t of span.rows) {
    console.log(`  ${t.tool_name.padEnd(28)} today=${String(t.n_today).padStart(3)} 7d=${String(t.n_7d).padStart(4)}`);
  }
  console.log();

  const turns = await query<{
    role: string;
    n: number;
    cost: string;
    avg_ms: number;
  }>(
    `SELECT role, COUNT(*)::int AS n, COALESCE(SUM(cost_usd),0)::text AS cost,
            COALESCE(AVG(duration_ms),0)::int AS avg_ms
       FROM turn_telemetry
      WHERE recorded_at::date = $1::date
      GROUP BY role
      ORDER BY n DESC`,
    [today],
  );
  console.log('── Turns by role ──');
  for (const t of turns.rows) {
    console.log(`  ${t.role.padEnd(20)} n=${t.n.toString().padStart(3)} cost=$${t.cost.slice(0, 8)} avg_ms=${t.avg_ms}`);
  }

  const tools = await query<{tool_name: string; n: number; errs: number}>(
    `SELECT tool_name, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errs
       FROM tool_invocations
      WHERE invoked_at::date = $1::date
      GROUP BY tool_name
      ORDER BY n DESC`,
    [today],
  );
  console.log('\n── Tool invocations by name ──');
  for (const t of tools.rows) {
    console.log(`  ${t.tool_name.padEnd(28)} n=${t.n.toString().padStart(3)} errs=${t.errs}`);
  }

  const recentTools = await query<{
    invoked_at: Date | string;
    player_id: number | null;
    tool_name: string;
    args: unknown;
    error: string | null;
  }>(
    `SELECT invoked_at::text AS invoked_at, player_id, tool_name, args, error
       FROM tool_invocations
      WHERE invoked_at::date = $1::date
      ORDER BY invoked_at DESC
      LIMIT 60`,
    [today],
  );
  console.log('\n── Last 60 tool invocations (newest first) ──');
  for (const t of recentTools.rows) {
    const args = t.args ? JSON.stringify(t.args).slice(0, 220) : '';
    const ts = String(t.invoked_at).slice(11, 19);
    const err = t.error ? ` ERR=${t.error.slice(0, 60)}` : '';
    console.log(`  ${ts} pl=${t.player_id ?? '–'} ${t.tool_name.padEnd(22)}${err}`);
    if (args) console.log(`     ${args}`);
  }

  const memories = await query<{
    id: number;
    owner_entity_id: number;
    about_entity_id: number | null;
    importance: number;
    text: string;
    tags: string[] | null;
    created_at: string;
  }>(
    `SELECT m.id, m.owner_entity_id, m.about_entity_id, m.importance, m.text, m.tags, m.created_at::text AS created_at
       FROM npc_memories m
      WHERE m.created_at::date = $1::date
      ORDER BY m.created_at DESC`,
    [today],
  );
  console.log(`\n── NPC memories created today (${memories.rows.length}) ──`);
  for (const m of memories.rows) {
    console.log(`  #${m.id} owner=${m.owner_entity_id} about=${m.about_entity_id} imp=${m.importance} tags=${JSON.stringify(m.tags)}`);
    console.log(`     "${m.text.slice(0, 220)}"`);
  }

  // chat_messages columns vary across schemas; just count + show last text.
  const chats = await query<{
    n: number;
    last_at: string | null;
  }>(
    `SELECT COUNT(*)::int AS n, MAX(created_at)::text AS last_at
       FROM chat_messages
      WHERE created_at::date = $1::date`,
    [today],
  );
  console.log('\n── Chat messages today ──');
  for (const c of chats.rows) {
    console.log(`  total=${c.n} last_at=${(c.last_at ?? '–').slice(0, 19)}`);
  }
  const cols = await query<{column_name: string}>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'chat_messages' ORDER BY ordinal_position`,
  );
  const colNames = cols.rows.map(r => r.column_name);
  const sender = colNames.includes('role') ? 'role' : colNames.includes('sender_role') ? 'sender_role' : colNames.includes('author_kind') ? 'author_kind' : 'NULL';
  const textCol = colNames.includes('text') ? 'text' : colNames.includes('content') ? 'content' : colNames.includes('visible') ? 'visible' : 'NULL';
  const recentChats = await query<{
    sender: string | null;
    text: string | null;
    created_at: string;
  }>(
    `SELECT
        ${sender} AS sender,
        ${textCol} AS text,
        created_at::text AS created_at
       FROM chat_messages
      WHERE created_at::date = $1::date
      ORDER BY created_at ASC`,
    [today],
  ).catch(() => ({rows: [] as Array<{sender: string | null; text: string | null; created_at: string}>}));
  console.log(`  (chat_messages cols: ${colNames.join(', ')})`);
  for (const c of recentChats.rows) {
    const ts = String(c.created_at).slice(11, 19);
    const txt = (c.text ?? '').replace(/\s+/g, ' ');
    console.log(`  ${ts} ${(c.sender ?? '?').padEnd(12)} ${txt.slice(0, 220)}`);
    if (txt.length > 220) console.log(`               …${txt.slice(220, 440)}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
