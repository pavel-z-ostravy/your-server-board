const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const YAML_BLOCK_PATTERN = /```ya?ml\r?\n([\s\S]*?)```/;

function extractFrontmatterField(frontmatterBlock, field) {
  const match = frontmatterBlock.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

// Extracts { title, description, yamlExample } from a widget doc's raw
// markdown (upstream gethomepage/homepage's docs/widgets/**/*.md shape:
// YAML frontmatter with title/description, then prose, then a fenced YAML
// config example). Any piece not found is null - a doc missing one piece
// (e.g. no fenced block) is still a valid, partially-usable result, not an
// error. `.match()` without the `g` flag returns the first match only, so
// a doc with multiple fenced blocks correctly yields the first one.
export function parseWidgetDoc(markdown) {
  if (typeof markdown !== "string") {
    return { title: null, description: null, yamlExample: null };
  }

  const frontmatterMatch = markdown.match(FRONTMATTER_PATTERN);
  const frontmatterBlock = frontmatterMatch ? frontmatterMatch[1] : "";

  const title = extractFrontmatterField(frontmatterBlock, "title");
  const description = extractFrontmatterField(frontmatterBlock, "description");

  const yamlMatch = markdown.match(YAML_BLOCK_PATTERN);
  const yamlExample = yamlMatch ? yamlMatch[1].trimEnd() : null;

  return { title, description, yamlExample };
}
