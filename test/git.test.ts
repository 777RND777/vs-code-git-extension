import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepo } from '../src/git.ts';
import { merge3, splitLines } from '../src/merge3.ts';

let repo: GitRepo;

before(() => {
  const dir = join(mkdtempSync(join(tmpdir(), 'gw-')), 'demo');
  execFileSync(join(process.cwd(), 'scripts/make-demo-repo.sh'), [dir], { stdio: 'ignore' });
  repo = new GitRepo(dir);
});

test('log lists all branches by default, newest first', async () => {
  const commits = await repo.log({}, 0, 100);
  assert.equal(commits.length, 8);
  const subjects = commits.map((c) => c.subject);
  assert.ok(subjects.includes('Bump version to 1.0.1'));
  assert.ok(subjects.includes('Use the answer in the demo'));
  const head = commits.find((c) => c.refs.some((r) => r.current));
  assert.equal(head?.subject, 'Rename README and add usage');
  assert.deepEqual(head?.refs.map((r) => `${r.type}:${r.name}`).sort(), ['local:main', 'tag:v1.0']);
});

test('log filters by branch, author, text, path and hash', async () => {
  const onHotfix = await repo.log({ branch: 'refs/heads/hotfix/typo' }, 0, 100);
  assert.equal(onHotfix.length, 5);
  assert.ok(!onHotfix.some((c) => c.subject === 'Friendlier greeting'));

  const bob = await repo.log({ authors: ['Bob Lee <bob@example.com>'] }, 0, 100);
  assert.deepEqual(bob.map((c) => c.author), ['Bob Lee', 'Bob Lee', 'Bob Lee']);

  const bobOrCarol = await repo.log({ authors: ['Bob Lee <bob@example.com>', 'Carol Diaz <carol@example.com>'] }, 0, 100);
  assert.equal(bobOrCarol.length, 4);

  const text = await repo.log({ text: 'GREETING' }, 0, 100);
  assert.deepEqual(text.map((c) => c.subject), ['Friendlier greeting']);

  const byPath = await repo.log({ path: 'src/utils/version.ts' }, 0, 100);
  assert.equal(byPath.length, 2);

  const target = bob[1];
  const byHash = await repo.log({ text: target.hash.slice(0, 7) }, 0, 100);
  assert.equal(byHash[0].hash, target.hash);

  const page2 = await repo.log({}, 5, 5);
  assert.equal(page2.length, 3);
});

test('refs, authors and me', async () => {
  const refs = await repo.refs();
  assert.equal(refs.current, 'main');
  assert.deepEqual(refs.local.map((b) => b.name).sort(), ['feature/greeting', 'hotfix/typo', 'main']);
  assert.deepEqual(refs.tags, ['v1.0']);
  const authors = await repo.authors();
  assert.equal(authors.length, 4);
  assert.ok(authors.includes('Alice Smith <alice@example.com>'));
  assert.equal(await repo.me(), 'Demo User <demo@example.com>');
});

test('commit files, renames and combined changes', async () => {
  const commits = await repo.log({}, 0, 100);
  const byName = (s: string) => commits.find((c) => c.subject === s)!.hash;

  const rename = await repo.commitFiles(byName('Rename README and add usage'));
  assert.deepEqual(rename.map((f) => [f.status, f.leftPath, f.path]), [['R', 'README.md', 'README.markdown']]);

  const root = await repo.commitFiles(byName('Initial commit'));
  assert.deepEqual(root.map((f) => f.status + f.path).sort(), ['AREADME.md', 'Aapp.py']);

  const feature = ['Friendlier greeting', 'Add shout helper', 'Use the answer in the demo'].map(byName);
  const combined = await repo.combinedFiles(feature);
  assert.deepEqual(combined.map((f) => f.status + f.path), ['Mapp.py', 'Ashout.py']);
  const app = combined[0];
  assert.equal(app.leftRef, byName('Add version module'));
  assert.equal(app.rightRef, byName('Use the answer in the demo'));

  const content = await repo.show(app.rightRef!, 'app.py');
  assert.match(content!.toString(), /Hi there/);
  assert.match(content!.toString(), /add\(40, 2\)/);

  const details = await repo.details(byName('Friendlier greeting'));
  assert.equal(details.author, 'Bob Lee');
  assert.equal(details.message, 'Friendlier greeting');
});

test('merge state, conflicts and 3-way regions', async () => {
  const state = await repo.state();
  assert.equal(state.operation, 'merge');
  assert.equal(state.theirsLabel, 'feature/greeting');
  assert.equal(state.oursLabel, 'main (HEAD)');
  assert.deepEqual(state.conflicts, [{ path: 'app.py', code: 'UU', ours: 'modified', theirs: 'modified' }]);

  const [base, ours, theirs] = await Promise.all([':1', ':2', ':3'].map((s) => repo.show(s, 'app.py')));
  const regions = merge3(...([base, ours, theirs].map((b) => splitLines(b!.toString()).lines) as [string[], string[], string[]]));
  const changes = regions.filter((r) => r.kind === 'change');
  // Greeting line conflicts; docstring (ours) and add(40, 2) (theirs) merge cleanly.
  assert.equal(changes.filter((r) => r.kind === 'change' && r.conflict).length, 1);
  assert.equal(changes.filter((r) => r.kind === 'change' && !r.conflict).length, 2);
});

test('accept a side resolves the file', async () => {
  const [file] = await repo.conflicts();
  await repo.acceptSide(file, 'theirs');
  assert.deepEqual(await repo.conflicts(), []);
  await repo.continueOperation('merge');
  const state = await repo.state();
  assert.equal(state.operation, undefined);
  const head = await repo.details('HEAD');
  assert.equal(head.parents.length, 2);
  assert.equal(head.message, 'Merge feature/greeting');
});
