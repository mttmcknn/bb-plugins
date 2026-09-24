// Pure stack-building logic: no bb, no gh, no I/O. server.ts feeds it pull
// requests and a thread lookup; app.tsx and the CLI render its output.

export type ChecksState = "passing" | "failing" | "pending" | "none";
export type ReviewState =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";

export interface PullRequest {
  /** `owner/repo#number`, lowercased. Stable identity for links. */
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Open unless the search query also asks for merged or closed PRs. */
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  checks: ChecksState;
  /** Checks that have finished, out of all checks on the head commit. */
  checkProgress: { finished: number; total: number };
  review: ReviewState;
  /** Latest review per person, then pending requests; blocking reviews first. */
  reviewers: Reviewer[];
  conflicts: boolean;
}

export type ReviewerState = "changes_requested" | "approved" | "commented" | "requested";

export interface Reviewer {
  /** User login, or team slug for a requested team. */
  login: string;
  avatarUrl: string;
  state: ReviewerState;
}

/** How a pull request was matched to a thread, strongest first. */
export type LinkSource = "manual" | "mention" | "branch";

export interface ThreadRef {
  id: string;
  title: string;
  archived: boolean;
  source: LinkSource;
}

export interface StackRow {
  pr: PullRequest;
  /** Indent level. A straight chain stays at 0; only forks indent. */
  depth: number;
  /** 1-based merge order within the stack: 1 merges first. */
  position: number;
  parentKey: string | null;
  /** Parent PR number when the parent is not the row just above (a fork). */
  branchesFrom: number | null;
  thread: ThreadRef | null;
}

/** Where a stack's title came from, strongest first. */
export type StackTitleSource = "named" | "thread" | "derived";

export interface Stack {
  /** The root pull request's key. */
  id: string;
  /** What the stack is for. Empty for a standalone PR with nothing better. */
  title: string;
  titleSource: StackTitleSource;
  repo: string;
  /** The branch the root pull request targets, usually trunk. */
  base: string;
  rows: StackRow[];
  updatedAt: string;
}

export interface RepoGroup {
  repo: string;
  prCount: number;
  /** Stacks newest-first. A stack with one row is a standalone PR. */
  stacks: Stack[];
  updatedAt: string;
}

/**
 * A draft that GitHub reports as green: every check passed and it merges
 * cleanly. Only these get a "ready for review" action.
 */
export function canMarkReady(pr: PullRequest): boolean {
  return pr.state === "open" && pr.isDraft && pr.checks === "passing" && !pr.conflicts;
}

export function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/giu;
const PR_SHORTHAND = /^([\w.-]+)\/([\w.-]+)#(\d+)$/u;

/** Every pull request URL in `text`, as keys, in order of first mention. */
export function extractPrKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(PR_URL)) {
    keys.add(prKey(`${match[1]}/${match[2]}`, Number(match[3])));
  }
  return [...keys];
}

/** Parse a PR URL or `owner/repo#123` into a key; null when neither. */
export function parsePrRef(input: string): string | null {
  const trimmed = input.trim();
  const shorthand = PR_SHORTHAND.exec(trimmed);
  if (shorthand !== null) {
    return prKey(`${shorthand[1]}/${shorthand[2]}`, Number(shorthand[3]));
  }
  const fromUrl = extractPrKeys(trimmed);
  return fromUrl.length === 1 && trimmed.startsWith("https://")
    ? fromUrl[0]!
    : null;
}

const latest = (a: string, b: string) => (a > b ? a : b);

const TITLE_TAG = /^\[([^\]]+)\]\s*/u;

/** The value most items share, if at least half of them (and two) do. */
function majority(values: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) [best, bestCount] = [value, count];
  }
  return bestCount >= 2 && bestCount * 2 >= values.length ? best : null;
}

/** Branch words without the owner prefix or hash suffix. */
function branchWords(branch: string): string[] {
  const name = branch.slice(branch.lastIndexOf("/") + 1);
  return name
    .replace(/-[0-9a-f]{4}$/u, "")
    .split(/[-_]/u)
    .filter(Boolean);
}

/**
 * A best-effort title from what most PRs in a stack share: the bracketed
 * title tag and the longest leading branch words, e.g. "shop · cart".
 */
