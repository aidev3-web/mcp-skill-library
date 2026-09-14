import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../lib/frontmatter.js';

test('returns null when there is no frontmatter block', () => {
  assert.equal(parseFrontmatter('# just a heading\nno frontmatter here'), null);
});

test('parses simple flat key: value pairs', () => {
  const content = '---\nname: my-skill\ndescription: does a thing\n---\n\n# body';
  assert.deepEqual(parseFrontmatter(content), { name: 'my-skill', description: 'does a thing' });
});

test('strips matching surrounding double or single quotes', () => {
  const content = '---\nname: "quoted-name"\ndescription: \'single quoted\'\n---\n';
  assert.deepEqual(parseFrontmatter(content), { name: 'quoted-name', description: 'single quoted' });
});

test('joins a multi-line value continued by indentation', () => {
  const content = '---\nname: x\ndescription: first line\n  continued line\n  and more\n---\n';
  assert.deepEqual(parseFrontmatter(content), {
    name: 'x',
    description: 'first line continued line and more',
  });
});

test('accepts any key generically, not just name/description', () => {
  const content = '---\nname: x\ndescription: y\nlicense: MIT\n---\n';
  assert.deepEqual(parseFrontmatter(content), { name: 'x', description: 'y', license: 'MIT' });
});

test('handles CRLF line endings the same as LF', () => {
  const content = '---\r\nname: x\r\ndescription: y\r\n---\r\n';
  assert.deepEqual(parseFrontmatter(content), { name: 'x', description: 'y' });
});

test('returns an object with no keys when the block has no parseable lines', () => {
  assert.deepEqual(parseFrontmatter('---\njust some prose, not key: value\n---\n'), {});
});
