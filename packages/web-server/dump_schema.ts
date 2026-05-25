import './src/tools/index.js';
import {getRegisteredTools} from './src/tools/base.js';
import {zodToJsonSchema} from 'zod-to-json-schema';

// Replicate the sanitiser from adapter.ts.
const STRIP_KEYS = new Set([
  '$schema','$ref','default','additionalProperties','not','if','then','else',
  'patternProperties','unevaluatedProperties','unevaluatedItems','examples','const',
]);
function sanitise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitise);
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(obj[key])) {
      const variants = (obj[key] as Array<Record<string, unknown>>).filter(
        v => typeof v === 'object' && v !== null && 'type' in v,
      );
      const picked = variants[0] ?? {type: 'string'};
      delete obj[key];
      Object.assign(obj, picked);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_KEYS.has(k)) continue;
    out[k] = sanitise(v);
  }
  return out;
}

const tools = getRegisteredTools();
for (const [name, t] of tools) {
  const raw = zodToJsonSchema(t.paramsSchema as any, {target:'openApi3', $refStrategy:'none'});
  const clean = sanitise(raw);
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(clean, null, 2));
}
