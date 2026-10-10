import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const root = resolve(process.argv[2] ?? '/app');
const plan = JSON.parse(readFileSync(new URL('./settled-finalization-fallback.json', import.meta.url), 'utf8'));
const hash = (text) => createHash('sha256').update(text).digest('hex');

// This correction is deliberately tied to one upstream bundle. A changed
// OpenClaw release must stop the image build instead of receiving a fuzzy
// source mutation whose finalization behaviour we have not re-verified.
// Every target is checked and prepared before any file is written, so a
// drift in one copy never leaves the image half patched.
if (!Array.isArray(plan.targets) || plan.targets.length === 0) throw new Error('Fallback patch plan has no targets');
const prepared = plan.targets.map((target) => {
  const path = resolve(root, target.file);
  let text = readFileSync(path, 'utf8');
  if (hash(text) !== target.before) throw new Error(`Upstream drift: ${target.file}`);
  const {before, after} = target.replacement;
  if (text.split(before).length !== 2) throw new Error(`Ambiguous fallback patch: ${target.file}`);
  text = text.replace(before, after);
  if (hash(text) !== target.after) throw new Error(`Fallback patch mismatch: ${target.file}`);
  return {path, text};
});
for (const {path, text} of prepared) writeFileSync(path, text);
console.log(`Applied verified settled-turn fallback correction for ${plan.upstream} (${prepared.length} files)`);
