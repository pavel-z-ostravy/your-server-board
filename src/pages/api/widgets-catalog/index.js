import createLogger from "utils/logger";
import { parseWidgetDoc } from "utils/parseWidgetDoc";
import { cachedRequest } from "utils/proxy/http";

const logger = createLogger("widgetsCatalog");

const TREE_URL = "https://api.github.com/repos/gethomepage/homepage/git/trees/dev?recursive=1";
const RAW_BASE_URL = "https://raw.githubusercontent.com/gethomepage/homepage/dev/";
const USER_AGENT = "your-server-board";
// 6 hours - keeps this route's total GitHub API usage (one api.github.com
// call per cache period; raw.githubusercontent.com calls are not subject to
// that limit) comfortably under the 60/hour unauthenticated rate limit.
const CACHE_MINUTES = 360;

const CATEGORY_DIRS = [
  ["docs/widgets/services/", "service"],
  ["docs/widgets/info/", "info"],
];

// Category-landing pages (docs/widgets/services/index.md, .../info/index.md)
// are real files with real frontmatter but aren't individual widget docs -
// excluded here rather than silently showing up as a fake "widget".
function categorizeAndSlug(path) {
  for (const [dir, category] of CATEGORY_DIRS) {
    if (path.startsWith(dir) && path.endsWith(".md")) {
      const slug = path.slice(dir.length, -".md".length);
      if (slug === "index") return null;
      return { category, slug };
    }
  }
  return null;
}

async function fetchWidgetEntry(path, slug) {
  const markdown = await cachedRequest(`${RAW_BASE_URL}${path}`, CACHE_MINUTES, USER_AGENT);
  const { title, description, yamlExample } = parseWidgetDoc(markdown);
  return { slug, title: title ?? slug, description: description ?? "", yamlExample };
}

export default async function handler(req, res) {
  let tree;
  try {
    tree = await cachedRequest(TREE_URL, CACHE_MINUTES, USER_AGENT);
  } catch (error) {
    logger.error("Failed to fetch widget doc file tree:", error);
    return res.status(500).json({ error: "Failed to fetch widget catalog" });
  }

  const matches = (tree?.tree ?? [])
    .map((entry) => {
      const info = categorizeAndSlug(entry.path);
      return info ? { path: entry.path, ...info } : null;
    })
    .filter((entry) => entry !== null);

  const results = await Promise.allSettled(matches.map((m) => fetchWidgetEntry(m.path, m.slug)));

  const services = [];
  const info = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      (matches[i].category === "service" ? services : info).push(result.value);
    } else {
      logger.error("Failed to fetch widget doc %s:", matches[i].path, result.reason);
    }
  });

  const byTitle = (a, b) => a.title.localeCompare(b.title);
  services.sort(byTitle);
  info.sort(byTitle);

  return res.status(200).json({ services, info });
}
