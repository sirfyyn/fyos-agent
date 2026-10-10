import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const root = resolve(process.argv[2] ?? '/app');
const plan = JSON.parse(readFileSync(new URL('./stale-terminal-fence-fix.json', import.meta.url), 'utf8'));
const hash = (text) => createHash('sha256').update(text).digest('hex');

// Fail closed on any upstream drift; verify every copy before writing any.
if (!Array.isArray(plan.targets) || plan.targets.length === 0) throw new Error('Stale-terminal fence plan has no targets');
const prepared = plan.targets.map((target) => {
  const path = resolve(root, target.file);
  let text = readFileSync(path, 'utf8');
  if (hash(text) !== target.before) throw new Error(`Upstream drift: ${target.file}`);
  const {before, after} = target.replacement;
  if (text.split(before).length !== 2) throw new Error(`Ambiguous stale-terminal fence patch: ${target.file}`);
  text = text.replace(before, after);
  if (hash(text) !== target.after) throw new Error(`Stale-terminal fence patch mismatch: ${target.file}`);
  return {path, text};
});
for (const {path, text} of prepared) writeFileSync(path, text);
console.log(`Applied verified stale-terminal Direct Chat fence correction for ${plan.upstream} (${prepared.length} files)`);
