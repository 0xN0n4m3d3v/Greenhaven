-- 0110_safe_jsonb_array_helper.sql
--
-- M-6 — JSONB array-shape helper.
--
-- The Greenhaven codebase repeats the same defensive pattern for
-- reading JSONB arrays out of authored cartridge profiles and
-- runtime values:
--
--   CASE WHEN jsonb_typeof(<expr>) = 'array' THEN <expr> ELSE '[]'::jsonb END
--
-- `<expr>` is often a chained `profile->'local_density'->'npc_ids'`
-- lookup that returns NULL when the parent key is missing, a JSONB
-- object when the cartridge author used the wrong shape, or a scalar
-- when an exporter wrote the wrong type. Any of those non-array
-- shapes will abort `jsonb_array_elements_text(...)` and crash the
-- whole query.
--
-- This helper centralises the guard:
--   safe_jsonb_array(NULL)            → '[]'::jsonb
--   safe_jsonb_array('{"a":1}')       → '[]'::jsonb
--   safe_jsonb_array('"hi"')          → '[]'::jsonb
--   safe_jsonb_array('42')            → '[]'::jsonb
--   safe_jsonb_array('true')          → '[]'::jsonb
--   safe_jsonb_array('[1,2,3]')       → '[1,2,3]'::jsonb
--
-- The helper is **NOT** marked STRICT.  STRICT would short-circuit
-- the function whenever any input is NULL, returning NULL instead of
-- '[]'.  Greenhaven callers rely on a missing JSON key flowing in as
-- NULL and coming back out as an empty array so the SQL still works
-- without explicit COALESCE.  Tests in
-- `src/__tests__/migrations/invariants.test.ts` cover this contract.
--
-- The function is IMMUTABLE: same input always produces the same
-- output, no I/O, no transaction state.  This lets Postgres lift the
-- call into index expressions and short-circuit repeated invocations
-- inside the same query.

CREATE OR REPLACE FUNCTION safe_jsonb_array(v jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN jsonb_typeof(v) = 'array' THEN v
           ELSE '[]'::jsonb
         END
$$;

COMMENT ON FUNCTION safe_jsonb_array(jsonb) IS
  'M-6: returns the input when it is a JSONB array, otherwise '
  'returns ''[]''::jsonb.  Not STRICT — NULL input returns the empty '
  'array so callers can safely feed missing JSON keys straight into '
  'jsonb_array_elements*.  Used by active runtime SQL to harden '
  'array-shape guards against authored/exported JSONB that may be '
  'missing, scalar, or object-shaped.';
