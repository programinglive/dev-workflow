import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { searchProject, readCandidate, MAX_CANDIDATE_FILES, MAX_EXCERPT_CHARS, MAX_FILE_BYTES } from '../search-project.js';

const roots = new Set();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dev-workflow-search-'));
  roots.add(root);
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'search-test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Search Test']);
  return root;
}

async function addTracked(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixtures']);
}

describe('searchProject', () => {
  it('returns repository-relative citations with one-based line numbers from tracked and untracked files', async () => {
    const root = await makeRepo();
    await addTracked(root, { 'src/worker.js': 'first line\nworkflow state is loaded here\nlast line\n' });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs/new-note.md'), 'new workflow state note\n');

    const result = await searchProject({ projectDir: root, query: 'workflow state' });

    assert.deepEqual(result.hits.map(({ path: file, line }) => [file, line]), [
      ['docs/new-note.md', 1],
      ['src/worker.js', 2],
    ]);
    assert.equal(result.hits[0].text, 'new workflow state note');
  });

  it('ranks exact phrase matches before lines that only share query terms', async () => {
    const root = await makeRepo();
    await addTracked(root, {
      'a.md': 'search tool returns a result\n',
      'z.md': 'the search_project tool\n',
    });

    const result = await searchProject({ projectDir: root, query: 'search_project tool' });

    assert.equal(result.hits[0].path, 'z.md');
  });

  it('excludes ignored and sensitive files, including sensitive files already tracked by Git', async () => {
    const root = await makeRepo();
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
    await mkdir(path.join(root, 'ignored'), { recursive: true });
    await writeFile(path.join(root, 'ignored/private.txt'), 'workflow needle ignored\n');
    await writeFile(path.join(root, '.env.production'), 'workflow needle fake-secret\n');
    await writeFile(path.join(root, 'service-key.pem'), 'workflow needle fake-key\n');
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs/public.md'), 'workflow needle public\n');
    execFileSync('git', ['-C', root, 'add', '.gitignore', 'docs/public.md']);
    execFileSync('git', ['-C', root, 'add', '-f', '.env.production', 'service-key.pem']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixtures']);

    const result = await searchProject({ projectDir: root, query: 'workflow needle' });

    assert.deepEqual(result.hits.map(({ path: file }) => file), ['docs/public.md']);
  });

  it('excludes environment and token-named files even when Git tracks them', async () => {
    const root = await makeRepo();
    await writeFile(path.join(root, 'config.env'), 'needle fake-env-value\n');
    await writeFile(path.join(root, 'token.json'), 'needle fake-token-value\n');
    await writeFile(path.join(root, 'docs.md'), 'needle public documentation\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixtures']);

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.deepEqual(result.hits.map(({ path: file }) => file), ['docs.md']);
  });
  it('removes control characters from matching source lines', async () => {
    const root = await makeRepo();
    await addTracked(root, { 'docs.md': 'needle\tvalue\n' });

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.equal(result.hits[0].text, 'needle value');
  });
  it('returns no hits for unmatched text and rejects an empty query', async () => {
    const root = await makeRepo();
    await addTracked(root, { 'README.md': 'only harmless text\n' });

    assert.deepEqual((await searchProject({ projectDir: root, query: 'missing phrase' })).hits, []);
    await assert.rejects(searchProject({ projectDir: root, query: '   ' }), /query/i);
  });

  it('enforces caller result limits and excerpt length', async () => {
    const root = await makeRepo();
    const longLine = `needle ${'x'.repeat(MAX_EXCERPT_CHARS + 100)}`;
    await addTracked(root, {
      'a.txt': `${longLine}\nneedle second\n`,
      'b.txt': 'needle third\n',
    });

    const result = await searchProject({ projectDir: root, query: 'needle', limit: 1 });

    assert.equal(result.hits.length, 1);
    assert.ok(result.hits[0].text.length <= MAX_EXCERPT_CHARS);
    assert.equal(result.truncated, true);
  });

  it('skips binary and oversized files and reports skipped work', async () => {
    const root = await makeRepo();
    await addTracked(root, { 'docs/readme.md': 'needle safe result\n' });
    await writeFile(path.join(root, 'binary.dat'), Buffer.from([0x6e, 0x65, 0x65, 0, 0x64, 0x6c, 0x65]));
    await writeFile(path.join(root, 'invalid-utf8.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(path.join(root, 'huge.txt'), `${'x'.repeat(MAX_FILE_BYTES + 1)} needle\n`);

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.deepEqual(result.hits.map(({ path: file }) => file), ['docs/readme.md']);
    assert.ok(result.skipped >= 3);
    assert.equal(result.truncated, true);
  });

  it('escapes control characters in repository paths and treats traversal text as ordinary query text', async (context) => {
    const root = await makeRepo();
    await mkdir(path.join(root, 'docs'), { recursive: true });
    const strangeName = 'docs/line\nbreak.md';
    try {
      await writeFile(path.join(root, strangeName), 'needle inside repository\n');
    } catch (error) {
      context.skip(`control characters unavailable in file paths: ${error.code || error.message}`);
      return;
    }
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);

    const result = await searchProject({ projectDir: root, query: '../needle' });

    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].path, 'docs/line\\x0abreak.md');
    assert.equal(result.hits[0].text, 'needle inside repository');
  });
  it('does not follow a tracked path whose parent symlink resolves outside the repository', async (context) => {
    const root = await makeRepo();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'dev-workflow-search-outside-'));
    roots.add(outside);
    await mkdir(path.join(root, 'safe'), { recursive: true });
    await writeFile(path.join(root, 'safe', 'note.txt'), 'needle internal placeholder\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
    await writeFile(path.join(outside, 'note.txt'), 'needle must never leak\n');
    await rm(path.join(root, 'safe'), { recursive: true, force: true });
    try {
      await symlink(outside, path.join(root, 'safe'), 'junction');
    } catch (error) {
      context.skip(`symlinks unavailable: ${error.code || error.message}`);
      return;
    }

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.deepEqual(result.hits, []);
  });

  it('stops at the cumulative read budget and reports truncated results', async () => {
    const root = await makeRepo();
    const files = {};
    for (let index = 0; index < 81; index += 1) {
      files[`data/${String(index).padStart(3, '0')}.txt`] = 'x'.repeat(MAX_FILE_BYTES);
    }
    files['zz-needle.txt'] = 'needle after scan budget\n';
    await addTracked(root, files);

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.equal(result.hits.length, 0);
    assert.equal(result.bytesRead, 20 * 1024 * 1024);
    assert.equal(result.truncated, true);
  });
  it('caps very large Git path inventories and reports an incomplete scan', async () => {
    const root = await makeRepo();
    await addTracked(root, { 'seed.txt': 'unmatched text\n' });
    const blob = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD:seed.txt'], { encoding: 'utf8' }).trim();
    const entries = Array.from({ length: MAX_CANDIDATE_FILES + 1 }, (_, index) =>
      `100644 ${blob}\tfixtures/${String(index).padStart(5, '0')}.txt`).join('\n') + '\n';
    execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input: entries });

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.equal(result.scanned, MAX_CANDIDATE_FILES);
    assert.equal(result.truncated, true);
  });
  it('refuses a project directory that is not a Git repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dev-workflow-not-repo-'));
    roots.add(root);
    await writeFile(path.join(root, 'note.txt'), 'needle\n');

    await assert.rejects(searchProject({ projectDir: root, query: 'needle' }), /git|repository/i);
  });
  it('does not return a query match that exists only inside a redacted long credential assignment', async () => {
    const root = await makeRepo();
    const credential = `PASSWORD = "${'x'.repeat(120)}middle-secret${'z'.repeat(120)}"`;
    await addTracked(root, { 'config.js': `${credential}\n` });

    const result = await searchProject({ projectDir: root, query: 'middle-secret' });

    assert.deepEqual(result.hits, []);
  });
  it('excludes credential paths already protected by the repository security policy', async () => {
    const root = await makeRepo();
    await addTracked(root, {
      '.kube/config': 'needle fake-kube-value\n',
      'gcloud/cache.txt': 'needle fake-gcloud-value\n',
      'id_dsa': 'needle fake-ssh-key\n',
      'docs/public.txt': 'needle public\n',
    });

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.deepEqual(result.hits.map(({ path: file }) => file), ['docs/public.txt']);
  });
  it('excludes files ignored by Git even when they are already tracked', async () => {
    const root = await makeRepo();
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'ignored.txt'), 'needle fake-ignored-value\n');
    await writeFile(path.join(root, 'public.txt'), 'needle public\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixtures']);

    const result = await searchProject({ projectDir: root, query: 'needle' });

    assert.deepEqual(result.hits.map(({ path: file }) => file), ['public.txt']);
  });
  it('does not follow a tracked path through a Windows directory junction inside the repository', async (context) => {
    if (process.platform !== 'win32') {
      context.skip('directory junction behavior is Windows-specific');
      return;
    }
    const root = await makeRepo();
    await writeFile(path.join(root, '.gitignore'), 'secrets/\n');
    await mkdir(path.join(root, 'safe'), { recursive: true });
    await mkdir(path.join(root, 'secrets'), { recursive: true });
    await writeFile(path.join(root, 'safe', 'note.txt'), 'needle safe placeholder\n');
    await writeFile(path.join(root, 'secrets', 'note.txt'), 'needle fake-junction-secret\n');
    execFileSync('git', ['-C', root, 'add', '.gitignore', 'safe/note.txt']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixtures']);
    await rm(path.join(root, 'safe'), { recursive: true, force: true });
    await symlink(path.join(root, 'secrets'), path.join(root, 'safe'), 'junction');

    const result = await searchProject({ projectDir: root, query: 'fake-junction-secret' });

    assert.deepEqual(result.hits, []);
  });
  it('keeps only the requested number of best matches while scanning dense files', async () => {
    const root = await makeRepo();
    const content = Array.from({ length: 18_000 }, (_, index) => `needle ${index}`).join('\n');
    await addTracked(root, { 'dense.txt': content });

    const result = await searchProject({ projectDir: root, query: 'needle', limit: 1 });

    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].line, 1);
    assert.equal(result.truncated, true);
  });
  it('rejects an oversized file reported by the opened handle before reading it', async () => {
    const root = await makeRepo();
    await addTracked(root, { 'race.txt': 'needle safe placeholder\n' });
    let didRead = false;

    const result = await readCandidate(root, 'race.txt', MAX_FILE_BYTES, async (...args) => {
      const handle = await open(...args);
      return {
        stat: async () => {
          const snapshot = await handle.stat();
          return {
            dev: snapshot.dev,
            ino: snapshot.ino,
            size: MAX_FILE_BYTES + 100,
            isFile: () => snapshot.isFile(),
          };
        },
        read: (...readArgs) => {
          didRead = true;
          return handle.read(...readArgs);
        },
        close: handle.close.bind(handle),
      };
    });

    assert.equal(result.skipped, true);
    assert.equal(result.truncated, true);
    assert.equal(didRead, false);
    assert.ok((result.bytesRead || 0) <= MAX_FILE_BYTES);
  });
});
