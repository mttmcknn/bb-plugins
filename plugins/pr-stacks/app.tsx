// bb-plugin-pr-stacks — frontend entry.
//
// A "PR Stacks" page groups open pull requests by repository, then by stack
// in merge order, with a link to the thread behind each PR. Inside a thread,
// the same stacks show in the right-hand panel: open it from the thread
// header button, the panel's new-tab list, or a `::pr-stacks` directive.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type {
  PullRequest,
  RepoGroup,
  Reviewer,
  rpcContract,
  Snapshot,
  Stack,
  StackRow,
  ThreadRef,
} from "./server";
import { toast } from "sonner";
import { canMarkReady } from "./core/stacks.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import "./styles.css";

const PANEL_PATH = "stacks";
const THREAD_SUBPATH = "thread/";
const THREAD_PANEL_ACTION = "thread-stacks";

function usePrSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("snapshot").then(
      (next) => {
        setSnapshot(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("snapshot-changed", refetch);
  return { rpc, snapshot, error: error ?? snapshot?.error ?? null };
}

function threadIdFromSubPath(subPath: string): string | null {
  return subPath.startsWith(THREAD_SUBPATH) ? subPath.slice(THREAD_SUBPATH.length) || null : null;
}

function matches(pr: PullRequest, needle: string): boolean {
  return (
    pr.title.toLowerCase().includes(needle) ||
    pr.headRefName.toLowerCase().includes(needle) ||
    pr.repo.toLowerCase().includes(needle) ||
    `#${pr.number}`.includes(needle)
  );
}

/** Keep whole stacks that contain a match, so their context stays visible. */
function filterGroups(
  groups: RepoGroup[],
  keep: (stack: Stack) => boolean,
): RepoGroup[] {
  return groups
    .map((group) => ({ ...group, stacks: group.stacks.filter(keep) }))
    .filter((group) => group.stacks.length > 0);
}

/** Stacks that contain at least one PR linked to `threadId`. */
function threadGroups(snapshot: Snapshot | null, threadId: string): RepoGroup[] {
  return filterGroups(snapshot?.repos ?? [], (stack) =>
    stack.rows.some((row) => row.thread?.id === threadId),
  );
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---- Small pieces ---------------------------------------------------------

type Tone = "good" | "bad" | "warn" | "muted";
const TONE_CLASS: Record<Tone, string> = {
  good: "text-success",
  bad: "text-destructive",
  warn: "text-warning",
  muted: "text-muted-foreground",
};

function Chip({
  tone,
  icon,
  small = false,
  children,
}: {
  tone: Tone;
  icon?: string;
  /** Compact status pill for a PR's status row. */
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-border",
        small ? "gap-0.5 px-1 text-[10px] leading-[14px]" : "gap-1 px-1.5 py-px text-[11px] leading-4",
        TONE_CLASS[tone],
      )}
    >
      {icon === undefined ? null : <Icon name={icon} className={small ? "size-2.5" : "size-3"} />}
      {children}
    </span>
  );
}

/** A PR's checks, review, and conflict pills on their own row; none, no row. */
function StatusChips({ pr }: { pr: PullRequest }) {
  const hasReview = pr.review === "approved" || pr.review === "changes_requested";
  if (pr.checks === "none" && !hasReview && !pr.conflicts) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {pr.checks === "failing" ? (
        <Chip small tone="bad" icon="CircleX">Checks</Chip>
      ) : pr.checks === "pending" ? (
        <Chip small tone="warn" icon="Clock">
          Checks {pr.checkProgress.total === 0 ? null : checksDone(pr)}
        </Chip>
      ) : pr.checks === "passing" ? (
        <Chip small tone="good" icon="CircleCheck">Checks</Chip>
      ) : null}
      {pr.review === "approved" ? (
        <Chip small tone="good" icon="Check">Approved</Chip>
      ) : pr.review === "changes_requested" ? (
        <Chip small tone="bad">Changes requested</Chip>
      ) : null}
      {pr.conflicts ? <Chip small tone="bad" icon="AlertTriangle">Conflicts</Chip> : null}
    </div>
  );
}

const SOURCE_LABEL: Record<ThreadRef["source"], string> = {
  manual: "Linked by hand",
  mention: "First thread to mention this PR",
  branch: "Thread working on this branch",
};

function ThreadButton({ thread, className }: { thread: ThreadRef; className?: string }) {
  const navigate = useBbNavigate();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 max-w-[14rem] shrink-0 gap-1.5 px-2 text-xs text-muted-foreground",
        className,
      )}
      aria-label={`Open thread "${thread.title}". ${SOURCE_LABEL[thread.source]}${thread.archived ? ", archived" : ""}.`}
      onClick={() => navigate.toThread(thread.id)}
    >
      <Icon name="MessageSquare" className="size-3.5" />
      <span className="truncate">{thread.title}</span>
    </Button>
  );
}

// ---- Client-local UI state ------------------------------------------------

