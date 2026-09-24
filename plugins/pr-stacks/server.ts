// bb-plugin-pr-stacks — backend entry.
//
// Fetches your open pull requests with the GitHub CLI, groups them by
// repository and stack, and matches each one to the bb thread that created
// it. The snapshot lives in memory; links between PRs and threads live in
// bb.storage.kv so they survive restarts.
import {
  defineRpcContract,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { fetchPullRequests, markReadyForReview } from "./core/github.ts";
import {
  buildRepoGroups,
  canMarkReady,
  extractPrKeys,
  parsePrRef,
  type LinkSource,
  type PullRequest,
  type RepoGroup,
  type ThreadRef,
} from "./core/stacks.ts";

export type * from "./core/stacks.ts";

export interface Snapshot {
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
  prCount: number;
  /** Open PRs GitHub reported beyond the ones fetched. */
  truncatedCount: number;
  repos: RepoGroup[];
}

const STACK_NAME_MAX = 120;

// The snapshot is server-built and trusted, so its output schema is a
// passthrough; inputs are what the boundary must check.
const snapshotSchema = z.custom<Snapshot>(
  (value) => typeof value === "object" && value !== null,
);

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  refresh: { input: z.null(), output: snapshotSchema },
  unlink: {
    input: z.object({ pr: z.string().min(1).max(300) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  markReady: {
    input: z.object({ prs: z.array(z.string().min(1).max(300)).min(1).max(50) }).strict(),
    output: z.object({
      marked: z.array(z.string()),
      failed: z.array(z.object({ pr: z.string(), error: z.string() })),
    }),
  },
  revealBrowserTab: {
    input: z.object({ tabId: z.string().min(1).max(200), threadId: z.string().min(1).max(200) }).strict(),
    output: z.object({ revealed: z.boolean() }),
  },
  renameStack: {
    input: z.object({ pr: z.string().min(1).max(300), name: z.string().max(STACK_NAME_MAX) }).strict(),
    output: z.object({ name: z.string().nullable() }),
  },
});

export const SNAPSHOT_CHANGED = "snapshot-changed";

/** `dismissed` blocks automatic matching after the user unlinks a PR. */
type StoredLink =
  | { threadId: string; source: Exclude<LinkSource, "branch">; linkedAt: string }
  | { threadId: null; source: "dismissed"; linkedAt: string };
type Links = Record<string, StoredLink>;

/** Stack names are stored per member PR, so a name outlives its root merging. */
type Names = Record<string, { name: string; namedAt: string }>;

interface ThreadInfo {
  id: string;
  title: string;
  archived: boolean;
  createdAt: number;
  branch: string | null;
}

/** Retry a PR that no thread mentions at most this often. */
const SEARCH_MISS_TTL_MS = 15 * 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    query: {
      type: "string",
      label: "GitHub search query",
      description:
        "Which pull requests to show. Uses GitHub search syntax, for example adding `org:acme`.",
      default: "is:pr is:open author:@me archived:false",
      experimental_schema: z.string().min(1).max(500),
    },
    refreshMinutes: {
      type: "number",
      label: "Refresh every (minutes)",
      default: 5,
      experimental_schema: z.number().int().min(1).max(120),
    },
    ghPath: {
      type: "string",
      label: "gh path",
      description: "Leave empty to find the GitHub CLI automatically.",
      default: "",
    },
  });

  // ---- Links: PR key → thread -------------------------------------------

  const readLinks = async () => (await bb.storage.kv.get<Links>("links")) ?? {};
  const writeLinks = (links: Links) => bb.storage.kv.set("links", links);

  async function setLink(key: string, threadId: string, source: "manual" | "mention") {
    const links = await readLinks();
    const existing = links[key];
    // An automatic match never replaces an existing link.
    if (source !== "manual" && existing !== undefined) return false;
    if (existing?.threadId === threadId && existing.source === source) return false;
    links[key] = { threadId, source, linkedAt: new Date().toISOString() };
    await writeLinks(links);
    return true;
  }

  // ---- Stack names: PR key → name --------------------------------------

  const readNames = async () => (await bb.storage.kv.get<Names>("names")) ?? {};

  /** Name the stack containing `key`, or clear it when `name` is blank. */
  async function nameStack(key: string, name: string): Promise<string | null> {
    const stack = snapshot.repos
      .flatMap((group) => group.stacks)
      .find((candidate) => candidate.rows.some((row) => row.pr.key === key));
    const members = stack?.rows.map((row) => row.pr.key) ?? [key];
    const names = await readNames();
    const trimmed = name.trim().slice(0, STACK_NAME_MAX);
    const namedAt = new Date().toISOString();
    for (const member of members) {
      if (trimmed === "") delete names[member];
      else names[member] = { name: trimmed, namedAt };
    }
    await bb.storage.kv.set("names", names);
    await regroup();
    return trimmed === "" ? null : trimmed;
  }

  /** The most recently set name among a stack's members. */
  function nameLookup(names: Names) {
    return (keys: readonly string[]) => {
      let best: Names[string] | undefined;
      for (const key of keys) {
        const entry = names[key];
        if (entry !== undefined && (best === undefined || entry.namedAt > best.namedAt)) best = entry;
      }
      return best?.name ?? null;
    };
  }

  // ---- Threads ----------------------------------------------------------

  async function listThreads(): Promise<Map<string, ThreadInfo>> {
    const threads = new Map<string, ThreadInfo>();
    for (const archived of [false, true]) {
      for (let offset = 0; offset < 5_000; offset += 500) {
        const page = await bb.sdk.threads.list({ archived, limit: 500, offset });
        for (const thread of page) {
          threads.set(thread.id, {
            id: thread.id,
            title: thread.title ?? thread.titleFallback ?? "Untitled thread",
            archived: thread.archivedAt !== null,
            createdAt: thread.createdAt,
            branch: thread.environmentBranchName,
          });
        }
        if (page.length < 500) break;
      }
    }
    return threads;
  }

  const searchMisses = new Map<string, number>();

  /** The earliest thread whose messages contain `needle`, or null. */
  async function searchEarliest(needle: string): Promise<string | null> {
    const result = await bb.sdk.threads.search({ query: needle, limitPerGroup: "50" });
    const lower = needle.toLowerCase();
    const hits = [...result.active.results, ...result.archived.results].filter(
      (hit) =>
        hit.thread.visibility === "visible" &&
        hit.matches.some((match) => match.text.toLowerCase().includes(lower)),
    );
    hits.sort((a, b) => a.thread.createdAt - b.thread.createdAt);
    return hits[0]?.thread.id ?? null;
  }

  /**
   * Match unlinked PRs to the thread that first mentioned them: by URL, then
   * by head branch name (agent and Graphite flows name the branch up front).
   * Found matches are saved as links so they stay stable.
   */
  async function discoverMentions(prs: PullRequest[], links: Links, byBranch: Set<string>) {
    const now = Date.now();
    const pending = prs.filter(
      (pr) =>
        links[pr.key] === undefined &&
        !byBranch.has(pr.headRefName) &&
        (searchMisses.get(pr.key) ?? 0) < now,
    );
    let found = 0;
    for (const pr of pending) {
      try {
        const threadId =
          (await searchEarliest(pr.url)) ?? (await searchEarliest(pr.headRefName));
        if (threadId === null) {
          searchMisses.set(pr.key, now + SEARCH_MISS_TTL_MS);
        } else if (await setLink(pr.key, threadId, "mention")) {
          found += 1;
        }
      } catch (error) {
        bb.log.warn(`thread search failed for ${pr.key}: ${(error as Error).message}`);
      }
    }
    return found;
  }

  async function resolveThreads(prs: PullRequest[]) {
    const threads = await listThreads();
    // A branch shared by several threads belongs to the one that started it.
    const byBranch = new Map<string, ThreadInfo>();
    for (const thread of [...threads.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (thread.branch !== null && !byBranch.has(thread.branch)) {
        byBranch.set(thread.branch, thread);
      }
    }
    const branchNames = new Set(
      prs.map((pr) => pr.headRefName).filter((name) => byBranch.has(name)),
    );
    if ((await discoverMentions(prs, await readLinks(), branchNames)) > 0) {
      bb.log.info("linked PRs to threads that mention them");
    }
    const links = await readLinks();

    return (pr: PullRequest): ThreadRef | null => {
      const link = links[pr.key];
      if (link?.source === "dismissed") return null;
      const linked = link === undefined ? undefined : threads.get(link.threadId);
      if (link !== undefined && linked !== undefined) {
        return { id: linked.id, title: linked.title, archived: linked.archived, source: link.source };
      }
      const branchThread = byBranch.get(pr.headRefName);
      if (branchThread !== undefined) {
        return {
          id: branchThread.id,
          title: branchThread.title,
          archived: branchThread.archived,
          source: "branch",
        };
      }
      return null;
    };
  }

  // ---- Snapshot ---------------------------------------------------------

  let snapshot: Snapshot = {
    fetchedAt: null,
    refreshing: false,
    error: null,
    prCount: 0,
    truncatedCount: 0,
    repos: [],
  };
  let prs: PullRequest[] = [];
  let inFlight: Promise<Snapshot> | null = null;
  let disposed = false;
  const lifetime = new AbortController();

  const publish = (next: Snapshot) => {
    snapshot = next;
    if (!disposed) bb.realtime.publish(SNAPSHOT_CHANGED, { prCount: next.prCount });
  };

  async function groupsFor(list: PullRequest[]) {
    const threadFor = await resolveThreads(list);
    return buildRepoGroups(list, threadFor, nameLookup(await readNames()));
  }

  /** Rebuild from the PRs already fetched, e.g. after a link or name changes. */
  async function regroup() {
    publish({ ...snapshot, repos: await groupsFor(prs) });
  }

  function refresh(): Promise<Snapshot> {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      publish({ ...snapshot, refreshing: true });
      try {
        const { query, ghPath } = await settings.get();
        const result = await fetchPullRequests({ query, ghPath, signal: lifetime.signal });
        prs = result.prs;
        const repos = await groupsFor(prs);
        publish({
          fetchedAt: new Date().toISOString(),
          refreshing: false,
          error: null,
          prCount: prs.length,
          truncatedCount: Math.max(0, result.total - prs.length),
          repos,
        });
      } catch (error) {
        bb.log.warn(`refresh failed: ${(error as Error).message}`);
        publish({ ...snapshot, refreshing: false, error: (error as Error).message });
      } finally {
        inFlight = null;
      }
      return snapshot;
    })();
    return inFlight;
  }

  bb.background.service("refresh", {
    async start(signal) {
      while (!signal.aborted) {
        await refresh();
        const { refreshMinutes } = await settings.get();
        await sleep(refreshMinutes * 60_000, signal);
      }
    },
  });

  settings.onChange((next, prev) => {
    if (next.query !== prev.query || next.ghPath !== prev.ghPath) void refresh();
  });

  // A thread that just finished a turn and printed a PR URL most likely
  // created that PR: link it before any later thread mentions it.
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (lastAssistantText === null || thread.visibility !== "visible") return;
    let linked = 0;
    for (const key of extractPrKeys(lastAssistantText)) {
      if (await setLink(key, thread.id, "mention")) linked += 1;
    }
    if (linked > 0) void refresh();
  });

  bb.onDispose(() => {
    disposed = true;
    lifetime.abort();
  });

  // ---- RPC --------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    snapshot: () => {
      if (snapshot.fetchedAt === null && inFlight === null) void refresh();
      return snapshot;
    },
    refresh: () => refresh(),
    unlink: async ({ pr }) => ({ removed: await unlink(pr) }),
    markReady: async ({ prs: refs }) => markReady(refs),
    revealBrowserTab: async ({ tabId, threadId }) => ({ revealed: await revealBrowserTab(tabId, threadId) }),
    renameStack: async ({ pr, name }) => {
      const key = parsePrRef(pr);
      if (key === null) throw new Error(`Not a pull request: ${pr}`);
      return { name: await nameStack(key, name) };
    },
  });

  /**
   * Mark drafts ready for review. Eligibility is re-checked against the
   * latest fetch, so a stale page cannot un-draft a PR whose checks failed.
   */
  async function markReady(refs: readonly string[]) {
    const { ghPath } = await settings.get();
    const marked: string[] = [];
    const failed: { pr: string; error: string }[] = [];
    for (const ref of refs) {
      const key = parsePrRef(ref);
      const pr = prs.find((candidate) => candidate.key === key);
      if (pr === undefined) {
        failed.push({ pr: ref, error: "Not one of your open PRs. Refresh and try again." });
      } else if (!canMarkReady(pr)) {
        failed.push({ pr: ref, error: "Not a draft with passing checks and no conflicts." });
      } else {
        try {
          await markReadyForReview({ url: pr.url, ghPath });
          pr.isDraft = false;
          marked.push(pr.key);
        } catch (error) {
          failed.push({ pr: pr.key, error: (error as Error).message });
        }
      }
    }
    if (marked.length > 0) {
      await regroup();
      void refresh();
    }
    return { marked, failed };
  }

  /**
   * Bring a desktop browser tab to the front. The frontend knows the tab and
   * its thread but not which window holds it, so try each window on this
   * machine. False when the tab no longer exists.
   */
  async function revealBrowserTab(tabId: string, threadId: string) {
    const { primaryHostId: hostId } = await bb.sdk.system.config();
    if (hostId === null) return false;
    const browsers = bb.sdk.experimental_desktopBrowsers;
    const { instances } = await browsers.listInstances({ hostId });
    for (const { instanceId, generation } of instances) {
      try {
        await browsers.revealTab({ hostId, instanceId, generation, threadId, tabId });
        return true;
      } catch {
        // Not in this window; try the next one.
      }
    }
    return false;
  }

  async function unlink(ref: string) {
    const key = parsePrRef(ref);
    if (key === null) throw new Error(`Not a pull request: ${ref}`);
    const links = await readLinks();
    const hadThread = snapshot.repos.some((group) =>
      group.stacks.some((stack) =>
        stack.rows.some((row) => row.pr.key === key && row.thread !== null),
      ),
    );
    links[key] = { threadId: null, source: "dismissed", linkedAt: new Date().toISOString() };
    await writeLinks(links);
    await regroup();
    return hadThread;
  }

  // ---- CLI --------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb pr-stacks list [--repo <owner/repo>] [--json]",
    "  bb pr-stacks thread [<thread-id>] [--json]",
    "  bb pr-stacks link <pr-url | owner/repo#number>... [--thread <thread-id>]",
    "  bb pr-stacks unlink <pr-url | owner/repo#number>",
    "  bb pr-stacks name <pr-url | owner/repo#number> <title...>   (--clear to remove)",
    "  bb pr-stacks ready <pr-url | owner/repo#number>...   (drafts with passing checks only)",
    "  bb pr-stacks refresh",
  ].join("\n");

  const badges = (pr: PullRequest) =>
    [
      pr.isDraft ? "draft" : null,
      pr.checks === "failing" ? "checks failing" : pr.checks === "pending" ? "checks pending" : null,
      pr.review === "approved" ? "approved" : pr.review === "changes_requested" ? "changes requested" : null,
      pr.conflicts ? "conflicts" : null,
    ].filter((badge) => badge !== null);

  function formatGroups(groups: RepoGroup[]): string {
    const lines: string[] = [];
    for (const group of groups) {
      lines.push(`${group.repo}  (${group.prCount} open)`);
      for (const stack of group.stacks) {
        if (stack.rows.length > 1) {
          const title = stack.title === "" ? "" : `${stack.title}  `;
          const hint = stack.titleSource === "derived" && stack.title !== "" ? "(suggested) " : "";
          lines.push(`  ${title}${hint}· stack on ${stack.base} · ${stack.rows.length} PRs · ${stack.id}`);
        }
        for (const row of stack.rows) {
          const indent = stack.rows.length > 1 ? "    " + "  ".repeat(row.depth) : "  ";
          const order = stack.rows.length > 1 ? `${row.position}. ` : "";
          const flags = badges(row.pr);
          const fork = row.branchesFrom === null ? "" : ` (on #${row.branchesFrom})`;
          const thread = row.thread === null ? "" : `  → ${row.thread.id} "${row.thread.title}"`;
          lines.push(
            `${indent}${order}#${row.pr.number}${fork} ${row.pr.title}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${thread}`,
          );
        }
      }
    }
    return lines.length === 0 ? "No open pull requests." : lines.join("\n");
  }

  /** Keep stdout under the CLI ceiling, cutting at a line boundary. */
  function bounded(text: string): string {
    const limit = PLUGIN_CLI_OUTPUT_MAX_BYTES - 200;
    if (Buffer.byteLength(text) <= limit) return text;
    let cut = text.slice(0, limit);
    cut = cut.slice(0, cut.lastIndexOf("\n"));
    return `${cut}\n… output truncated; filter with --repo.`;
  }

  const current = async () => (snapshot.fetchedAt === null ? refresh() : snapshot);

  function stacksForThread(threadId: string) {
    return snapshot.repos
      .map((group) => ({
        ...group,
        stacks: group.stacks.filter((stack) =>
          stack.rows.some((row) => row.thread?.id === threadId),
        ),
      }))
      .filter((group) => group.stacks.length > 0);
  }

  function takeFlag(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const [, value] = args.splice(index, 2);
    return value;
  }

  bb.cli.register({
    name: "pr-stacks",
    summary: "Browse open pull requests by repo and stack, and link them to threads",
    commands: [
      {
        name: "list",
        summary: "Show open PRs grouped by repo and stack, with their threads",
        usage: "bb pr-stacks list [--repo <owner/repo>] [--json]",
      },
      {
        name: "thread",
        summary: "Show the stacks that contain a thread's PRs (default: this thread)",
        usage: "bb pr-stacks thread [<thread-id>] [--json]",
      },
      {
        name: "link",
        summary: "Link PRs to a thread (default: this thread)",
        usage: "bb pr-stacks link <pr-url | owner/repo#number>... [--thread <thread-id>]",
      },
      {
        name: "unlink",
        summary: "Remove a PR's thread link",
        usage: "bb pr-stacks unlink <pr-url | owner/repo#number>",
      },
      {
        name: "ready",
        summary: "Mark draft PRs ready for review, only if checks pass and they merge cleanly",
        usage: "bb pr-stacks ready <pr-url | owner/repo#number>...",
      },
      {
        name: "name",
        summary: "Title the stack that contains a PR with what the whole stack does",
        usage: "bb pr-stacks name <pr-url | owner/repo#number> <title...> | --clear",
      },
      { name: "refresh", summary: "Fetch PRs from GitHub now", usage: "bb pr-stacks refresh" },
    ],
    async run(argv, ctx) {
      const args = argv.filter((arg) => arg !== "--json");
      const json = args.length !== argv.length;
      const command = args.shift();
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: bounded(json ? JSON.stringify(value) : text),
      });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const repo = takeFlag(args, "--repo")?.toLowerCase();
          if (args.length > 0) break;
          const snap = await current();
          if (snap.error !== null && snap.fetchedAt === null) return fail(snap.error);
          const groups =
            repo === undefined ? snap.repos : snap.repos.filter((g) => g.repo.toLowerCase() === repo);
          return reply({ ...snap, repos: groups }, formatGroups(groups));
        }
        case "thread": {
          const threadId = args[0] ?? ctx.threadId;
          if (threadId === undefined || args.length > 1) break;
          await current();
          const groups = stacksForThread(threadId);
          return reply(
            groups,
            groups.length === 0 ? `No open PRs are linked to ${threadId}.` : formatGroups(groups),
          );
        }
        case "link": {
          const threadId = takeFlag(args, "--thread") ?? ctx.threadId;
          if (threadId === undefined) {
            return fail("No thread to link to. Run this from a bb thread or pass --thread <thread-id>.");
          }
          if (args.length === 0) break;
          const keys = args.map((arg) => [arg, parsePrRef(arg)] as const);
          const invalid = keys.filter(([, key]) => key === null).map(([arg]) => arg);
          if (invalid.length > 0) {
            return fail(`Not a pull request URL or owner/repo#number: ${invalid.join(", ")}`);
          }
          try {
            await bb.sdk.threads.get({ threadId });
          } catch {
            return fail(`No thread with id ${threadId}.`);
          }
          for (const [, key] of keys) await setLink(key!, threadId, "manual");
          await regroup();
          const linkedKeys = keys.map(([, key]) => key!);
          return reply(
            { threadId, linked: linkedKeys },
            `Linked ${linkedKeys.join(", ")} to ${threadId}.`,
          );
        }
        case "unlink": {
          if (args.length !== 1) break;
          try {
            const removed = await unlink(args[0]!);
            return reply({ removed }, removed ? `Unlinked ${args[0]}.` : `${args[0]} had no link.`);
          } catch (error) {
            return fail((error as Error).message);
          }
        }
        case "name": {
          const clear = args.includes("--clear");
          const [ref, ...words] = args.filter((arg) => arg !== "--clear");
          const title = words.join(" ").trim();
          if (ref === undefined || (clear ? title !== "" : title === "")) break;
          const key = parsePrRef(ref);
          if (key === null) return fail(`Not a pull request URL or owner/repo#number: ${ref}`);
          await current();
          const name = await nameStack(key, clear ? "" : title);
          return reply({ pr: key, name }, name === null ? `Cleared the name for ${key}'s stack.` : `Named ${key}'s stack "${name}".`);
        }
        case "ready": {
          if (args.length === 0) break;
          await current();
          const result = await markReady(args);
          const lines = [
            ...result.marked.map((key) => `Marked ${key} ready for review.`),
            ...result.failed.map((item) => `Skipped ${item.pr}: ${item.error}`),
          ];
          return { ...reply(result, lines.join("\n")), exitCode: result.failed.length > 0 ? 1 : 0 };
        }
        case "refresh": {
          if (args.length > 0) break;
          const snap = await refresh();
          if (snap.error !== null) return fail(snap.error);
          return reply(
            { prCount: snap.prCount, fetchedAt: snap.fetchedAt },
            `Fetched ${snap.prCount} open PRs across ${snap.repos.length} repos.`,
          );
        }
      }
      return fail(usage);
    },
  });
}
