// Rich details for attachments: Linear issues over the Linear GraphQL API,
// Notion pages through the signed-in `ntn` CLI, GitHub issues and PRs
// through `gh`, and OpenGraph previews for other web pages. Every fetch is
// bounded in time and size, and every parser tolerates missing fields.
import { isIP } from "node:net";
import { z } from "zod";
import { run } from "./cli.ts";
import type { GithubItem, LinearIssue, NotionPage, WebPreview } from "./types.ts";

const DESCRIPTION_MAX = 4_000;
const EXCERPT_MAX = 400;

const clip = (text: string | null | undefined, max: number): string | null => {
  if (text == null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

// ---- Linear -------------------------------------------------------------

const LINEAR_QUERY = `query($id: String!) {
  issue(id: $id) {
    identifier title url description priority priorityLabel estimate dueDate updatedAt
    state { name color type }
    assignee { displayName name avatarUrl }
    labels { nodes { name color } }
    team { key }
    project { name }
    cycle { number name }
    children(first: 20) { nodes { identifier title state { type } } }
    attachments(first: 10) { nodes { title url } }
  }
}`;

const linearIssueSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number().nullable().optional(),
  priorityLabel: z.string().nullable().optional(),
  estimate: z.number().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  updatedAt: z.string(),
  state: z.object({ name: z.string(), color: z.string(), type: z.string() }).nullable().optional(),
  assignee: z
    .object({ displayName: z.string().nullable().optional(), name: z.string(), avatarUrl: z.string().nullable().optional() })
    .nullable()
    .optional(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string() })) }).optional(),
  team: z.object({ key: z.string() }).nullable().optional(),
  project: z.object({ name: z.string() }).nullable().optional(),
  cycle: z.object({ number: z.number(), name: z.string().nullable().optional() }).nullable().optional(),
  children: z
    .object({
      nodes: z.array(
        z.object({ identifier: z.string(), title: z.string(), state: z.object({ type: z.string() }).nullable().optional() }),
      ),
    })
    .optional(),
  attachments: z.object({ nodes: z.array(z.object({ title: z.string(), url: z.string() })) }).optional(),
});

const linearResponseSchema = z.object({
  data: z.object({ issue: linearIssueSchema.nullable() }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** One Linear issue by key (`ENG-123`), or null when Linear has none. */
export async function fetchLinearIssue(identifier: string, apiKey: string): Promise<LinearIssue | null> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey },
    body: JSON.stringify({ query: LINEAR_QUERY, variables: { id: identifier } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Linear rejected the API key. Check it in the plugin settings.");
  }
  const body = linearResponseSchema.parse(await response.json());
  const issue = body.data?.issue ?? null;
  if (issue === null) {
    // Linear reports an unknown key as an "Entity not found" error.
    if (body.errors?.some((error) => /not found/iu.test(error.message)) ?? true) return null;
    throw new Error(body.errors?.[0]?.message ?? `Linear returned no issue for ${identifier}`);
  }
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state ?? null,
    priority: issue.priority ?? 0,
    priorityLabel: issue.priorityLabel ?? "No priority",
    assignee:
      issue.assignee == null
        ? null
        : { name: issue.assignee.displayName || issue.assignee.name, avatarUrl: issue.assignee.avatarUrl ?? null },
    labels: issue.labels?.nodes ?? [],
    team: issue.team?.key ?? null,
    project: issue.project?.name ?? null,
    cycle: issue.cycle == null ? null : (issue.cycle.name ?? `Cycle ${issue.cycle.number}`),
    estimate: issue.estimate ?? null,
    dueDate: issue.dueDate ?? null,
    description: clip(issue.description, DESCRIPTION_MAX),
    children: (issue.children?.nodes ?? []).map((child) => ({
      identifier: child.identifier,
      title: child.title,
      stateType: child.state?.type ?? null,
    })),
    links: issue.attachments?.nodes ?? [],
    updatedAt: issue.updatedAt,
  };
}

// ---- Notion -------------------------------------------------------------

const richTextSchema = z.array(z.object({ plain_text: z.string().optional() }).passthrough());

const notionPageSchema = z.object({
  url: z.string(),
  last_edited_time: z.string(),
  icon: z
    .object({
      type: z.string(),
      emoji: z.string().optional(),
      external: z.object({ url: z.string() }).optional(),
      file: z.object({ url: z.string() }).optional(),
      custom_emoji: z.object({ url: z.string() }).optional(),
    })
    .nullable()
    .optional(),
  cover: z
    .object({ external: z.object({ url: z.string() }).optional(), file: z.object({ url: z.string() }).optional() })
    .nullable()
    .optional(),
  properties: z.record(z.string(), z.object({ type: z.string(), title: richTextSchema.optional() }).passthrough()),
});

const notionBlocksSchema = z.object({
  results: z.array(z.object({ type: z.string() }).catchall(z.unknown())),
});

const plain = (text: z.infer<typeof richTextSchema> | undefined) =>
  (text ?? []).map((part) => part.plain_text ?? "").join("");

async function ntn(path: string, ...inputs: string[]): Promise<unknown> {
  return JSON.parse(await run("ntn", ["api", path, ...inputs], { timeoutMs: 20_000 }));
}

/** One Notion page's title, icon, and opening text. */
export async function fetchNotionPage(pageId: string): Promise<NotionPage> {
  const page = notionPageSchema.parse(await ntn(`v1/pages/${pageId}`));
  const titleProperty = Object.values(page.properties).find((property) => property.type === "title");
  const icon = page.icon;
  let excerpt: string | null = null;
  try {
    const blocks = notionBlocksSchema.parse(await ntn(`v1/blocks/${pageId}/children`, "page_size==8"));
    const lines = blocks.results.flatMap((block) => {
      const content = block[block.type] as { rich_text?: z.infer<typeof richTextSchema> } | undefined;
      const text = plain(content?.rich_text).trim();
      return text === "" || block.type.startsWith("heading") ? [] : [text];
    });
    excerpt = clip(lines.join(" "), EXCERPT_MAX);
  } catch {
    // The page header is still useful without its body.
  }
  return {
    title: plain(titleProperty?.title).trim() || "Untitled",
    url: page.url,
    icon:
      icon == null
        ? null
        : icon.emoji
          ? { emoji: icon.emoji }
          : (icon.custom_emoji?.url ?? icon.external?.url ?? icon.file?.url)
            ? { imageUrl: (icon.custom_emoji?.url ?? icon.external?.url ?? icon.file?.url)! }
            : null,
    coverUrl: page.cover?.external?.url ?? page.cover?.file?.url ?? null,
    lastEditedAt: page.last_edited_time,
    excerpt,
  };
}

// ---- GitHub -------------------------------------------------------------

const githubIssueSchema = z.object({
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  body: z.string().nullable().optional(),
  comments: z.number().optional(),
  updated_at: z.string(),
  user: z.object({ login: z.string(), avatar_url: z.string().optional() }).nullable().optional(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })).optional(),
  pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
});