/** A tiny store in web storage, shared by every pane in this window. */
function storedValue<T>(storage: () => Storage | undefined, key: string, fallback: T) {
  let value = fallback;
  try {
    const raw = storage()?.getItem(key);
    if (raw != null) value = JSON.parse(raw) as T;
  } catch {
    // Unreadable storage: start from the fallback.
  }
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      try {
        storage()?.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or blocked: keep the in-memory value.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The PR last opened from this plugin, so its row stays marked. */
const selectedPr = storedValue<string | null>(
  () => globalThis.sessionStorage,
  "bb-plugin-pr-stacks:selected",
  null,
);
/** Stack ids (root PR keys) the user minimized. */
const collapsedStacks = storedValue<string[]>(
  () => globalThis.localStorage,
  "bb-plugin-pr-stacks:collapsed",
  [],
);

function useStore<T>(store: { get: () => T; subscribe: (listener: () => void) => () => void }) {
  return useSyncExternalStore(store.subscribe, store.get);
}

function setCollapsed(ids: readonly string[], collapsed: boolean) {
  const next = new Set(collapsedStacks.get());
  for (const id of ids) {
    if (collapsed) next.add(id);
    else next.delete(id);
  }
  collapsedStacks.set([...next]);
}

// ---- One browser tab per stack --------------------------------------------
//
// bb mounts our toolbar control in every desktop Browser tab. Each mount
// registers its tab here, with a handle that can script the tab's page (SDK
// 0.5+; null on web and older hosts). Opening a PR from a stack reuses the
// tab pinned to that stack; the first open creates the tab and pins it once
// its toolbar reports the PR's URL.

/** The tab-scripting handle bb passes to browser toolbar controls. */
interface BrowserPage {
  evaluate(expression: string, options?: { world?: "isolated" | "main" }): Promise<unknown>;
}

interface BrowserTab {
  threadId: string;
  url: string;
  /** Null while the tab's toolbar is not mounted. */
  page: BrowserPage | null;
}

const browserTabs = new Map<string, BrowserTab>();
/** Stack id → the browser tab it opens PRs in. */
const stackTabs = storedValue<Record<string, string>>(
  () => globalThis.sessionStorage,
  "bb-plugin-pr-stacks:stack-tabs",
  {},
);
/** A stack waiting for the tab its first PR is opening in. */
let pendingPin: { stackId: string; url: string; at: number } | null = null;

const PIN_WINDOW_MS = 20_000;
const sameDocument = (url: string, prUrl: string) =>
  url === prUrl || ["/", "?", "#"].some((next) => url.startsWith(`${prUrl}${next}`));

/** Called by each toolbar mount and URL change. */
function trackBrowserTab(tabId: string, tab: BrowserTab) {
  browserTabs.set(tabId, tab);
  if (pendingPin === null || Date.now() - pendingPin.at > PIN_WINDOW_MS) return;
  if (!sameDocument(tab.url, pendingPin.url)) return;
  const pins = stackTabs.get();
  if (Object.values(pins).includes(tabId)) return;
  stackTabs.set({ ...pins, [pendingPin.stackId]: tabId });
  pendingPin = null;
}

function unpinStack(stackId: string) {
  const { [stackId]: _removed, ...rest } = stackTabs.get();
  stackTabs.set(rest);
}

/** Wait briefly for a revealed tab's toolbar to mount and hand over its page. */
async function mountedPage(tabId: string, timeoutMs = 1_500): Promise<BrowserPage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browserTabs.get(tabId)?.page;
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * Open a PR and mark it as the one being looked at. With a stack, reuse that
 * stack's browser tab; anything unexpected falls back to a new tab.
 */
function useOpenPr() {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  return async (pr: PullRequest, stackId: string | null = null) => {
    selectedPr.set(pr.key);
    const tabId = stackId === null ? undefined : stackTabs.get()[stackId];
    const tab = tabId === undefined ? undefined : browserTabs.get(tabId);
    if (stackId !== null && tabId !== undefined && tab !== undefined) {
      try {
        const { revealed } = await rpc.call("revealBrowserTab", { tabId, threadId: tab.threadId });
        const page = revealed ? (tab.page ?? (await mountedPage(tabId))) : null;
        if (page !== null) {
          // Navigate after returning, so the evaluate call is not cut off.
          await page.evaluate(
            `(setTimeout(() => location.assign(${JSON.stringify(pr.url)}), 0), true)`,
          );
          return;
        }
        if (!revealed) {
          browserTabs.delete(tabId);
          unpinStack(stackId);
        }
      } catch {
        // Fall through to a fresh tab.
      }
    }
    if (stackId !== null) pendingPin = { stackId, url: pr.url, at: Date.now() };
    if (!navigate.openUrl(pr.url)) window.open(pr.url, "_blank", "noopener");
  };
}

/**
 * In a browser tab pinned to a stack: which stack, where in it, and
 * previous/next buttons. Renders nothing in other tabs.
 */
function StackTabToolbar(props: {
  threadId: string;
  tabId: string;
  url: string;
  isCompactViewport: boolean;
  experimental_page?: BrowserPage | null;
}) {
  const { threadId, tabId, url, isCompactViewport } = props;
  const page = props.experimental_page ?? null;
  const pins = useStore(stackTabs);
  const { snapshot } = usePrSnapshot();
  const openPr = useOpenPr();
  useEffect(() => {
    trackBrowserTab(tabId, { threadId, url, page });
  }, [tabId, threadId, url, page]);
  useEffect(
    () => () => {
      const tab = browserTabs.get(tabId);
      if (tab !== undefined) browserTabs.set(tabId, { ...tab, page: null });
    },
    [tabId],
  );
  const stackId = Object.entries(pins).find(([, pinned]) => pinned === tabId)?.[0];
  const stack =
    stackId === undefined
      ? undefined
      : snapshot?.repos.flatMap((group) => group.stacks).find((candidate) => candidate.id === stackId);
  if (stack === undefined) return null;
  const index = stack.rows.findIndex((row) => sameDocument(url, row.pr.url));
  const prev = index > 0 ? stack.rows[index - 1] : undefined;
  const next = index >= 0 ? stack.rows[index + 1] : stack.rows[0];
  const name = stack.title === "" ? "PR stack" : stack.title;
  return (
    <div className="flex h-7 min-w-0 items-center gap-0.5 text-xs text-muted-foreground">
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={prev === undefined}
        aria-label={prev === undefined ? "No earlier PR in this stack" : `Previous in stack: #${prev.pr.number}`}
        onClick={() => prev && void openPr(prev.pr, stack.id)}
      >
        <Icon name="ChevronLeft" className="size-3.5" />
      </Button>
      <span className="flex min-w-0 items-center gap-1 px-0.5" aria-label={`Pinned to stack "${name}"`}>
        <Icon name="Layers" className="size-3.5 shrink-0" />
        <span className="shrink-0 tabular-nums">
          {index >= 0 ? index + 1 : "–"}/{stack.rows.length}
        </span>
        {isCompactViewport ? null : <span className="max-w-[10rem] truncate">{name}</span>}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={next === undefined}
        aria-label={next === undefined ? "No later PR in this stack" : `Next in stack: #${next.pr.number}`}
        onClick={() => next && void openPr(next.pr, stack.id)}
      >
        <Icon name="ChevronRight" className="size-3.5" />
      </Button>
    </div>
  );
}

// ---- Reviewers ------------------------------------------------------------

const REVIEWER_BADGE: Record<
  Reviewer["state"],
  { icon: string; className: string; label: string } | null
> = {
  approved: { icon: "Check", className: "bg-success", label: "approved" },
  changes_requested: { icon: "X", className: "bg-destructive", label: "requested changes" },
  commented: { icon: "MessageSquare", className: "bg-muted-foreground", label: "commented" },
  requested: null,
};
const MAX_AVATARS = 5;
const reviewerLabel = (reviewer: Reviewer) =>
  `${reviewer.login} ${REVIEWER_BADGE[reviewer.state]?.label ?? "review requested"}`;

/** Overlapping reviewer avatars, each with a small badge for their verdict. */
function Reviewers({ reviewers }: { reviewers: Reviewer[] }) {
  if (reviewers.length === 0) return null;
  return (
    <span
      className="ml-auto flex shrink-0 items-center pl-2"
      role="img"
      aria-label={`Reviewers: ${reviewers.map(reviewerLabel).join(", ")}`}
    >
      {reviewers.slice(0, MAX_AVATARS).map((reviewer, index) => {
        const badge = REVIEWER_BADGE[reviewer.state];
        return (
          <span
            key={reviewer.login}
            className={cn("relative size-5 shrink-0", index > 0 && "-ml-1")}
            title={reviewerLabel(reviewer)}
          >
            {reviewer.avatarUrl === "" ? (
              <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium uppercase ring-2 ring-card">
                {reviewer.login.slice(0, 1)}
              </span>
            ) : (
              <img
                src={reviewer.avatarUrl}
                alt=""
                loading="lazy"
                className={cn(
                  "size-5 rounded-full bg-muted ring-2 ring-card",
                  reviewer.state === "requested" && "opacity-50 grayscale",
                )}
              />
            )}
            {badge === null ? null : (
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 z-10 flex size-2.5 items-center justify-center rounded-full text-background ring-1 ring-card",
                  badge.className,
                )}
              >
                <Icon name={badge.icon} className="size-2" />
              </span>
            )}
          </span>
        );
      })}
      {reviewers.length > MAX_AVATARS ? (
        <span className="pl-1 text-[10px]">+{reviewers.length - MAX_AVATARS}</span>
      ) : null}
    </span>
  );
}

