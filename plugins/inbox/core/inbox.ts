// Pure grouping logic for the inbox sidebar: no React, no bb. app.tsx feeds
// it the host's sidebar threads and the stacks from server.ts.

/** The thread fields the grouping reads. The host's sidebar thread has more. */
export interface InboxThreadFields {
  id: string;
  updatedAt: number;
  isPinned: boolean;
  isArchived: boolean;
  isHidden?: boolean;
  status?: string;
  queuedWork?: string;
  hasPendingInteraction: boolean;
  /** bb's resolved status kind; unknown values count as "none". */
  indicator?: string;
  activity: {
    workflows: number;
    backgroundAgents: number;
    backgroundCommands: number;
    planMode: number;
    goals: number;
  };
}

/** One open pull request in a stack, in merge order. */
export interface InboxStackPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  checks: "passing" | "failing" | "pending" | "none";
  review: "approved" | "changes_requested" | "review_required" | "none";
  conflicts: boolean;
  threadId: string | null;
}

export interface InboxStack {
  id: string;
  title: string;
  repo: string;
  base: string;
  prs: InboxStackPr[];
}

export interface Group<T> {
  id: string;
  label: string;
  threads: T[];
}

export interface StackGroup<T> {
  stack: InboxStack;
  /** Threads in the order their first PR merges. */
  rows: { thread: T; prs: InboxStackPr[] }[];
  /** PRs in the stack that no visible thread owns. */
  unlinkedPrCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Threads the sidebar should list at all. */
export function isListed(thread: InboxThreadFields): boolean {
  return !thread.isArchived && thread.isHidden !== true;
}

/** Indicators bb shows while an agent or its background work is running. */
export const RUNNING_INDICATORS: ReadonlySet<string> = new Set([
  "runtime",
  "workflow",
  "background-agent",
  "background-command",
  "goal",
  "working-draft",
]);

/** The agent is working, queued, or waiting on the user. */
export function isActive(thread: InboxThreadFields): boolean {
  const { activity } = thread;
  return (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    RUNNING_INDICATORS.has(thread.indicator ?? "none") ||
    thread.status === "active" ||
    thread.queuedWork === "waiting" ||
    activity.workflows +
      activity.backgroundAgents +
      activity.backgroundCommands +
      activity.goals >
      0
  );
}

const newestFirst = <T extends InboxThreadFields>(a: T, b: T) =>
  b.updatedAt - a.updatedAt;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Stable bucket id and label for a timestamp, relative to `now`. */
export function dateBucket(ms: number, now: number): { id: string; label: string } {
  const today = startOfDay(now);
  if (ms >= today) return { id: "today", label: "Today" };
  // DST shifts a calendar day by an hour; compare against local midnights.
  const yesterday = startOfDay(today - DAY_MS / 2);
  if (ms >= yesterday) return { id: "yesterday", label: "Yesterday" };
  if (ms >= startOfDay(today - 6 * DAY_MS)) return { id: "week", label: "Previous 7 days" };
  if (ms >= startOfDay(today - 29 * DAY_MS)) return { id: "month", label: "Previous 30 days" };
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return {
    id: `${date.getFullYear()}-${date.getMonth()}`,
    label: date.toLocaleDateString(undefined, {
      month: "long",
      ...(sameYear ? {} : { year: "numeric" }),
    }),
  };
}

/**
 * Active threads first, then pinned, then everything else in day buckets,
 * newest first. Empty groups are dropped.
 */
export function groupByDate<T extends InboxThreadFields>(
  threads: readonly T[],
  now: number,
): Group<T>[] {
  const listed = threads.filter(isListed).sort(newestFirst);
  const active = listed.filter(isActive);
  const pinned = listed.filter((thread) => thread.isPinned && !isActive(thread));
  const groups: Group<T>[] = [
    { id: "active", label: "Active", threads: active },
    { id: "pinned", label: "Pinned", threads: pinned },
  ];
  const byBucket = new Map<string, Group<T>>();
  for (const thread of listed) {
    if (isActive(thread) || thread.isPinned) continue;
    const { id, label } = dateBucket(thread.updatedAt, now);
    let group = byBucket.get(id);
    if (group === undefined) {
      group = { id, label, threads: [] };
      byBucket.set(id, group);
      groups.push(group);
    }
    group.threads.push(thread);
  }
  return groups.filter((group) => group.threads.length > 0);
}

/**
 * Stacks that contain at least one listed thread, most recently touched
 * first, plus every listed thread that belongs to no stack.
 */
export function groupByStack<T extends InboxThreadFields>(
  threads: readonly T[],
  stacks: readonly InboxStack[],
): { stacks: StackGroup<T>[]; unstacked: T[] } {
  const listed = new Map(
    threads.filter(isListed).map((thread) => [thread.id, thread] as const),
  );
  const stacked = new Set<string>();
  const groups: (StackGroup<T> & { latest: number })[] = [];
  for (const stack of stacks) {
    const rows = new Map<string, { thread: T; prs: InboxStackPr[] }>();
    let unlinkedPrCount = 0;
    for (const pr of stack.prs) {
      const thread = pr.threadId === null ? undefined : listed.get(pr.threadId);
      if (thread === undefined) {
        unlinkedPrCount += 1;
        continue;
      }
      const row = rows.get(thread.id) ?? { thread, prs: [] };
      row.prs.push(pr);
      rows.set(thread.id, row);
    }
    if (rows.size === 0) continue;
    for (const id of rows.keys()) stacked.add(id);
    const ordered = [...rows.values()];
    groups.push({
      stack,
      rows: ordered,
      unlinkedPrCount,
      latest: Math.max(...ordered.map((row) => row.thread.updatedAt)),
    });
  }
  groups.sort((a, b) => b.latest - a.latest);
  return {
    stacks: groups.map(({ latest: _latest, ...group }) => group),
    unstacked: [...listed.values()]
      .filter((thread) => !stacked.has(thread.id))
      .sort(newestFirst),
  };
}

/** Compact age for a row: "now", "5m", "3h", "2d", "Aug 4". */
export function shortAge(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