/** A GitHub issue or pull request; the issues endpoint serves both. */
export async function fetchGithubItem(repo: string, number: number): Promise<GithubItem> {
  const raw = JSON.parse(await run("gh", ["api", `repos/${repo}/issues/${number}`], { timeoutMs: 20_000 }));
  const item = githubIssueSchema.parse(raw);
  const merged = item.pull_request?.merged_at != null;
  return {
    title: item.title,
    state: merged ? "merged" : item.state === "closed" ? "closed" : item.draft ? "draft" : "open",
    author: item.user == null ? null : { login: item.user.login, avatarUrl: item.user.avatar_url ?? null },
    labels: (item.labels ?? []).map((label) => ({ name: label.name, color: `#${label.color}` })),
    comments: item.comments ?? 0,
    updatedAt: item.updated_at,
    // Strip HTML comments that PR templates leave in bodies.
    excerpt: clip(item.body?.replace(/<!--[\s\S]*?-->/gu, ""), EXCERPT_MAX),
  };
}

// ---- Web pages and images -------------------------------------------------

const PAGE_BYTES_MAX = 768 * 1024;
export const IMAGE_BYTES_MAX = 3 * 1024 * 1024;

/** Refuses loopback, link-local, and private addresses before any request. */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIP(host) !== 0) {
    return !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd]|fe80)/iu.test(host);
  }
  return true;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes || response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/giu, (entity, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/\s+/gu, " ");
}

/** OpenGraph and Twitter card fields, then `<title>`, from raw HTML. */
export function parseWebPreview(html: string, baseUrl: string): WebPreview {
  const head = html.slice(0, 200_000);
  const meta = (name: string): string | null => {
    for (const tag of head.matchAll(/<meta\b[^>]*>/giu)) {
      const attrs = tag[0];
      const key = /(?:property|name)\s*=\s*["']([^"']+)["']/iu.exec(attrs)?.[1]?.toLowerCase();
      if (key !== name) continue;
      const content = /content\s*=\s*["']([^"']*)["']/iu.exec(attrs)?.[1];
      if (content) return decodeEntities(content).trim();
    }
    return null;
  };
  const title = meta("og:title") ?? meta("twitter:title") ?? /<title[^>]*>([^<]*)<\/title>/iu.exec(head)?.[1]?.trim() ?? null;
  let imageUrl = meta("og:image") ?? meta("twitter:image");
  if (imageUrl !== null) {
    try {
      imageUrl = new URL(imageUrl, baseUrl).toString();
    } catch {
      imageUrl = null;
    }
  }
  return {
    title: title === null ? null : clip(decodeEntities(title), 160),
    description: clip(meta("og:description") ?? meta("twitter:description") ?? meta("description"), 300),
    siteName: meta("og:site_name"),
    imageUrl,
  };
}

const BROWSER_HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh) bb-env-panel/0.2 (link preview)", accept: "text/html,*/*;q=0.5" };

/** A link preview, or null when the page is not HTML or has nothing useful. */
export async function fetchWebPreview(url: string): Promise<WebPreview | null> {
  if (!isPublicHttpUrl(url)) return null;
  const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(8_000) });
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) return null;
  const bytes = await readLimited(response, PAGE_BYTES_MAX);
  if (bytes === null) return null;
  const preview = parseWebPreview(new TextDecoder().decode(bytes), response.url || url);
  return preview.title === null && preview.description === null && preview.imageUrl === null ? null : preview;
}

/** A remote image as a data URL for `<img>`, or null when it is not one. */
export async function fetchImageDataUrl(url: string): Promise<string | null> {
  if (!isPublicHttpUrl(url)) return null;
  const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(10_000) });
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!response.ok || !type.startsWith("image/")) return null;
  const bytes = await readLimited(response, IMAGE_BYTES_MAX);
  return bytes === null ? null : `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}
