// Minimal SKILL.md frontmatter reader — only needs the two standard keys
// (name, description) that PACKAGING.md mandates; not a general YAML parser.
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;

  const data = {};
  let currentKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let value = kv[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      data[currentKey] = value;
    } else if (currentKey && /^\s+\S/.test(line)) {
      data[currentKey] += ' ' + line.trim();
    }
  }
  return data;
}
