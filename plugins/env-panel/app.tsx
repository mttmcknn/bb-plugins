// bb-plugin-env-panel — frontend entry.
//
// A thread-header button shows the branch's diff stat and toggles a floating
// Environment panel (an app overlay) for the thread in view. A second overlay
// portals the stack and attachments into BB's own Thread
// info tab. All three read one per-thread snapshot store, so nothing fetches
// twice.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_FileLink as FileLink,
  Markdown,
  UrlLink,
  useBbContext,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon";
import type { rpcContract, Snapshot } from "./server";
import { cn } from "@/lib/utils";
import { DiffStat, Icon, PanelBody, PanelFrame, ThreadInfoExtras, type AgentAction, type PanelActions } from "./views/panel";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const THREAD_CHANGED = "thread-changed";
const POLL_MS = 30_000;
const HEADER_STALE_MS = 60_000;

// ---- Snapshot store: one entry per thread ------------------------------

interface Entry {
  snapshot: Snapshot | null;
  error: string | null;
  loading: boolean;
  loadedAt: number;
}

const EMPTY: Entry = { snapshot: null, error: null, loading: false, loadedAt: 0 };
const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function setEntry(threadId: string, patch: Partial<Entry>) {
  entries.set(threadId, { ...(entries.get(threadId) ?? EMPTY), ...patch });
  for (const listener of listeners) listener();
}

function load(rpc: Rpc, threadId: string, force = false): Promise<void> {
  const running = inFlight.get(threadId);
  if (running !== undefined) return running;
  setEntry(threadId, { loading: true });
  const request = rpc
    .call("snapshot", { threadId, force })
    .then(
      (snapshot) => setEntry(threadId, { snapshot, error: null, loading: false, loadedAt: Date.now() }),
      (error: unknown) =>
        setEntry(threadId, { error: error instanceof Error ? error.message : String(error), loading: false, loadedAt: Date.now() }),
    )
    .finally(() => inFlight.delete(threadId));
  inFlight.set(threadId, request);
  return request;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useSnapshot(threadId: string, options: { poll: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const entry = useSyncExternalStore(subscribe, () => entries.get(threadId) ?? EMPTY);
  const refresh = useCallback((force = false) => load(rpc, threadId, force), [rpc, threadId]);

  useEffect(() => {
    if (Date.now() - (entries.get(threadId)?.loadedAt ?? 0) > (options.poll ? 0 : HEADER_STALE_MS)) void refresh();
    if (!options.poll) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, threadId, options.poll]);

  useRealtime(THREAD_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) void refresh();
  });

  return { ...entry, rpc, refresh };
}

// ---- Panel open state and position (per app window, remembered) --------

const OPEN_KEY = "bb-env-panel:open";
const POSITION_KEY = "bb-env-panel:position";

interface Position {
  right: number;
  top: number;
}

let panelOpen = localStorage.getItem(OPEN_KEY) === "true";
const openListeners = new Set<() => void>();

function setPanelOpen(next: boolean) {
  panelOpen = next;
  localStorage.setItem(OPEN_KEY, String(next));
  for (const listener of openListeners) listener();
}

function usePanelOpen() {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    () => panelOpen,
  );
}

function readPosition(): Position {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null") as Partial<Position> | null;
    if (typeof parsed?.right === "number" && typeof parsed.top === "number") return { right: parsed.right, top: parsed.top };
  } catch {
    // Fall through to the default.
  }
  return { right: 16, top: 56 };
}

function clampPosition(position: Position, width: number): Position {
  return {
    right: Math.min(Math.max(8, position.right), Math.max(8, window.innerWidth - width - 8)),
    top: Math.min(Math.max(8, position.top), Math.max(8, window.innerHeight - 120)),
  };
}

// ---- Header button -----------------------------------------------------

