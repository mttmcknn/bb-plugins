// Attachment enrichment with caching and background fetches. A snapshot asks
// for details and gets whatever is cached right away; misses are fetched in
// the background, and `onReady` names the threads whose snapshot now has
// more to show. That keeps the panel fast even when Linear or a web page is
// slow.
import type { AttachmentDetail, AttachmentRef, LinearIssue, NotionPage, GithubItem, WebPreview } from "./types.ts";

export interface Fetchers {
  linear(identifier: string, apiKey: string): Promise<LinearIssue | null>;
  notion(pageId: string): Promise<NotionPage>;
  github(repo: string, number: number): Promise<GithubItem>;
  web(url: string): Promise<WebPreview | null>;
}

export interface EnrichmentOptions {
  fetchers: Fetchers;
  linearApiKey(): Promise<string>;
  linkPreviews(): Promise<boolean>;
  /** Called with the threads that asked for details that just arrived. */
  onReady(threadIds: string[]): void;
  now?: () => number;
}

export interface Enriched {
  detail: AttachmentDetail | null;
  hint: string | null;
  /** True when a fetch is queued or running for this reference. */
  pending: boolean;
}

interface Entry {
  detail: AttachmentDetail | null;
  hint: string | null;
  at: number;
  ttlMs: number;
}

const FRESH_MS = 10 * 60_000;
const FAILURE_RETRY_MS = 2 * 60_000;
const CONCURRENCY = 4;
const MAX_ENTRIES = 2_000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createEnrichment(options: EnrichmentOptions) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const waiting = new Map<string, Set<string>>();
  const queue: { ref: AttachmentRef; threadId: string }[] = [];
  let running = 0;
  let disposed = false;

  function store(id: string, entry: Entry) {
    entries.delete(id);
    entries.set(id, entry);
    // Drop the oldest entries first; Map keeps insertion order.
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  }

  async function load(ref: AttachmentRef): Promise<Omit<Entry, "at">> {
    const fresh = (detail: AttachmentDetail | null, hint: string | null = null) => ({ detail, hint, ttlMs: FRESH_MS });
    switch (ref.kind) {
      case "linear": {
        const key = await options.linearApiKey();
        if (key === "") return { detail: null, hint: "Add a Linear API key in the plugin settings to see ticket details.", ttlMs: 30_000 };
        const issue = await options.fetchers.linear(ref.identifier, key);
        return fresh(issue === null ? null : { kind: "linear", issue }, issue === null ? "Linear has no issue with this key." : null);
      }
      case "notion":
        return fresh({ kind: "notion", page: await options.fetchers.notion(ref.pageId) });
      case "github":
        return fresh({ kind: "github", item: await options.fetchers.github(ref.repo, ref.number) });
      case "web": {
        if (!(await options.linkPreviews())) return fresh(null);
        const preview = await options.fetchers.web(ref.url);
        return fresh(preview === null ? null : { kind: "web", preview });
      }
      default:
        return fresh(null);
    }
  }

  function pump() {
    while (!disposed && running < CONCURRENCY && queue.length > 0) {
      const { ref } = queue.shift()!;
      running += 1;
      load(ref)
        .then(
          (result) => store(ref.id, { ...result, at: now() }),
          (error: unknown) => store(ref.id, { detail: null, hint: errorMessage(error), at: now(), ttlMs: FAILURE_RETRY_MS }),
        )
        .finally(() => {
          running -= 1;
          const threads = waiting.get(ref.id);
          waiting.delete(ref.id);
          if (!disposed && threads !== undefined) options.onReady([...threads]);
          pump();
        });
    }
  }

  function needsFetch(ref: AttachmentRef): boolean {
    return ref.kind === "linear" || ref.kind === "notion" || ref.kind === "github" || ref.kind === "web";
  }

  return {
    /**
     * Cached details for `ref`. Queues a fetch when there are none or they
     * are stale; a stale entry keeps showing until the fetch lands.
     */
    get(ref: AttachmentRef, threadId: string): Enriched {
      if (!needsFetch(ref)) return { detail: null, hint: null, pending: false };
      const entry = entries.get(ref.id);
      const stale = entry === undefined || now() - entry.at > entry.ttlMs;
      if (stale) {
        const threads = waiting.get(ref.id);
        if (threads === undefined) {
          waiting.set(ref.id, new Set([threadId]));
          queue.push({ ref, threadId });
          pump();
        } else {
          threads.add(threadId);
        }
      }
      return { detail: entry?.detail ?? null, hint: entry?.hint ?? null, pending: waiting.has(ref.id) };
    },
    /** Forgets cached details so the next `get` fetches again. */
    invalidate(ids?: readonly string[]) {
      if (ids === undefined) entries.clear();
      else for (const id of ids) entries.delete(id);
    },
    dispose() {
      disposed = true;
      queue.length = 0;
    },
  };
}

export type Enrichment = ReturnType<typeof createEnrichment>;
