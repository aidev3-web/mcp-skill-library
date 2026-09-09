import test from 'node:test';
import assert from 'node:assert/strict';
import { tryGetBranchHead, createBranch, ensureGhReady, __setGhRunner } from '../lib/github.js';

// Simulates one `gh api ...` invocation's result (exit code + stdout/stderr),
// standing in for the real `gh` binary so these tests need neither `gh`
// installed nor network access.
function mockGhOnce({ code = 0, stdout = '', stderr = '' } = {}) {
  __setGhRunner(async () => ({ code, stdout, stderr }));
}

test.afterEach(() => {
  __setGhRunner(); // restore the real spawn-based runner after each test
});

test('branch not found (HTTP 404) -> tryGetBranchHead returns null, not a throw', async () => {
  mockGhOnce({ code: 1, stderr: 'gh: Not Found (HTTP 404)\n' });

  const sha = await tryGetBranchHead('owner', 'repo', 'does-not-exist');

  assert.equal(sha, null);
});

test('a real (non-404) error still throws from tryGetBranchHead', async () => {
  mockGhOnce({ code: 1, stderr: 'gh: Internal Server Error (HTTP 500)\n' });

  await assert.rejects(() => tryGetBranchHead('owner', 'repo', 'main'));
});

test('403 on a write call -> error message points at collaborator/write access', async () => {
  mockGhOnce({ code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });

  await assert.rejects(
    () => createBranch('owner', 'repo', 'skill/demo', 'deadbeef'),
    (err) => {
      assert.match(err.message, /collaborator|Write/);
      return true;
    },
  );
});

test('gh not installed (ENOENT) -> clear install instructions, not a raw spawn error', async () => {
  __setGhRunner(async () => {
    const err = new Error('spawn gh ENOENT');
    err.code = 'ENOENT';
    throw err;
  });

  await assert.rejects(
    () => tryGetBranchHead('owner', 'repo', 'main'),
    (err) => {
      assert.match(err.message, /cli\.github\.com/i);
      return true;
    },
  );
});

test('ensureGhReady() rejects with a login hint when `gh auth status` fails', async () => {
  let call = 0;
  __setGhRunner(async () => {
    call += 1;
    if (call === 1) return { code: 0, stdout: 'gh version 2.0.0\n', stderr: '' }; // --version
    return { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n' }; // auth status
  });

  await assert.rejects(() => ensureGhReady(), (err) => {
    assert.match(err.message, /gh auth login/);
    return true;
  });
});