export function deriveStackTitle(prs: readonly PullRequest[]): string {
  if (prs.length < 2) return "";
  const tag = majority(prs.map((pr) => TITLE_TAG.exec(pr.title)?.[1] ?? null));
  const words = prs.map((pr) => branchWords(pr.headRefName));
  let topic: string | null = null;
  for (let size = 1; size <= 3; size += 1) {
    const prefix = majority(
      words.map((list) => (list.length > size ? list.slice(0, size).join(" ") : null)),
    );
    if (prefix === null) break;
    topic = prefix;
  }
  if (tag !== null && topic !== null) {
    // Branches often repeat the tag ("store" + "store cart").
    const tagWords = tag.toLowerCase().replace(/[-_]/gu, " ");
    const lower = topic.toLowerCase();
    if (lower === tagWords) return tag;
    if (lower.startsWith(`${tagWords} `)) topic = topic.slice(tagWords.length + 1);
    return `${tag} · ${topic}`;
  }
  return tag ?? topic ?? "";
}

function stackTitle(
  rows: readonly StackRow[],
  nameFor: (keys: readonly string[]) => string | null,
): { title: string; titleSource: StackTitleSource } {
  const named = nameFor(rows.map((row) => row.pr.key));
  if (named !== null) return { title: named, titleSource: "named" };
  // Use the thread behind most of the stack; a lone PR uses its own thread.
  const threadTitle =
    rows.length === 1
      ? (rows[0]!.thread?.title ?? null)
      : majority(rows.map((row) => row.thread?.title ?? null));
  if (threadTitle !== null) return { title: threadTitle, titleSource: "thread" };
  return { title: deriveStackTitle(rows.map((row) => row.pr)), titleSource: "derived" };
}

/**
 * Group pull requests by repository, then into stacks. A pull request's
 * parent is the open pull request in the same repository whose head branch
 * is its base branch. Everything else is a stack root.
 */
export function buildRepoGroups(
  prs: readonly PullRequest[],
  threadFor: (pr: PullRequest) => ThreadRef | null,
  nameFor: (keys: readonly string[]) => string | null = () => null,
): RepoGroup[] {
  const byRepo = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const list = byRepo.get(pr.repo) ?? [];
    list.push(pr);
    byRepo.set(pr.repo, list);
  }

  const groups: RepoGroup[] = [];
  for (const [repo, repoPrs] of byRepo) {
    const byHead = new Map<string, PullRequest>();
    for (const pr of repoPrs) {
      if (!byHead.has(pr.headRefName)) byHead.set(pr.headRefName, pr);
    }
    const children = new Map<string, PullRequest[]>();
    const hasParent = new Set<string>();
    for (const pr of repoPrs) {
      const parent = byHead.get(pr.baseRefName);
      if (parent === undefined || parent.key === pr.key) continue;
      hasParent.add(pr.key);
      const list = children.get(parent.key) ?? [];
      list.push(pr);
      children.set(parent.key, list);
    }
    for (const list of children.values()) {
      list.sort((a, b) => a.number - b.number);
    }

    const visited = new Set<string>();
    const stacks: Stack[] = [];
    const walk = (root: PullRequest) => {
      const rows: StackRow[] = [];
      const visit = (pr: PullRequest, depth: number, parent: PullRequest | null) => {
        if (visited.has(pr.key)) return;
        visited.add(pr.key);
        const above = rows.at(-1)?.pr.key;
        rows.push({
          pr,
          depth,
          position: rows.length + 1,
          parentKey: parent?.key ?? null,
          branchesFrom: parent !== null && parent.key !== above ? parent.number : null,
          thread: threadFor(pr),
        });
        const kids = children.get(pr.key) ?? [];
        const childDepth = kids.length > 1 ? depth + 1 : depth;
        for (const kid of kids) visit(kid, childDepth, pr);
      };
      visit(root, 0, null);
      stacks.push({
        id: root.key,
        ...stackTitle(rows, nameFor),
        repo,
        base: root.baseRefName,
        rows,
        updatedAt: rows.reduce((max, row) => latest(max, row.pr.updatedAt), ""),
      });
    };
    for (const pr of repoPrs) if (!hasParent.has(pr.key)) walk(pr);
    // A base-branch cycle has no root; start one at any unvisited member.
    for (const pr of repoPrs) if (!visited.has(pr.key)) walk(pr);

    stacks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    groups.push({
      repo,
      prCount: repoPrs.length,
      stacks,
      updatedAt: stacks[0]?.updatedAt ?? "",
    });
  }
  groups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return groups;
}
