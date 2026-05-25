// Spec 37 §8 carried-over — narrative-anti-pattern lint.
//
// Scans packages/web-ui/src for the 12 banned anti-patterns from the
// research synthesis. HIGH severity → process.exit(1) (CI gate).
// MEDIUM/LOW only warn.
//
// Run via `npm run lint:narrative` from packages/web-ui/.

import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';

const ANTI_PATTERNS = [
  {
    id: 'success-error-toast',
    severity: 'high',
    re: /toast\.(success|error)\s*\(\s*['"](?:Success|Error|Done|Failed)/i,
    msg: 'Use diegetic toast text, not "Success"/"Error"',
  },
  {
    id: 'pure-black-white',
    severity: 'medium',
    re: /(?:^|[^A-Za-z])(?:#000(?!\w)|#FFF(?!\w)|rgb\(0,\s*0,\s*0\)|rgb\(255,\s*255,\s*255\))/,
    msg: 'Use tinted darks (--ink) and lights (--parchment), not pure black/white',
  },
  {
    id: 'ai-thinking-text',
    severity: 'high',
    re: /["']\s*AI is thinking\s*["']/i,
    msg: 'Replace with diegetic indicator ("the world holds its breath")',
  },
  {
    id: 'regenerate-copy-buttons',
    severity: 'medium',
    re: /<button[^>]*>\s*(?:Regenerate|Copy|Retry)\s*</,
    msg: 'Meta-controls (regen/copy) belong in long-press / context menu, not always-visible',
  },
  {
    id: 'three-dot-typing-narrator',
    severity: 'medium',
    re: /typing-indicator.*\.\.\.|three-dots/,
    where: /narrator|lore/,
    msg: 'Narrator typing indicator must be quill/ink, never three dots',
  },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(full, files);
    } else if (/\.(tsx?|css)$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

const root = path.resolve(process.cwd(), 'src');
const violations = [];
let scanned = 0;
for (const file of walk(root)) {
  scanned++;
  const content = readFileSync(file, 'utf8');
  for (const ap of ANTI_PATTERNS) {
    if (ap.where && !ap.where.test(file)) continue;
    if (ap.re.test(content)) violations.push({file, ap});
  }
}

const high = violations.filter(v => v.ap.severity === 'high');
for (const v of violations) {
  const fn = v.ap.severity === 'high' ? console.error : console.warn;
  fn(`[${v.ap.severity}] ${v.ap.id}: ${v.file} — ${v.ap.msg}`);
}
console.log(`scanned ${scanned} files, ${violations.length} violations (${high.length} high)`);
process.exit(high.length > 0 ? 1 : 0);
