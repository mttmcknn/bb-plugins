// bb-plugin-inbox — frontend entry.
//
// Replaces the sidebar thread list with an inbox. "Recent" shows active
// threads, then pinned, then everything else by day. "Stacks" groups threads
// by the PR stack their pull requests belong to, using server.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useRpc,
  type ExperimentalSidebarFooterDisclosureProps,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, SidebarList, StacksResult } from "./server";
import {
  groupByDate,
  groupByStack,
  RUNNING_INDICATORS,
  shortAge,
  type InboxStack,
  type InboxStackPr,
} from "./core/inbox";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Host fields newer than the published SDK types; all optional for safety. */
type Thread = PluginSidebarThread & {
  href?: string;
  displayTitle?: string;
  isHidden?: boolean;
  status?: string;
  queuedWork?: string;
};

type Mode = "recent" | "stacks";

const STORAGE_PREFIX = "bb-plugin-inbox:";
const STACKS_POLL_MS = 60_000;

/** A small piece of state mirrored to localStorage (per client, like bb's own). */
function useStoredState<T>(key: string, initial: T) {
  const storageKey = STORAGE_PREFIX + key;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage full or blocked: keep the in-memory value.
      }
    },
    [storageKey],
  );
  return [value, update] as const;
}

/** Current time, ticking once a minute so day buckets and ages stay right. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useStacks(enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<StacksResult | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      rpc.call("stacks").then(
        (next) => !cancelled && setResult(next),
        (error: unknown) =>
          !cancelled &&
          setResult({
            available: false,
            error: error instanceof Error ? error.message : String(error),
            fetchedAt: null,
            stacks: [],
          }),
      );
    void load();
    const timer = setInterval(load, STACKS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, rpc]);
  return result;
}

// ---- Row ------------------------------------------------------------------

function StatusGlyph({ thread }: { thread: Thread }) {
  const label = thread.indicatorLabel ?? undefined;
  const indicator = thread.indicator;
  if (thread.hasPendingInteraction || indicator === "waiting-for-input") {
    return <span role="img" aria-label={label ?? "Needs your input"} className="size-2 rounded-full bg-amber-500" />;
  }
  if (RUNNING_INDICATORS.has(indicator) || thread.status === "active") {
    return <Icon name="Spinner" aria-label={label ?? "Working"} className="size-3.5 animate-spin text-muted-foreground" />;
  }
  if (indicator === "unread-error") {
    return <span role="img" aria-label={label ?? "Failed"} className="size-2 rounded-full bg-destructive" />;
  }
  if (indicator === "unread-success" || thread.isUnread) {
    return <span role="img" aria-label={label ?? "Unread"} className="size-2 rounded-full bg-primary" />;
  }
  if (indicator === "draft") {
    return <Icon name="Edit" aria-label={label ?? "Draft"} className="size-3.5 text-muted-foreground" />;
  }
  return null;
}

const CHECKS_CLASS: Record<InboxStackPr["checks"], string> = {
  passing: "border-success/40 text-success",
  failing: "border-destructive/40 text-destructive",
  pending: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  none: "border-border text-muted-foreground",
};

function PrChips({ prs }: { prs: readonly InboxStackPr[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {prs.map((pr) => (
        <span
          key={pr.number}
          title={`${pr.title}${pr.isDraft ? " (draft)" : ""} · checks ${pr.checks}`}
          className={cn(
            "rounded border px-1 font-mono text-[10px] leading-4",
            CHECKS_CLASS[pr.checks],
            pr.isDraft && "border-dashed",
          )}
        >
          #{pr.number}
        </span>
      ))}
    </span>
  );
}

interface MenuItem {
  label: string;
  icon: IconName;
  run: () => void;
  destructive?: boolean;
}

function RowMenu({ items, onClose, anchor }: { items: MenuItem[]; onClose: () => void; anchor: { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: anchor.x, top: anchor.y }}
      className="fixed z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
            item.destructive && "text-destructive",
          )}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          <Icon name={item.icon} className="size-3.5" />
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ThreadRow({
  thread,
  isActive,
  now,
  onNavigate,
  prs,
}: {
  thread: Thread;
  isActive: boolean;
  now: number;
  onNavigate: () => void;
  prs?: readonly InboxStackPr[];
}) {
  const actions = useSidebarThreadActions();
  const { splitProps, isAvailable: canSplit } = useSidebarThreadSplit(thread.id);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenuAt(null), []);
  const title = thread.displayTitle ?? thread.title ?? thread.titleFallback ?? "Untitled thread";

  const openMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuAt(event.type === "contextmenu" ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom + 4 });
  };

  const menuItems: MenuItem[] = [
    ...(canSplit ? [{ label: "Open in split", icon: "Columns2" as const, run: () => actions.open(thread.id, { split: true }) }] : []),
    thread.isPinned
      ? { label: "Unpin", icon: "PinOff", run: () => void actions.setPinned(thread.id, false) }
      : { label: "Pin", icon: "Pin", run: () => void actions.setPinned(thread.id, true) },
    thread.isUnread
      ? { label: "Mark as read", icon: "MailOpen", run: () => void actions.setRead(thread.id, true) }
      : { label: "Mark as unread", icon: "Mail", run: () => void actions.setRead(thread.id, false) },
    { label: "Archive", icon: "Archive", run: () => actions.archive(thread.id) },
    { label: "Delete…", icon: "Trash2", destructive: true, run: () => actions.requestDelete(thread.id) },
  ];

  return (
    <li className="group relative">
      <a
        href={thread.href ?? "#"}
        {...splitProps}
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={thread.id}
        aria-current={isActive ? "page" : undefined}
        onClick={(event) => {
          if (thread.href === undefined) {
            event.preventDefault();
            actions.open(thread.id);
          }
          onNavigate();
        }}
        onContextMenu={openMenu}
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
          isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
      >
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
          <StatusGlyph thread={thread} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate", thread.isUnread && "font-semibold")}>{title}</span>
            <span className="shrink-0 text-xs text-muted-foreground group-hover:invisible">
              {shortAge(thread.updatedAt, now)}
            </span>
          </span>
          {prs !== undefined && prs.length > 0 ? (
            <span className="mt-0.5 flex">
              <PrChips prs={prs} />
            </span>
          ) : null}
        </span>
      </a>
      <button
        type="button"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        onClick={openMenu}
        className="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon name="MoreHorizontal" className="size-3.5" />
      </button>
      {menuAt === null ? null : <RowMenu items={menuItems} anchor={menuAt} onClose={closeMenu} />}
    </li>
  );
}

// ---- Groups ---------------------------------------------------------------

function Section({
  id,
  title,
  meta,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  collapsed: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <section className="mt-2 first:mt-0">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onToggle(id)}
        className="flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta === undefined ? null : <span className="shrink-0 font-normal">{meta}</span>}
      </button>
      {collapsed ? null : <ul className="flex flex-col">{children}</ul>}
    </section>
  );
}

function stackTitle(stack: InboxStack): string {
  if (stack.title !== "") return stack.title;
  const first = stack.prs[0];
  return first === undefined ? stack.id : first.title;
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const options: { id: Mode; label: string; icon: IconName }[] = [
    { id: "recent", label: "Recent", icon: "Clock" },
    { id: "stacks", label: "Stacks", icon: "Layers" },
  ];
  return (
    <div role="radiogroup" aria-label="Group threads by" className="mb-2 flex gap-1 rounded-md bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={mode === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted-foreground",
            mode === option.id && "bg-background text-foreground shadow-sm",
          )}
        >
          <Icon name={option.icon} className="size-3.5" />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-xs text-muted-foreground">{children}</p>;
}

function InboxList({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const { status, threads } = useSidebarThreads();
  const [mode, setMode] = useStoredState<Mode>("mode", "recent");
  const [collapsedList, setCollapsedList] = useStoredState<string[]>("collapsed", []);
  const collapsed = new Set(collapsedList);
  const toggle = (id: string) =>
    setCollapsedList(collapsed.has(id) ? collapsedList.filter((item) => item !== id) : [...collapsedList, id]);
  const now = useNow();
  const stacks = useStacks(mode === "stacks");
  const all = threads as readonly Thread[];

  const row = (thread: Thread, prs?: readonly InboxStackPr[]) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      prs={prs}
      now={now}
      isActive={thread.id === activeThreadId}
      onNavigate={onNavigate}
    />
  );

  let body: ReactNode;
  if (status === "loading") {
    body = <Notice>Loading threads…</Notice>;
  } else if (status === "error") {
    body = <Notice>Could not load threads.</Notice>;
  } else if (mode === "recent") {
    const groups = groupByDate(all, now);
    body =
      groups.length === 0 ? (
        <Notice>No threads yet.</Notice>
      ) : (
        groups.map((group) => (
          <Section
            key={group.id}
            id={`date:${group.id}`}
            title={group.label}
            meta={group.threads.length}
            collapsed={collapsed.has(`date:${group.id}`)}
            onToggle={toggle}
          >
            {group.threads.map((thread) => row(thread))}
          </Section>
        ))
      );
  } else if (stacks === null) {
    body = <Notice>Loading stacks…</Notice>;
  } else {
    const grouped = groupByStack(all, stacks.stacks);
    body = (
      <>
        {!stacks.available ? (
          <Notice>
            Stacks come from the PR Stacks plugin, which is not responding. Install or enable it, then reopen this view.
          </Notice>
        ) : stacks.error !== null ? (
          <Notice>PR Stacks could not refresh: {stacks.error}</Notice>
        ) : null}
        {grouped.stacks.map((group) => {
          const id = `stack:${group.stack.id}`;
          const prCount = group.stack.prs.length;
          return (
            <Section
              key={id}
              id={id}
              title={
                <span title={`${group.stack.repo} · on ${group.stack.base}`}>
                  <Icon name={prCount > 1 ? "Layers" : "GitPullRequest"} className="mr-1 inline size-3 align-[-2px]" />
                  {stackTitle(group.stack)}
                </span>
              }
              meta={`${prCount} PR${prCount === 1 ? "" : "s"}`}
              collapsed={collapsed.has(id)}
              onToggle={toggle}
            >
              {group.rows.map(({ thread, prs }) => row(thread, prs))}
              {group.unlinkedPrCount > 0 ? (
                <li className="px-2 pb-1 pl-7 text-[11px] text-muted-foreground">
                  {group.unlinkedPrCount} PR{group.unlinkedPrCount === 1 ? "" : "s"} without a thread
                </li>
              ) : null}
            </Section>
          );
        })}
        {grouped.unstacked.length > 0 ? (
          <Section
            id="stack:none"
            title="Not in a stack"
            meta={grouped.unstacked.length}
            collapsed={collapsed.has("stack:none")}
            onToggle={toggle}
          >
            {grouped.unstacked.map((thread) => row(thread))}
          </Section>
        ) : null}
      </>
    );
  }

  return (
    <div className="px-2 pb-4 pt-1">
      <ModeToggle mode={mode} onChange={setMode} />
      {body}
    </div>
  );
}

// ---- Sidebar footer switch ---------------------------------------------------

const LIST_OPTIONS: { id: SidebarList; label: string; description: string; icon: IconName }[] = [
  { id: "bb", label: "bb", description: "Projects and sections", icon: "Folder" },
  { id: "inbox", label: "Inbox", description: "Recent and PR stacks", icon: "Mail" },
];

/**
 * Picks which list fills the sidebar. It lives in the footer so it stays
 * reachable while bb's own list is showing.
 */
function SidebarListSwitch({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [current, setCurrent] = useState<SidebarList | "other" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("sidebarList").then(
      ({ list }) => setCurrent(list),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  const choose = (list: SidebarList) => {
    if (list === current) return dismiss();
    rpc.call("setSidebarList", { list }).then(dismiss, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  return (
    <div className="p-1">
      <div role="radiogroup" aria-label="Sidebar list" className="flex gap-1 rounded-md bg-muted p-0.5">
        {LIST_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={current === option.id}
            disabled={current === null}
            title={option.description}
            onClick={() => choose(option.id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted-foreground",
              current === option.id && "bg-background text-foreground shadow-sm",
            )}
          >
            <Icon name={option.icon} className="size-3.5" />
            {option.label}
          </button>
        ))}
      </div>
      {error === null ? null : <p className="px-1 pt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "sidebar-list",
    label: "Switch sidebar list",
    icon: "Mail",
    component: SidebarListSwitch,
  });
  app.slots.experimental_threadList({
    id: "inbox",
    title: "Inbox",
    description: "Active and recent threads by day, or grouped by PR stack.",
    component: InboxList,
  });
});