// GitHub's pull request icons and colors.
const PR_STATE = {
  open: { icon: "GitPullRequest", className: "text-success", label: "Open" },
  draft: { icon: "GitPullRequestDraft", className: "text-muted-foreground", label: "Draft" },
  merged: { icon: "GitMerge", className: "text-violet-500", label: "Merged" },
  closed: { icon: "GitPullRequestClosed", className: "text-destructive", label: "Closed" },
} as const;

function PrStateIcon({ pr, className }: { pr: PullRequest; className?: string }) {
  const state = PR_STATE[pr.state === "open" ? (pr.isDraft ? "draft" : "open") : pr.state];
  return (
    <span className={cn("inline-flex shrink-0", state.className, className)}>
      <Icon name={state.icon} className="size-4" />
      <span className="sr-only">{state.label}</span>
    </span>
  );
}

/** Take green drafts out of draft; the server re-checks eligibility. */
function ReadyButton({ prs, label }: { prs: PullRequest[]; label: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const markReady = async () => {
    setPending(true);
    try {
      const { marked, failed } = await rpc.call("markReady", { prs: prs.map((pr) => pr.url) });
      if (marked.length > 0) {
        toast.success(
          marked.length === 1
            ? `Marked ${marked[0]} ready for review`
            : `Marked ${marked.length} PRs ready for review`,
        );
      }
      for (const item of failed) toast.error(`${item.pr}: ${item.error}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 shrink-0 gap-1.5 px-2 text-xs"
      disabled={pending}
      aria-label={
        prs.length === 1
          ? `Mark #${prs[0]!.number} ready for review. Checks pass and it merges cleanly.`
          : `Mark ${prs.length} draft PRs ready for review. Their checks pass and they merge cleanly.`
      }
      onClick={() => void markReady()}
    >
      <Icon name={pending ? "Spinner" : "GitPullRequest"} className={cn("size-3.5", pending && "animate-spin")} />
      {label}
    </Button>
  );
}

// ---- Rows, stacks, repos --------------------------------------------------

function PrRow({
  row,
  stackId,
  total,
  isLast,
  selected,
  fromThread,
  compact = false,
  onUnlink,
}: {
  row: StackRow;
  /** The stack whose browser tab this PR opens in; null for a standalone PR. */
  stackId: string | null;
  /** Stack size, or null for a standalone PR. */
  total: number | null;
  isLast: boolean;
  /** The PR last opened from this plugin. */
  selected: boolean;
  /** Linked to the thread this view is about, or previewed from the bar. */
  fromThread: boolean;
  /** Narrow layout for the thread side panel and chat: no trailing column. */
  compact?: boolean;
  onUnlink: (pr: PullRequest) => void;
}) {
  const { pr, thread } = row;
  const openPr = useOpenPr();
  const inStack = total !== null;
  const ready = canMarkReady(pr);
  return (
    <li
      className={cn(
        "group relative flex items-start px-3 py-2",
        compact ? "gap-2" : "gap-3",
        selected ? "bg-state-active" : fromThread && "bg-state-hover",
      )}
      style={{ paddingLeft: `${0.75 + row.depth * (compact ? 0.75 : 1.25)}rem` }}
      aria-current={selected ? "true" : undefined}
    >
      {selected ? (
        <span aria-hidden className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-blue-500" />
      ) : null}
      {/* The rail: one state icon per PR, joined top to bottom in merge order. */}
      <div className="relative flex w-4 shrink-0 justify-center self-stretch">
        {inStack && !isLast ? (
          <span aria-hidden className="absolute bottom-[-0.5rem] top-6 w-px bg-border" />
        ) : null}
        <PrStateIcon pr={pr} className="relative mt-0.5" />
      </div>
      <div className="min-w-0 flex-1">
        <a
          href={pr.url}
          className="block min-w-0 truncate text-sm font-semibold text-foreground hover:underline"
          onClick={(event) => {
            // Leave modified clicks to the browser's own link handling.
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            void openPr(pr, stackId);
          }}
        >
          {pr.title}
        </a>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          {inStack ? (
            <>
              <span className="shrink-0" aria-label={`Step ${row.position} of ${total}`}>
                {row.position}/{total}
              </span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="shrink-0">#{pr.number}</span>
          <span aria-hidden>·</span>
          <span
            className={cn("truncate font-mono text-[11px]", compact ? "max-w-full" : "max-w-[22rem]")}
            title={pr.headRefName}
          >
            {pr.headRefName}
          </span>
          {row.branchesFrom === null ? null : (
            <Chip tone="muted" icon="GitBranch">
              on #{row.branchesFrom}
            </Chip>
          )}
          <span className="shrink-0">
            <span className="text-success">+{pr.additions}</span>{" "}
            <span className="text-destructive">−{pr.deletions}</span>
          </span>
          <span className="shrink-0">{relativeTime(pr.updatedAt)}</span>
          {compact && fromThread && thread !== null ? <Chip tone="muted">This thread</Chip> : null}
          <Reviewers reviewers={pr.reviewers} />
        </div>
        <StatusChips pr={pr} />
        {compact && !fromThread && thread !== null ? (
          <ThreadButton thread={thread} className="-ml-2 mt-0.5 max-w-full" />
        ) : null}
        {compact && ready ? (
          <div className="mt-1.5">
            <ReadyButton prs={[pr]} label="Ready for review" />
          </div>
        ) : null}
      </div>
      {compact || (thread === null && !ready) ? null : (
        <div className="flex shrink-0 items-center gap-1">
          {ready ? <ReadyButton prs={[pr]} label="Ready for review" /> : null}
          {thread === null ? null : (
            <>
              <ThreadButton thread={thread} />
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Unlink #${pr.number} from "${thread.title}"`}
                onClick={() => onUnlink(pr)}
              >
                <Icon name="X" className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** "3/7" once GitHub reports check counts. */
function checksDone(pr: PullRequest): string {
  const { finished, total } = pr.checkProgress;
  return total === 0 ? "none" : `${finished}/${total}`;
}

/** Fill for a running segment, never empty so the bar reads as started. */
function runningPercent(pr: PullRequest): number {
  const { finished, total } = pr.checkProgress;
  return total === 0 ? 8 : Math.max(8, Math.round((finished / total) * 100));
}

/** Where a PR stands on its way to merge, for the stack progress bar. */
function readiness(pr: PullRequest): Tone {
  if (pr.checks === "failing" || pr.conflicts || pr.review === "changes_requested") return "bad";
  if (pr.isDraft) return "muted";
  if (pr.review === "approved" && (pr.checks === "passing" || pr.checks === "none")) return "good";
  return "warn";
}

/** The unfilled part of a segment whose checks are still running. */
const TRACK_CLASS: Record<Tone, string> = {
  good: "bg-success/25",
  bad: "bg-destructive/25",
  warn: "bg-warning/25",
  muted: "bg-muted-foreground/15",
};

const SEGMENT_CLASS: Record<Tone, string> = {
  good: "bg-success",
  bad: "bg-destructive",
  warn: "bg-warning",
  muted: "bg-muted-foreground/30",
};

const READINESS_LABEL: Record<Tone, string> = {
  good: "Ready to merge",
  bad: "Needs attention",
  warn: "In review",
  muted: "Draft",
};

/**
 * One segment per PR in merge order. Hovering or focusing a segment previews
 * that PR; selecting it opens the PR.
 */
function StackProgress({
  stackId,
  rows,
  selectedKey,
  onPreview,
}: {
  stackId: string;
  rows: StackRow[];
  selectedKey: string | null;
  onPreview: (key: string) => void;
}) {
  const openPr = useOpenPr();
  const ready = rows.filter((row) => readiness(row.pr) === "good").length;
  return (
    <div className="flex items-center gap-2">
      <div className="pr-stacks-bar flex min-w-0 flex-1 gap-0.5">
        {rows.map((row) => {
          const tone = readiness(row.pr);
          const running = row.pr.checks === "pending";
          return (
            <button
              key={row.pr.key}
              type="button"
              className="pr-stacks-segment group/segment flex h-4 min-w-0 flex-1 cursor-pointer items-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Step ${row.position}: #${row.pr.number} ${row.pr.title}. ${READINESS_LABEL[tone]}.${
                running ? ` Checks running, ${checksDone(row.pr)} done.` : ""
              } Open on GitHub.`}
              onMouseEnter={() => onPreview(row.pr.key)}
              onFocus={() => onPreview(row.pr.key)}
              onClick={() => void openPr(row.pr, stackId)}
            >
              <span
                className={cn(
                  "pr-stacks-segment-bar relative h-1.5 w-full overflow-hidden rounded-full group-hover/segment:h-2.5 group-focus-visible/segment:h-2.5",
                  running ? TRACK_CLASS[tone] : SEGMENT_CLASS[tone],
                  row.pr.key === selectedKey && "h-2.5 ring-2 ring-blue-500 ring-offset-1 ring-offset-card",
                )}
              >
                {running ? (
                  <>
                    {/* Filled by finished checks; the sweep says "still going". */}
                    <span
                      className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700", SEGMENT_CLASS[tone])}
                      style={{ width: `${runningPercent(row.pr)}%` }}
                    />
                    <span className="pr-stacks-checks-running absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent" />
                  </>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <span className="shrink-0">
        {ready} of {rows.length} ready to merge
      </span>
    </div>
  );
}

/** What the whole stack is for, editable in place. */
function StackTitle({ stack }: { stack: Stack }) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const name = draft.trim();
    setDraft(null);
    if (name !== (stack.titleSource === "named" ? stack.title : "")) {
      void rpc.call("renameStack", { pr: stack.id, name });
    }
  };
  if (draft !== null) {
    return (
      <Input
        autoFocus
        value={draft}
        maxLength={120}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setDraft(null);
        }}
        placeholder="What does this stack accomplish? Leave empty for an automatic title."
        aria-label="Stack title"
        className="h-8 text-sm"
      />
    );
  }
  return (
    <div className="group/title flex min-w-0 items-center gap-2">
      <h3
        className={cn(
          "min-w-0 truncate text-sm font-semibold",
          stack.title === "" ? "font-normal text-muted-foreground" : "text-foreground",
        )}
      >
        {stack.title === "" ? "Untitled stack" : stack.title}
      </h3>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/title:opacity-100"
        aria-label={stack.title === "" ? "Add a stack title" : `Rename stack "${stack.title}"`}
        onClick={() => setDraft(stack.titleSource === "named" ? stack.title : "")}
      >
        <Icon name="Edit" className="size-3.5" />
      </Button>
    </div>
  );
}

function StackCard({
  stack,
  highlightThreadId,
  compact = false,
  onUnlink,
}: {
  stack: Stack;
  highlightThreadId: string | null;
  /** Narrow layout: names the repo in the header, since no repo section wraps it. */
  compact?: boolean;
  onUnlink: (pr: PullRequest) => void;
}) {
  const selectedKey = useStore(selectedPr);
  const collapsed = useStore(collapsedStacks).includes(stack.id);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const failing = stack.rows.filter((row) => row.pr.checks === "failing").length;
  const conflicts = stack.rows.filter((row) => row.pr.conflicts).length;
  const approved = stack.rows.filter((row) => row.pr.review === "approved").length;
  const count = stack.rows.length;
  const readyPrs = stack.rows.map((row) => row.pr).filter(canMarkReady);
  // A lone PR's thread title would only repeat the thread it sits in.
  const showTitle = count > 1 || stack.titleSource === "named";
  const preview = collapsed ? stack.rows.find((row) => row.pr.key === previewKey) : undefined;
  const rowProps = (row: StackRow, index: number) => ({
    row,
    stackId: stack.id,
    total: count,
    isLast: index === count - 1,
    selected: row.pr.key === selectedKey,
    fromThread:
      (highlightThreadId !== null && row.thread?.id === highlightThreadId) ||
      (!collapsed && row.pr.key === previewKey),
    compact,
    onUnlink,
  });
  return (
    // The preview stays up while the pointer or focus moves from the bar
    // down into the revealed row, and clears once it leaves the card.
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      onMouseLeave={() => setPreviewKey(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPreviewKey(null);
      }}
    >
      <header
        className={cn(
          "space-y-1.5 px-3 py-2 text-xs text-muted-foreground",
          (!collapsed || preview !== undefined) && "border-b border-border",
        )}
      >
        {compact ? (
          <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
            <Icon name="Github" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{stack.repo}</span>
          </div>
        ) : null}
        {showTitle ? (
          <div className="flex min-w-0 items-center gap-1">
            {count > 1 ? (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-1.5 size-6 shrink-0 text-muted-foreground"
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Show the PRs in this stack" : "Minimize this stack"}
                onClick={() => setCollapsed([stack.id], !collapsed)}
              >
                <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-4" />
              </Button>
            ) : null}
            <div className="min-w-0 flex-1">
              <StackTitle stack={stack} />
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name="Layers" className="size-3.5" />
          <span className="font-medium text-foreground">
            {count} {count === 1 ? "PR" : "PRs"}
          </span>
          <span>
            on <span className="font-mono text-[11px]">{stack.base}</span>
          </span>
          <span aria-hidden>·</span>
          <span>{approved} approved</span>
          {failing > 0 ? <Chip tone="bad">{failing} failing</Chip> : null}
          {conflicts > 0 ? <Chip tone="bad">{conflicts} conflicts</Chip> : null}
          {/* Rows carry their own button; minimized stacks need this one. */}
          {readyPrs.length > 1 || (collapsed && readyPrs.length === 1) ? (
            <span className="ml-auto">
              <ReadyButton
                prs={readyPrs}
                label={readyPrs.length === 1 ? "Mark 1 ready" : `Mark ${readyPrs.length} ready`}
              />
            </span>
          ) : null}
        </div>
        <StackProgress stackId={stack.id} rows={stack.rows} selectedKey={selectedKey} onPreview={setPreviewKey} />
      </header>
      {collapsed ? (
        <ul aria-live="polite" className="pr-stacks-reveal">
          {preview === undefined ? null : (
            // Keyed by PR so moving between segments replays the reveal.
            <PrRow key={preview.pr.key} {...rowProps(preview, stack.rows.indexOf(preview))} isLast />
          )}
        </ul>
      ) : (
        <ol>
          {stack.rows.map((row, index) => (
            <PrRow key={row.pr.key} {...rowProps(row, index)} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RepoSection({
  group,
  highlightThreadId,
  onUnlink,
}: {
  group: RepoGroup;
  highlightThreadId: string | null;
  onUnlink: (pr: PullRequest) => void;
}) {
  const [open, setOpen] = useState(true);
  const selectedKey = useStore(selectedPr);
  const collapsedIds = useStore(collapsedStacks);
  const stacks = group.stacks.filter((stack) => stack.rows.length > 1);
  const singles = group.stacks.filter((stack) => stack.rows.length === 1).map((s) => s.rows[0]!);
  const stackIds = stacks.map((stack) => stack.id);
  const allCollapsed = stackIds.every((id) => collapsedIds.includes(id));
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-sm font-semibold text-foreground hover:bg-state-hover"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 text-muted-foreground" />
          <Icon name="Github" className="size-4 text-muted-foreground" />
          <span className="truncate">{group.repo}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {group.prCount} open · {stacks.length} {stacks.length === 1 ? "stack" : "stacks"}
          </span>
        </button>
        {open && stacks.length > 1 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={() => setCollapsed(stackIds, !allCollapsed)}
          >
            <Icon name={allCollapsed ? "ChevronsDown" : "ChevronsUp"} className="size-3.5" />
            {allCollapsed ? "Show all stacks" : "Minimize all stacks"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="space-y-3 pl-6">
          {stacks.map((stack) => (
            <StackCard
              key={stack.id}
              stack={stack}
              highlightThreadId={highlightThreadId}
              onUnlink={onUnlink}
            />
          ))}
          {singles.length === 0 ? null : (
            <section className="overflow-hidden rounded-lg border border-border bg-card">
              <header className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                Standalone PRs
              </header>
              <ul className="divide-y divide-border">
                {singles.map((row) => (
                  <PrRow
                    key={row.pr.key}
                    row={row}
                    stackId={null}
                    total={null}
                    isLast
                    selected={row.pr.key === selectedKey}
                    fromThread={highlightThreadId !== null && row.thread?.id === highlightThreadId}
                    onUnlink={onUnlink}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border border-dashed px-4 py-6 text-center text-sm",
        tone === "error" ? "border-destructive text-destructive" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

// ---- Page -----------------------------------------------------------------

function StacksPage({ subPath }: { subPath: string }) {
  const { rpc, snapshot, error } = usePrSnapshot();
  const navigate = useBbNavigate();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const threadId = threadIdFromSubPath(subPath);

  const groups = useMemo(() => {
    if (snapshot === null) return [];
    let result = threadId === null ? snapshot.repos : threadGroups(snapshot, threadId);
    const needle = query.trim().toLowerCase();
    if (needle !== "") {
      result = filterGroups(
        result,
        (stack) =>
          stack.title.toLowerCase().includes(needle) || stack.rows.some((row) => matches(row.pr, needle)),
      );
    }
    return result;
  }, [snapshot, threadId, query]);

  const threadTitle = useMemo(() => {
    for (const group of groups)
      for (const stack of group.stacks)
        for (const row of stack.rows) if (row.thread?.id === threadId) return row.thread.title;
    return threadId;
  }, [groups, threadId]);

  const refresh = () => {
    setRefreshing(true);
    rpc.call("refresh").finally(() => setRefreshing(false));
  };
  const unlink = (pr: PullRequest) => {
    void rpc.call("unlink", { pr: pr.url });
  };
  const busy = refreshing || snapshot?.refreshing === true;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by stack, title, branch, repo, or #number"
            aria-label="Filter pull requests"
          />
          <Button variant="outline" onClick={refresh} disabled={busy}>
            <Icon name={busy ? "Spinner" : "ArrowReloadHorizontal"} className={cn("size-4", busy && "animate-spin")} />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {snapshot?.fetchedAt == null
            ? "Loading pull requests from GitHub…"
            : `${snapshot.prCount} open PRs in ${snapshot.repos.length} repos · updated ${relativeTime(snapshot.fetchedAt)}`}
          {snapshot !== null && snapshot.truncatedCount > 0
            ? ` · ${snapshot.truncatedCount} more not shown; narrow the query in settings`
            : null}
        </p>
        {threadId === null ? null : (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <Icon name="MessageSquare" className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              Stacks with PRs from <span className="font-medium">{threadTitle}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => navigate.toThread(threadId)}>
              Open thread
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
              Show all
            </Button>
          </div>
        )}
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        {snapshot?.fetchedAt == null ? null : groups.length === 0 ? (
          <Notice>
            {threadId !== null
              ? "No open PRs are linked to this thread."
              : query.trim() !== ""
                ? "No pull requests match the filter."
                : "No open pull requests."}
          </Notice>
        ) : (
          groups.map((group) => (
            <RepoSection
              key={group.repo}
              group={group}
              highlightThreadId={threadId}
              onUnlink={unlink}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---- Thread side panel and chat directive --------------------------------

/** The stacks behind one thread, laid out for a narrow column. */
function ThreadStacksList({
  snapshot,
  threadId,
  onUnlink,
}: {
  snapshot: Snapshot | null;
  threadId: string;
  onUnlink: (pr: PullRequest) => void;
}) {
  const stacks = useMemo(
    () => threadGroups(snapshot, threadId).flatMap((group) => group.stacks),
    [snapshot, threadId],
  );
  if (snapshot?.fetchedAt == null) return <Notice>Loading pull requests from GitHub…</Notice>;
  if (stacks.length === 0) {
    return (
      <Notice>
        No open PRs are linked to this thread. Agents link them with{" "}
        <code className="font-mono text-xs">bb pr-stacks link</code>.
      </Notice>
    );
  }
  return (
    <div className="space-y-3">
      {stacks.map((stack) => (
        <StackCard
          key={stack.id}
          stack={stack}
          highlightThreadId={threadId}
          compact
          onUnlink={onUnlink}
        />
      ))}
    </div>
  );
}

function ThreadStacksPanel({ threadId }: { threadId: string }) {
  const { rpc, snapshot, error } = usePrSnapshot();
  const navigate = useBbNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || snapshot?.refreshing === true;
  const refresh = () => {
    setRefreshing(true);
    rpc.call("refresh").finally(() => setRefreshing(false));
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {snapshot?.fetchedAt == null ? "Not fetched yet" : `Updated ${relativeTime(snapshot.fetchedAt)}`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => navigate.toPluginPanel(PANEL_PATH)}
        >
          All PRs
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Refresh from GitHub"
          onClick={refresh}
          disabled={busy}
        >
          <Icon name={busy ? "Spinner" : "ArrowReloadHorizontal"} className={cn("size-3.5", busy && "animate-spin")} />
        </Button>
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <ThreadStacksList
        snapshot={snapshot}
        threadId={threadId}
        onUnlink={(pr) => void rpc.call("unlink", { pr: pr.url })}
      />
    </div>
  );
}

/** Open this thread's stacks in the right-hand panel; the page is the fallback. */
function useOpenThreadStacks() {
  const navigate = useBbNavigate();
  return (threadId: string) => {
    const opened = navigate.openThreadPanel({ actionId: THREAD_PANEL_ACTION, title: "PR stacks" });
    if (!opened) navigate.toPluginPanel(PANEL_PATH, { subPath: `${THREAD_SUBPATH}${threadId}` });
  };
}

/**
 * `::pr-stacks` in an assistant message: the message's thread's stacks,
 * live, with a button to pin them in the side panel.
 */
function StacksDirective({ message }: PluginMessageDirectiveProps) {
  const { rpc, snapshot, error } = usePrSnapshot();
  const openStacks = useOpenThreadStacks();
  return (
    <div className="my-2 max-w-xl space-y-2">
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <ThreadStacksList
        snapshot={snapshot}
        threadId={message.threadId}
        onUnlink={(pr) => void rpc.call("unlink", { pr: pr.url })}
      />
      <Button variant="outline" size="sm" onClick={() => openStacks(message.threadId)}>
        <Icon name="Layers" className="size-3.5" />
        Open in side panel
      </Button>
    </div>
  );
}

// ---- Thread header and sidebar -------------------------------------------

function ThreadStacksButton({ threadId }: { threadId: string }) {
  const { snapshot } = usePrSnapshot();
  const openStacks = useOpenThreadStacks();
  const rows = useMemo(
    () =>
      threadGroups(snapshot, threadId)
        .flatMap((group) => group.stacks)
        .flatMap((stack) => stack.rows)
        .filter((row) => row.thread?.id === threadId),
    [snapshot, threadId],
  );
  if (rows.length === 0) return null;
  const blocked = rows.filter((row) => readiness(row.pr) === "bad").length;
  const label = `${rows.length} open ${rows.length === 1 ? "PR" : "PRs"} from this thread${
    blocked > 0 ? `, ${blocked} need attention` : ""
  }`;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      aria-label={`${label}. Show stacks in the side panel`}
      onClick={() => openStacks(threadId)}
    >
      <Icon
        name={blocked > 0 ? "AlertTriangle" : "GitPullRequest"}
        className={cn("size-3.5", blocked > 0 && "text-destructive")}
      />
      {rows.length}
    </Button>
  );
}

function OpenPrCount() {
  const { snapshot } = usePrSnapshot();
  if (snapshot?.fetchedAt == null) return null;
  return <span className="text-xs text-muted-foreground">{snapshot.prCount}</span>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "stacks",
    title: "PR Stacks",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: StacksPage,
    experimental_sidebarAccessory: OpenPrCount,
  });
  app.slots.experimental_threadHeaderAction({
    id: "thread-stacks",
    title: "PR stacks",
    component: ThreadStacksButton,
  });
  app.slots.threadPanelAction({
    id: THREAD_PANEL_ACTION,
    title: "PR stacks",
    icon: "GitPullRequest",
    component: ThreadStacksPanel,
  });
  app.slots.messageDirective({ id: "pr-stacks", component: StacksDirective });
  app.slots.experimental_browserToolbarAction({
    id: "stack-tab",
    title: "PR stack",
    component: StackTabToolbar,
  });
});
