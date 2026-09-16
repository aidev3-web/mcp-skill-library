// Tests for the fork + pull-request publishing flow.
//
// Context: the shared library repo is public and the people pushing to it are
// deliberately NOT collaborators, so push_skill can never write to upstream.
// The invariant these tests protect is narrow and absolute: NO write call
// (POST/PATCH/DELETE) may ever be aimed at the upstream repo. Everything is
// committed to the pusher's own fork and offered back as a PR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFork,
  createFork,
  findOpenPull,
  createPull,
  __setGhRunner,
} from '../lib/github.js';

// Builds a fake `gh` that answers from a route table and records every call,
// so a test can assert on what was requested, not just on what came back.
function fakeGh(routes) {
  const calls = [];
  __setGhRunner(async (args, opts) => {
    if (args[0] === '--version') return { code: 0, stdout: 'gh 2.0.0', stderr: '' };
    if (args[0] === 'auth') return { code: 0, stdout: 'logged in', stderr: '' };
    const path = args[1];
    const methodFlag = args.indexOf('-X');
    const method = methodFlag === -1 ? 'GET' : args[methodFlag + 1];
    const body = opts?.input ? JSON.parse(opts.input) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const handler = routes[key];
    if (!handler) return { code: 1, stdout: '', stderr: `HTTP 404: no fake route for ${key}` };
    const result = typeof handler === 'function' ? handler(calls.length) : handler;
    if (result?.httpError) return { code: 1, stdout: '', stderr: `HTTP ${result.httpError}: fake` };
    return { code: 0, stdout: JSON.stringify(result), stderr: '' };
  });
  return calls;
}

test.afterEach(() => __setGhRunner());

test('getFork returns null when the user has no fork yet', async () => {
  fakeGh({ 'GET /repos/me/SKILL-LIB': { httpError: 404 } });
  assert.equal(await getFork('me', 'upstream', 'SKILL-LIB'), null);
});

test('getFork accepts a real fork of this exact upstream', async () => {
  fakeGh({
    'GET /repos/me/SKILL-LIB': {
      full_name: 'me/SKILL-LIB',
      fork: true,
      parent: { full_name: 'upstream/SKILL-LIB' },
      default_branch: 'main',
    },
  });
  const fork = await getFork('me', 'upstream', 'SKILL-LIB');
  assert.equal(fork.mismatch, null);
  assert.equal(fork.fullName, 'me/SKILL-LIB');
});

// The dangerous case: you already own an unrelated repo that happens to share
// the library's name. Committing into it would quietly bury a skill inside
// someone else's project, so this must be reported, never silently used.
test('getFork flags a same-named repo that is NOT a fork of this upstream', async () => {
  fakeGh({
    'GET /repos/me/SKILL-LIB': {
      full_name: 'me/SKILL-LIB',
      fork: false,
      parent: null,
      default_branch: 'main',
    },
  });
  const fork = await getFork('me', 'upstream', 'SKILL-LIB');
  assert.equal(fork.mismatch, 'me/SKILL-LIB');
});

test('getFork flags a fork of a DIFFERENT upstream with the same name', async () => {
  fakeGh({
    'GET /repos/me/SKILL-LIB': {
      full_name: 'me/SKILL-LIB',
      fork: true,
      parent: { full_name: 'someone-else/SKILL-LIB' },
      default_branch: 'main',
    },
  });
  const fork = await getFork('me', 'upstream', 'SKILL-LIB');
  assert.equal(fork.mismatch, 'me/SKILL-LIB');
});

// GitHub's fork POST returns before the repo is usable. Without the poll, the
// very next write 404s on a fork that is about to exist.
test('createFork polls past the 404 window until the fork is readable', async () => {
  let reads = 0;
  fakeGh({
    'POST /repos/upstream/SKILL-LIB/forks': { owner: { login: 'me' }, full_name: 'me/SKILL-LIB' },
    'GET /repos/me/SKILL-LIB': () => {
      reads += 1;
      if (reads < 3) return { httpError: 404 };
      return { full_name: 'me/SKILL-LIB', default_branch: 'main' };
    },
  });
  const fork = await createFork('upstream', 'SKILL-LIB', { attempts: 5, delayMs: 1 });
  assert.equal(fork.fullName, 'me/SKILL-LIB');
  assert.equal(fork.owner, 'me');
  assert.equal(reads, 3, 'should have retried the read rather than failing on the first 404');
});

test('createFork gives up with an actionable message instead of hanging', async () => {
  fakeGh({
    'POST /repos/upstream/SKILL-LIB/forks': { owner: { login: 'me' }, full_name: 'me/SKILL-LIB' },
    'GET /repos/me/SKILL-LIB': { httpError: 404 },
  });
  await assert.rejects(
    () => createFork('upstream', 'SKILL-LIB', { attempts: 2, delayMs: 1 }),
    /still not readable.*run the same push again/s,
  );
});

// This lookup is what makes a re-push land in the PR already open for that
// skill instead of opening a duplicate one.
test('findOpenPull queries upstream with the cross-repo "owner:branch" head', async () => {
  const calls = fakeGh({
    'GET /repos/upstream/SKILL-LIB/pulls?state=open&head=me%3Askill%2Fgit-commit-check&per_page=1': [
      { number: 12, html_url: 'https://github.com/upstream/SKILL-LIB/pull/12', title: 'existing' },
    ],
  });
  const pr = await findOpenPull('upstream', 'SKILL-LIB', 'me', 'skill/git-commit-check');
  assert.equal(pr.number, 12);
  assert.equal(calls[0].method, 'GET', 'looking for an existing PR must not write anything');
});

test('findOpenPull returns null when no PR is open for that branch', async () => {
  fakeGh({
    'GET /repos/upstream/SKILL-LIB/pulls?state=open&head=me%3Askill%2Fnew&per_page=1': [],
  });
  assert.equal(await findOpenPull('upstream', 'SKILL-LIB', 'me', 'skill/new'), null);
});

test('createPull targets upstream from the fork branch, base = upstream default', async () => {
  const calls = fakeGh({
    'POST /repos/upstream/SKILL-LIB/pulls': { number: 7, html_url: 'https://github.com/upstream/SKILL-LIB/pull/7' },
  });
  const pr = await createPull('upstream', 'SKILL-LIB', {
    title: 'feat(library): Add demo skill',
    head: 'me:skill/demo',
    base: 'main',
    body: 'body',
  });
  assert.equal(pr.number, 7);
  assert.equal(calls[0].body.head, 'me:skill/demo');
  assert.equal(calls[0].body.base, 'main');
  assert.equal(calls[0].body.maintainer_can_modify, true);
});
