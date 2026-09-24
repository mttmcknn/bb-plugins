// Pure attachment discovery: finds what a thread refers to (links in the
// conversation, Linear keys in the branch name, files in thread storage) and
// classifies each one. No I/O; enrichment happens in enrich.ts.
import type { AttachmentRef } from "./types.ts";

const URL_PATTERN = /https?:\/\/[^\s"'`<>()[\]{}\\|^]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?*_~]+$/u;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif|heic)$/iu;
const LINEAR_KEY = /^[A-Z][A-Z0-9]{1,6}-\d{1,6}$/u;

/** Signed, local, or boilerplate URLs that are noise as references. */
function isNoise(url: URL): boolean {
  if (url.searchParams.has("X-Amz-Signature")) return true;
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)) return true;
  if (url.hostname === "claude.com" || url.hostname === "noreply.anthropic.com") return true;
  if (url.hostname === "api.github.com") return true;
  return false;
}

function titleFromSlug(slug: string): string {
  return decodeURIComponent(slug).replace(/[-_]+/gu, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Classifies one URL. `raw` must already parse as a URL. */
export function classifyUrl(raw: string): AttachmentRef {
  const url = new URL(raw);
  const host = url.hostname.replace(/^www\./u, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "linear.app") {
    const key = parts.find((part) => LINEAR_KEY.test(part));
    if (key !== undefined) return { id: `linear:${key}`, kind: "linear", url: raw, label: key, identifier: key };
  }
  if (host.endsWith("notion.so") || host.endsWith("notion.site") || host === "app.notion.com") {
    const pageId = /([0-9a-f]{32})(?:$|[?#])/iu.exec(parts.at(-1) ?? "")?.[1] ?? url.searchParams.get("p");
    const title = titleFromSlug((parts.at(-1) ?? "").replace(/-?[0-9a-f]{32}$/iu, ""));
    if (pageId) return { id: `notion:${pageId}`, kind: "notion", url: raw, label: title || "Notion page", pageId };
  }
  if (host === "github.com") {
    const [owner, repo, kind, number] = parts;
    if ((kind === "pull" || kind === "issues") && owner && repo && number && /^\d+$/u.test(number)) {
      return {
        id: `github:${owner}/${repo}#${number}`.toLowerCase(),
        kind: "github",
        url: `https://github.com/${owner}/${repo}/${kind}/${number}`,
        label: `${repo}#${number}`,
        repo: `${owner}/${repo}`,
        number: Number(number),
        isPull: kind === "pull",
      };
    }
  }
  if (host === "figma.com" && (parts[0] === "file" || parts[0] === "design" || parts[0] === "proto")) {
    return { id: `figma:${parts[1] ?? raw}`, kind: "figma", url: raw, label: titleFromSlug(parts[2] ?? "") || "Figma file" };
  }
  if (host.endsWith("slack.com")) {
    return { id: `slack:${url.pathname}`, kind: "slack", url: raw, label: "Slack message" };
  }
  if (IMAGE_EXTENSION.test(url.pathname)) {
    return { id: `image:${raw}`, kind: "image", url: raw, label: decodeURIComponent(parts.at(-1) ?? host) };
  }
  const path = url.pathname === "/" ? "" : url.pathname;
  return { id: `web:${raw}`, kind: "web", url: raw, label: truncate(`${host}${path}`, 60) };
}

/**
 * Distinct references in `texts`, most recent first. `texts` is oldest first.
 * Two URLs that name the same thing (a PR with and without a comment anchor,
 * a Linear issue with different slugs) collapse into one reference.
 */
export function extractLinks(texts: readonly string[], limit: number): AttachmentRef[] {
  const seen = new Set<string>();
  const refs: AttachmentRef[] = [];
  for (let index = texts.length - 1; index >= 0 && refs.length < limit; index -= 1) {
    const matches = [...(texts[index]?.matchAll(URL_PATTERN) ?? [])].reverse();
    for (const match of matches) {
      let url: URL;
      try {
        url = new URL(match[0].replace(TRAILING_PUNCTUATION, ""));
      } catch {
        continue;
      }
      if (isNoise(url)) continue;
      if (url.hostname === "github.com") url.hash = "";
      const ref = classifyUrl(url.toString().replace(/\/$/u, ""));
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      refs.push(ref);
      if (refs.length >= limit) break;
    }
  }
  return refs;
}

/**
 * Linear keys a branch name suggests, like `eng-123` in
 * `me/eng-123-fix-login`. These are only candidates: the caller keeps the
 * ones Linear confirms, so version tags like `v3-06` never show up.
 */
export function linearKeysFromBranch(branch: string | null): string[] {
  if (branch === null) return [];
  const keys = new Set<string>();
  // Letters-only team keys and no leading zero skip tags like `v3-06`.
  for (const match of branch.matchAll(/(?:^|[/_-])([a-z]{2,6})-([1-9]\d{0,5})(?=$|[/_-])/giu)) {
    const key = `${match[1]!.toUpperCase()}-${match[2]}`;
    if (LINEAR_KEY.test(key)) keys.add(key);
  }
  return [...keys];
}

/** Thread-storage files as attachments; images get a thumbnail. */
export function storageAttachments(files: readonly { name: string; path: string }[]): AttachmentRef[] {
  return files.map((file) =>
    IMAGE_EXTENSION.test(file.name)
      ? { id: `file:${file.path}`, kind: "image" as const, path: file.path, label: file.name }
      : { id: `file:${file.path}`, kind: "file" as const, path: file.path, label: file.name },
  );
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION.test(path);
}