function HeaderButton({ threadId, isCompactViewport }: { threadId: string; isCompactViewport: boolean }) {
  const open = usePanelOpen();
  const { snapshot } = useSnapshot(threadId, { poll: false });
  const changes = snapshot?.changes.ok ? snapshot.changes.value : null;
  const insertions = (changes?.uncommitted.insertions ?? 0) + (changes?.branch?.insertions ?? 0);
  const deletions = (changes?.uncommitted.deletions ?? 0) + (changes?.branch?.deletions ?? 0);
  const showStat = !isCompactViewport && insertions + deletions > 0;
  return (
    <button
      type="button"
      aria-label="Environment panel"
      aria-pressed={open}
      title="Environment panel"
      onClick={() => setPanelOpen(!open)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
        open && "bg-accent text-foreground",
      )}
    >
      <Icon icon={GitBranchIcon} />
      {showStat ? <DiffStat insertions={insertions} deletions={deletions} /> : null}
    </button>
  );
}

// ---- Actions shared by the floating panel and Thread info ------------------

type ThumbnailSource = { kind: "url"; url: string } | { kind: "file"; path: string };

/** Data URLs by thread and source, shared by every mounted thumbnail. */
const thumbnailCache = new Map<string, Promise<string | null>>();

function Thumbnail({
  rpc,
  threadId,
  source,
  alt,
  className,
  fallback,
}: {
  rpc: Rpc;
  threadId: string;
  source: ThumbnailSource;
  alt: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const key = `${threadId}|${source.kind === "url" ? source.url : source.path}`;
  const [dataUrl, setDataUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let request = thumbnailCache.get(key);
    if (request === undefined) {
      request = rpc.call("thumbnail", { threadId, source }).then(
        (result) => result.dataUrl,
        () => null,
      );
      thumbnailCache.set(key, request);
      // A miss may only mean the snapshot has not listed the image yet.
      void request.then((value) => {
        if (value === null) thumbnailCache.delete(key);
      });
    }
    void request.then((value) => {
      if (live) setDataUrl(value);
    });
    return () => {
      live = false;
    };
    // `source` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rpc, threadId]);
  if (!dataUrl) return fallback === undefined ? <span className={cn("block bg-muted", className)} /> : <>{fallback}</>;
  return <img src={dataUrl} alt={alt} className={className} loading="lazy" draggable={false} />;
}

function usePanelActions(threadId: string, rpc: Rpc, refresh: (force?: boolean) => Promise<void>): PanelActions {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (name: string, run: () => Promise<{ message: string }>) => {
    setBusy(name);
    try {
      toast.success((await run()).message);
      await refresh(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return {
    Link: ({ href, className, title, children }) => (
      <UrlLink href={href} className={className} title={title}>
        {children}
      </UrlLink>
    ),
    FileLink: ({ path, className, children }) => (
      <FileLink target={{ kind: "thread-storage", threadId, path }} className={className}>
        {children}
      </FileLink>
    ),
    Markdown: ({ content }) => <Markdown content={content} />,
    Thumbnail: (props) => <Thumbnail rpc={rpc} threadId={threadId} {...props} />,
    copy: (text, what) => {
      navigator.clipboard.writeText(text).then(
        () => toast.success(`${what} copied`),
        () => toast.error(`Could not copy ${what.toLowerCase()}`),
      );
    },
    commit: () => void act("commit", () => rpc.call("commit", { threadId })),
    markReady: () => void act("markReady", () => rpc.call("markReady", { threadId })),
    askAgent: (action: AgentAction) => void act(action, () => rpc.call("askAgent", { threadId, action })),
    busy,
  };
}

// ---- Floating panel ----------------------------------------------------

const PANEL_WIDTH = 340;

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function PanelWindow({ threadId }: { threadId: string }) {
  const { snapshot, error, loading, loadedAt, rpc, refresh } = useSnapshot(threadId, { poll: true });
  const [position, setPosition] = useState(() => clampPosition(readPosition(), PANEL_WIDTH));
  const drag = useRef<{ x: number; y: number; start: Position } | null>(null);
  const now = useNow(10_000);

  useEffect(() => {
    const onResize = () => setPosition((current) => clampPosition(current, PANEL_WIDTH));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button") !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, start: position };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) return;
    setPosition(
      clampPosition(
        { right: start.start.right - (event.clientX - start.x), top: start.start.top + (event.clientY - start.y) },
        PANEL_WIDTH,
      ),
    );
  };
  const onPointerUp = () => {
    if (drag.current === null) return;
    drag.current = null;
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  };

  const actions = usePanelActions(threadId, rpc, refresh);

  let body: ReactNode;
  if (snapshot !== null && snapshot.threadId === threadId) body = <PanelBody snapshot={snapshot} actions={actions} />;
  else if (error !== null) body = <p className="px-3 py-4 text-sm text-destructive">{error}</p>;
  else body = <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>;

  return (
    <PanelFrame
      style={{ right: position.right, top: position.top, width: `min(${PANEL_WIDTH}px, calc(100vw - 16px))` }}
      loading={loading}
      updatedLabel={loadedAt > 0 ? `updated ${relativeTime(loadedAt, now)}` : "not loaded"}
      onRefresh={() => void refresh(true)}
      onClose={() => setPanelOpen(false)}
      dragHandlers={{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }}
    >
      {body}
    </PanelFrame>
  );
}

function FloatingPanel() {
  const { threadId } = useBbContext();
  const open = usePanelOpen();
  if (!open || threadId === null) return null;
  return <PanelWindow key={threadId} threadId={threadId} />;
}

// ---- Thread info integration --------------------------------------------
//
// BB has no plugin slot inside its Thread info tab, so this overlay finds the
// tab's definition list and portals extra sections onto its end. It keys off
// the row labels BB renders there, re-attaches when BB re-renders, and
// removes its node on unmount. If BB changes that markup, the sections just
// stop appearing; nothing else breaks.

const THREAD_INFO_LABELS = new Set([
  "Environment",
  "Directory",
  "Parent",
  "Branch",
  "Pull request",
  "Merge base",
  "Git status",
  "Thread storage",
  "Goal",
  "Plan",
]);
const MOUNT_ATTRIBUTE = "data-env-panel-thread-info";

function findThreadInfoList(): HTMLElement | null {
  for (const list of document.querySelectorAll<HTMLElement>("aside dl")) {
    for (const term of list.querySelectorAll("dt")) {
      if (THREAD_INFO_LABELS.has(term.textContent?.trim() ?? "")) return list;
    }
  }
  return null;
}

/** A node at the end of Thread info's list, kept attached while mounted. */
function useThreadInfoMount(enabled: boolean): HTMLElement | null {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const node = document.createElement("div");
    node.setAttribute(MOUNT_ATTRIBUTE, "");
    let frame = 0;
    const place = () => {
      frame = 0;
      const list = findThreadInfoList();
      if (list === null) {
        if (node.isConnected) node.remove();
        setMount(null);
        return;
      }
      // Sit above BB's Thread storage row: it grows to fill the panel, so
      // anything after it lands at the bottom edge.
      const storage = [...list.children].find(
        (child) => child !== node && child.textContent?.trimStart().startsWith("Thread storage"),
      );
      const before = storage ?? null;
      if (node.parentElement !== list || node.nextElementSibling !== before) list.insertBefore(node, before);
      setMount(node);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    const observer = new MutationObserver((records) => {
      // Our own portal renders into `node`; only react to BB's changes.
      if (records.every((record) => node.contains(record.target))) return;
      schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    place();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      node.remove();
      setMount(null);
    };
  }, [enabled]);
  return mount;
}

/** True while `node` is on screen, so hidden Thread info tabs do not poll. */
function useVisible(node: HTMLElement | null): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (node === null) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return visible;
}

function ThreadInfoSections({ threadId, mount }: { threadId: string; mount: HTMLElement }) {
  const visible = useVisible(mount);
  const { snapshot, rpc, refresh } = useSnapshot(threadId, { poll: visible });
  const actions = usePanelActions(threadId, rpc, refresh);
  if (snapshot === null || snapshot.threadId !== threadId) return null;
  return createPortal(<ThreadInfoExtras snapshot={snapshot} actions={actions} />, mount);
}

function ThreadInfoPortal() {
  const { threadId } = useBbContext();
  const { values } = useSettings();
  const mount = useThreadInfoMount(threadId !== null && values?.showInThreadInfo !== false);
  if (threadId === null || mount === null) return null;
  return <ThreadInfoSections key={threadId} threadId={threadId} mount={mount} />;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "environment",
    title: "Environment",
    component: HeaderButton,
  });
  app.slots.experimental_appOverlay({
    id: "environment-panel",
    component: FloatingPanel,
  });
  app.slots.experimental_appOverlay({
    id: "thread-info-sections",
    component: ThreadInfoPortal,
  });
});
