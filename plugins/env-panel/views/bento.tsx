// The panel as a Control Center-style bento grid. Each tile is a glanceable
// module; tapping one expands it into its full detail view in place. Edit
// mode hides, resizes, reorders, and adds tiles, including widgets from
// sub-plugins. Pure view: data and actions come in as props.
import { useState, useSyncExternalStore, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import AndroidIcon from "@hugeicons/core-free-icons/AndroidIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import Bug01Icon from "@hugeicons/core-free-icons/Bug01Icon";
import ChartLineData01Icon from "@hugeicons/core-free-icons/ChartLineData01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import CloudIcon from "@hugeicons/core-free-icons/CloudIcon";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import DatabaseIcon from "@hugeicons/core-free-icons/DatabaseIcon";
import FavouriteIcon from "@hugeicons/core-free-icons/FavouriteIcon";
import Flag01Icon from "@hugeicons/core-free-icons/Flag01Icon";
import FlashIcon from "@hugeicons/core-free-icons/FlashIcon";
import GitCommitIcon from "@hugeicons/core-free-icons/GitCommitIcon";
import GitPullRequestIcon from "@hugeicons/core-free-icons/GitPullRequestIcon";
import Globe02Icon from "@hugeicons/core-free-icons/Globe02Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Mail01Icon from "@hugeicons/core-free-icons/Mail01Icon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import PlusMinusSquare01Icon from "@hugeicons/core-free-icons/PlusMinusSquare01Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import Rocket01Icon from "@hugeicons/core-free-icons/Rocket01Icon";
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";
import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import SmartPhone01Icon from "@hugeicons/core-free-icons/SmartPhone01Icon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";
import WorkflowCircle03Icon from "@hugeicons/core-free-icons/WorkflowCircle03Icon";
import Attachment01Icon from "@hugeicons/core-free-icons/Attachment01Icon";
import { cn } from "@/lib/utils";
import type { Snapshot } from "../core/types.ts";
import type { Widget, WidgetSize } from "../core/widgets.ts";
import { summarizeSubagents } from "../core/schedule.ts";
import { AttachmentsSection } from "./attachments";
import {
  AgentSection,
  EnvironmentSection,
  formatCount,
  Icon,
  PullRequestSection,
  ScheduledSection,
  StackSection,
  SubagentsSection,
  type PanelActions,
} from "./panel";
import { Identicon, SectionChrome } from "./section";

// ---- Tiles --------------------------------------------------------------------

export type Tone = "neutral" | "positive" | "warning" | "critical" | "accent";

export interface Tile {
  id: string;
  title: string;
  icon: IconSvgElement | string;
  size: WidgetSize;
  /** Sizes the user may switch between in edit mode. */
  sizes: readonly WidgetSize[];
  tone: Tone;
  value?: ReactNode;
  caption?: ReactNode;
  progress?: number;
  /** Custom glanceable art in place of the value, like the stack's dot rail. */
  visual?: ReactNode;
  /** Full detail, shown when the tile expands. */
  detail?: () => ReactNode;
  /** An action tile runs this on tap instead of expanding, like a CC toggle. */
  onPress?: () => void;
  busy?: boolean;
  /** Where the tile came from, shown in edit mode. */
  origin: "built-in" | "script" | "plugin";
}

const TONE_GLYPH: Record<Tone, string> = {
  neutral: "bg-foreground/8 text-foreground/75",
  positive: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  critical: "bg-destructive/15 text-destructive",
  accent: "bg-primary/15 text-primary",
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-foreground",
  positive: "text-success",
  warning: "text-warning",
  critical: "text-destructive",
  accent: "text-primary",
};

// Written out in full so Tailwind generates every class.
const TONE_FILL: Record<Tone, string> = {
  neutral: "bg-foreground/35",
  positive: "bg-success",
  warning: "bg-warning",
  critical: "bg-destructive",
  accent: "bg-primary",
};

const WIDGET_ICONS: Record<string, IconSvgElement> = {
  android: AndroidIcon,
  phone: SmartPhone01Icon,
  bug: Bug01Icon,
  chart: ChartLineData01Icon,
  check: CheckmarkCircle02Icon,
  clock: Clock01Icon,
  cloud: CloudIcon,
  code: SourceCodeIcon,
  database: DatabaseIcon,
  flag: Flag01Icon,
  globe: Globe02Icon,
  heart: FavouriteIcon,
  lightning: FlashIcon,
  link: Link01Icon,
  mail: Mail01Icon,
  rocket: Rocket01Icon,
  server: ServerStack01Icon,
  shield: Shield01Icon,
  star: StarIcon,
  terminal: ComputerTerminal01Icon,
  users: UserGroupIcon,
};

function Glyph({ icon, tone, className }: { icon: Tile["icon"]; tone: Tone; className?: string }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", TONE_GLYPH[tone], className)}>
      {typeof icon === "string" ? <span className="text-base leading-none">{icon}</span> : <Icon icon={icon} className="size-[18px]" />}
    </span>
  );
}

/** A ring for small tiles: CC's volume and brightness style, drawn in the tile's tone. */
function Ring({ value, tone }: { value: number; tone: Tone }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 36 36" className={cn("size-9 -rotate-90", TONE_TEXT[tone])} aria-hidden>
      <circle cx="18" cy="18" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="4" />
      <circle
        cx="18"
        cy="18"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, value)))}
      />
    </svg>
  );
}

function Bar({ value, tone }: { value: number; tone: Tone }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
      <span
        className={cn("block h-full rounded-full", TONE_FILL[tone])}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  );
}

const SIZE_CLASS: Record<WidgetSize, string> = {
  small: "col-span-1 row-span-1",
  wide: "col-span-2 row-span-1",
  large: "col-span-2 row-span-2",
};

function TileFace({ tile }: { tile: Tile }) {
  const ring = tile.size === "small" && tile.progress !== undefined;
  if (tile.size === "small") {
    return (
      <div className="flex h-full flex-col justify-between">
        <div className="flex items-start justify-between">
          {ring ? (
            <span className="relative flex size-9 items-center justify-center">
              <Ring value={tile.progress!} tone={tile.tone} />
            </span>
          ) : (
            <Glyph icon={tile.icon} tone={tile.tone} className="size-7" />
          )}
        </div>
        <div className="min-w-0">
          {tile.value !== undefined ? <div className="truncate text-[15px] font-semibold leading-[1.1] tabular-nums">{tile.value}</div> : null}
          <div className="truncate text-[11px] leading-tight text-muted-foreground">{tile.title}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-w-0 items-center gap-2.5">
        <Glyph icon={tile.icon} tone={tile.tone} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] leading-tight text-muted-foreground">{tile.title}</div>
          {tile.value !== undefined ? <div className="truncate text-[15px] font-semibold leading-snug tabular-nums">{tile.value}</div> : null}
        </div>
      </div>
      <div className={cn("mt-auto min-w-0", tile.size === "large" && "flex flex-1 flex-col justify-end")}>
        {tile.visual ?? null}
        {tile.visual === undefined && tile.progress !== undefined ? <Bar value={tile.progress} tone={tile.tone} /> : null}
        {tile.caption !== undefined ? (
          <div className={cn("truncate text-[11px] leading-tight text-muted-foreground", (tile.visual || tile.progress !== undefined) && "mt-1.5")}>
            {tile.caption}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- Layout (per app window, remembered) ---------------------------------------

const LAYOUT_KEY = "bb-env-panel:layout";

interface Layout {
  order: string[];
  hidden: string[];
  sizes: Record<string, WidgetSize>;
}

function readLayout(): Layout {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Partial<Layout> | null;
    return {
      order: Array.isArray(parsed?.order) ? parsed.order.filter((id) => typeof id === "string") : [],
      hidden: Array.isArray(parsed?.hidden) ? parsed.hidden.filter((id) => typeof id === "string") : [],
      sizes: parsed?.sizes !== null && typeof parsed?.sizes === "object" ? (parsed.sizes as Layout["sizes"]) : {},
    };
  } catch {
    return { order: [], hidden: [], sizes: {} };
  }
}

let layout: Layout = typeof localStorage === "undefined" ? { order: [], hidden: [], sizes: {} } : readLayout();
const layoutListeners = new Set<() => void>();

function updateLayout(change: (current: Layout) => Layout) {
  layout = change(layout);
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Keep the change for this session.
  }
  for (const listener of layoutListeners) listener();
}

function useLayout(): Layout {
  return useSyncExternalStore(
    (listener) => {
      layoutListeners.add(listener);
      return () => layoutListeners.delete(listener);
    },
    () => layout,
  );
}

/** Applies the saved order and sizes; tiles the user never placed keep their default spot. */
function arrange(tiles: Tile[], saved: Layout): { shown: Tile[]; hidden: Tile[] } {
  const rank = (tile: Tile, index: number) => {
    const position = saved.order.indexOf(tile.id);
    return position === -1 ? saved.order.length + index : position;
  };
  const sized = tiles.map((tile) => {
    const size = saved.sizes[tile.id];
    return size !== undefined && tile.sizes.includes(size) ? { ...tile, size } : tile;
  });
  const ordered = sized.map((tile, index) => ({ tile, rank: rank(tile, index) })).sort((a, b) => a.rank - b.rank).map(({ tile }) => tile);
  return {
    shown: ordered.filter((tile) => !saved.hidden.includes(tile.id)),
    hidden: ordered.filter((tile) => saved.hidden.includes(tile.id)),
  };
}

// ---- Built-in tiles ---------------------------------------------------------------

// Short enough to fit a wide tile; the detail view has the full wording.
const ATTENTION: Record<string, { label: string; tone: Tone }> = {
  blocked: { label: "Blocked", tone: "warning" },
  changes_requested: { label: "Changes asked", tone: "critical" },
  checks_failed: { label: "CI failing", tone: "critical" },
  checks_pending: { label: "CI running", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" },
  conflicts: { label: "Conflicts", tone: "critical" },
  draft: { label: "Draft", tone: "neutral" },
  merged: { label: "Merged", tone: "accent" },
  none: { label: "Open", tone: "positive" },
  ready_to_merge: { label: "Ready", tone: "positive" },
  review_requested: { label: "In review", tone: "accent" },
};

function Stat({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <span className="font-mono text-[13px] tabular-nums tracking-tight">
      <span className="text-success">+{formatCount(insertions)}</span> <span className="text-destructive">−{formatCount(deletions)}</span>
    </span>
  );
}

/** Tiles derived from the snapshot. A tile appears only when it has something to show. */
export function builtInTiles(snapshot: Snapshot, actions: PanelActions): Tile[] {
  const tiles: Tile[] = [];
  const add = (tile: Omit<Tile, "origin">) => tiles.push({ ...tile, origin: "built-in" });
  const env = snapshot.environment.ok ? snapshot.environment.value : null;
  const changes = snapshot.changes.ok ? snapshot.changes.value : null;
  const pr = snapshot.pullRequest.ok ? snapshot.pullRequest.value : null;
  const stack = snapshot.stack.ok ? snapshot.stack.value : null;
  const agent = snapshot.agent.ok ? snapshot.agent.value : null;
  const subagents = snapshot.subagents.ok ? snapshot.subagents.value : [];
  const scheduled = snapshot.scheduled.ok ? snapshot.scheduled.value : [];
  const attachments = snapshot.attachments.ok ? snapshot.attachments.value.items : [];

  const environmentDetail = () => <EnvironmentSection environment={snapshot.environment} changes={snapshot.changes} actions={actions} />;

  if (changes !== null) {
    const insertions = changes.uncommitted.insertions + (changes.branch?.insertions ?? 0);
    const deletions = changes.uncommitted.deletions + (changes.branch?.deletions ?? 0);
    const files = changes.uncommitted.files.length;
    const ahead = changes.branch ? `↑${changes.branch.ahead}${changes.branch.behind > 0 ? ` ↓${changes.branch.behind}` : ""}` : null;
    add({
      id: "changes",
      title: "Changes",
      icon: PlusMinusSquare01Icon,
      size: "wide",
      sizes: ["small", "wide"],
      tone: files > 0 ? "accent" : "neutral",
      value: insertions + deletions > 0 ? <Stat insertions={insertions} deletions={deletions} /> : "No changes",
      caption: [ahead, env?.branch ?? (files > 0 ? `${files} uncommitted` : "Clean")].filter(Boolean).join(" · "),
      detail: environmentDetail,
    });
    if (files > 0) {
      add({
        id: "commit",
        title: "Commit",
        icon: GitCommitIcon,
        size: "small",
        sizes: ["small"],
        tone: "accent",
        value: `${files} file${files === 1 ? "" : "s"}`,
        onPress: actions.commit,
        busy: actions.busy === "commit",
      });
    }
  } else if (env !== null) {
    add({
      id: "changes",
      title: "Workspace",
      icon: ComputerTerminal01Icon,
      size: "wide",
      sizes: ["small", "wide"],
      tone: "neutral",
      value: env.name ?? (env.kind === "personal" ? "Personal workspace" : "Workspace"),
      caption: env.path ?? undefined,
      detail: environmentDetail,
    });
  }

  if (pr !== null) {
    const attention = ATTENTION[pr.attention] ?? { label: pr.attention, tone: "neutral" as Tone };
    add({
      id: "pull-request",
      title: `#${pr.number}`,
      icon: GitPullRequestIcon,
      size: "wide",
      sizes: ["wide", "large"],
      tone: attention.tone,
      value: attention.label,
      caption: pr.title,
      detail: () => <PullRequestSection pullRequest={snapshot.pullRequest} actions={actions} />,
    });
    if (pr.checks.total > 0) {
      const tone: Tone = pr.checks.failed > 0 ? "critical" : pr.checks.pending > 0 ? "warning" : "positive";
      add({
        id: "checks",
        title: "Checks",
        icon: CheckmarkCircle02Icon,
        size: "small",
        sizes: ["small"],
        tone,
        value: `${pr.checks.passed}/${pr.checks.total}`,
        progress: pr.checks.passed / pr.checks.total,
        detail: () => <PullRequestSection pullRequest={snapshot.pullRequest} actions={actions} />,
      });
      if (pr.checks.failed > 0) {
        add({
          id: "fix-ci",
          title: "Ask agent",
          icon: Bug01Icon,
          size: "small",
          sizes: ["small"],
          tone: "critical",
          value: "Fix CI",
          onPress: () => actions.askAgent("fix-checks"),
          busy: actions.busy === "fix-checks",
        });
      }
    }
  }

  if (stack !== null) {
    const current = stack.prs.findIndex((row) => row.isCurrent);
    const failing = stack.prs.some((row) => row.checks === "failing" && row.state !== "merged" && row.state !== "closed");
    add({
      id: "stack",
      title: `Stack #${stack.number}`,
      icon: WorkflowCircle03Icon,
      size: "wide",
      sizes: ["wide", "large"],
      tone: failing ? "warning" : "accent",
      value: current === -1 ? `${stack.prs.length} PRs` : `${stack.prs.length - current} of ${stack.prs.length}`,
      visual: (
        // Bottom of the stack on the left, like reading it from trunk up.
        <span className="flex h-2 items-center gap-1" aria-hidden>
          {[...stack.prs].reverse().map((row) => (
            <span
              key={row.number}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                row.state === "merged" || row.state === "closed"
                  ? "bg-foreground/15"
                  : row.checks === "failing"
                    ? "bg-destructive"
                    : row.checks === "pending"
                      ? "bg-warning"
                      : "bg-success",
                row.isCurrent && "h-2 ring-2 ring-foreground/30",
              )}
            />
          ))}
        </span>
      ),
      caption: `on ${stack.trunk}`,
      detail: () => <StackSection stack={snapshot.stack} actions={actions} />,
    });
  }

  if (agent?.context) {
    const share = agent.context.usedTokens / agent.context.windowTokens;
    add({
      id: "context",
      title: "Context",
      icon: ChartLineData01Icon,
      size: "small",
      sizes: ["small"],
      tone: share > 0.8 ? "critical" : share > 0.6 ? "warning" : "neutral",
      value: `${Math.round(share * 100)}%`,
      progress: share,
      detail: () => <AgentSection agent={snapshot.agent} />,
    });
  }
  if (agent?.todos) {
    add({
      id: "tasks",
      title: "Tasks",
      icon: Task01Icon,
      size: "wide",
      sizes: ["wide", "large"],
      tone: agent.todos.done === agent.todos.total ? "positive" : "accent",
      value: `${agent.todos.done} of ${agent.todos.total}`,
      progress: agent.todos.done / agent.todos.total,
      caption: agent.todos.current ?? (agent.todos.done === agent.todos.total ? "All done" : undefined),
      detail: () => <AgentSection agent={snapshot.agent} />,
    });
  }

  if (subagents.length > 0) {
    const active = subagents.some((subagent) => subagent.status === "running" || subagent.status === "pending");
    add({
      id: "subagents",
      title: "Subagents",
      icon: UserGroupIcon,
      size: "wide",
      sizes: ["small", "wide"],
      tone: subagents.some((subagent) => subagent.status === "failed") ? "critical" : active ? "warning" : "positive",
      // The headline is what needs attention; the rest is in the detail view.
      value: summarizeSubagents(subagents).split(" · ")[0],
      visual: (
        <span className="flex -space-x-1.5">
          {subagents.slice(0, 6).map((subagent) => (
            <Identicon key={subagent.id} seed={subagent.id} className="size-5 ring-popover" />
          ))}
        </span>
      ),
      detail: () => <SubagentsSection subagents={snapshot.subagents} actions={actions} />,
    });
  }

  if (scheduled.length > 0) {
    const next = scheduled.map((item) => item.nextRunAt).filter((at): at is number => at !== null).sort()[0];
    add({
      id: "scheduled",
      title: "Scheduled",
      icon: Clock01Icon,
      size: "small",
      sizes: ["small", "wide"],
      tone: scheduled.some((item) => item.lastRunStatus === "failed") ? "critical" : "neutral",
      value: next === undefined ? `${scheduled.length}` : `in ${Math.max(1, Math.round((next - Date.now()) / 60_000))}m`,
      caption: scheduled[0]?.schedule,
      detail: () => <ScheduledSection scheduled={snapshot.scheduled} actions={actions} />,
    });
  }

  const ticket = attachments.find((item) => item.detail?.kind === "linear");
  if (ticket?.detail?.kind === "linear") {
    const issue = ticket.detail.issue;
    add({
      id: "ticket",
      title: issue.identifier,
      icon: Flag01Icon,
      size: "wide",
      sizes: ["wide", "large"],
      tone: issue.state?.type === "completed" ? "positive" : issue.state?.type === "started" ? "accent" : "neutral",
      value: issue.state?.name ?? "Ticket",
      caption: issue.title,
      detail: () => <AttachmentsSection attachments={snapshot.attachments} actions={actions} />,
    });
  }

  if (attachments.length > 0) {
    const images = attachments.filter((item) => item.ref.kind === "image").slice(0, 4);
    add({
      id: "attachments",
      title: "Attachments",
      icon: Attachment01Icon,
      size: images.length > 0 ? "large" : "wide",
      sizes: ["wide", "large"],
      tone: "neutral",
      value: `${attachments.length}`,
      visual:
        images.length > 0 ? (
          <span className="grid grid-cols-2 gap-1">
            {images.map(({ ref }) => (
              <actions.Thumbnail
                key={ref.id}
                source={"path" in ref && ref.path !== undefined ? { kind: "file", path: ref.path } : { kind: "url", url: ref.url ?? "" }}
                alt=""
                className="aspect-[4/3] w-full rounded-md object-cover"
              />
            ))}
          </span>
        ) : undefined,
      caption: [...new Set(attachments.map((item) => item.ref.kind))].slice(0, 4).join(" · "),
      detail: () => <AttachmentsSection attachments={snapshot.attachments} actions={actions} />,
    });
  }

  return tiles;
}

// ---- Sub-plugin widget tiles ------------------------------------------------------

function WidgetDetail({ widget, actions }: { widget: Widget; actions: PanelActions }) {
  return (
    <div className="space-y-2 px-1.5">
      {widget.error ? <p className="text-xs text-destructive">{widget.error}</p> : null}
      {widget.caption ? <p className="text-sm text-muted-foreground">{widget.caption}</p> : null}
      {widget.items?.map((item, index) => {
        const row = (
          <div className="flex items-center gap-2 rounded-md py-1 text-sm">
            <span className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[item.tone ?? "neutral"])} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.detail ? <span className="shrink-0 text-xs text-muted-foreground">{item.detail}</span> : null}
          </div>
        );
        return item.url ? (
          <actions.Link key={index} href={item.url} className="block hover:bg-accent/60">
            {row}
          </actions.Link>
        ) : (
          <div key={index}>{row}</div>
        );
      })}
      {widget.actions && widget.actions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {widget.actions.map((action, index) =>
            action.kind === "url" ? (
              <actions.Link key={index} href={action.url} className="inline-flex h-7 items-center rounded-full bg-foreground/8 px-3 text-xs font-medium hover:bg-foreground/12">
                {action.label}
              </actions.Link>
            ) : (
              <button
                key={index}
                type="button"
                onClick={() => (action.kind === "copy" ? actions.copy(action.text, action.label) : actions.widgetAction(widget.key, index))}
                className="inline-flex h-7 items-center rounded-full bg-foreground/8 px-3 text-xs font-medium hover:bg-foreground/12"
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
      {widget.url ? (
        <actions.Link href={widget.url} className="inline-block text-xs text-muted-foreground underline-offset-2 hover:underline">
          Open
        </actions.Link>
      ) : null}
      <p className="pt-1 text-[11px] text-muted-foreground">
        {widget.source.kind === "script" ? `Script widget “${widget.source.name}”` : `From the ${widget.source.pluginId} plugin`}
      </p>
    </div>
  );
}

export function widgetTiles(snapshot: Snapshot, actions: PanelActions): Tile[] {
  if (!snapshot.widgets.ok) return [];
  return snapshot.widgets.value.map((widget) => ({
    id: widget.key,
    title: widget.title,
    icon: (widget.icon && WIDGET_ICONS[widget.icon]) || widget.icon || (widget.source.kind === "script" ? ComputerTerminal01Icon : FlashIcon),
    size: widget.size,
    sizes: ["small", "wide", "large"] as const,
    tone: widget.error ? "critical" : (widget.tone ?? "neutral"),
    value: widget.error ? "Error" : widget.value,
    caption: widget.error ?? widget.caption,
    progress: widget.progress,
    visual:
      widget.size === "large" && widget.items && widget.items.length > 0 ? (
        <span className="flex flex-col gap-1">
          {widget.items.slice(0, 3).map((item, index) => (
            <span key={index} className="flex items-center gap-1.5 truncate text-xs">
              <span className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[item.tone ?? "neutral"])} />
              <span className="truncate">{item.label}</span>
            </span>
          ))}
        </span>
      ) : undefined,
    detail: () => <WidgetDetail widget={widget} actions={actions} />,
    origin: widget.source.kind,
  }));
}

// ---- Grid ---------------------------------------------------------------------------

function TileButton({
  tile,
  editing,
  onOpen,
  onHide,
  onResize,
  dragProps,
}: {
  tile: Tile;
  editing: boolean;
  onOpen: () => void;
  onHide: () => void;
  onResize: () => void;
  dragProps: Record<string, unknown>;
}) {
  const interactive = !editing && (tile.detail !== undefined || tile.onPress !== undefined);
  return (
    <div className={cn("relative", SIZE_CLASS[tile.size])} {...dragProps}>
      <button
        type="button"
        data-env-panel-tile=""
        data-tone={tile.tone}
        data-editing={editing ? "" : undefined}
        disabled={!interactive && !editing}
        aria-label={`${tile.title}${typeof tile.value === "string" ? `: ${tile.value}` : ""}${editing ? ". Change size" : ""}`}
        onClick={editing ? onResize : tile.onPress ?? onOpen}
        className={cn("size-full text-left", tile.size === "small" ? "p-2.5" : "p-3")}
      >
        {tile.busy ? <span className="absolute right-3 top-3 size-2 animate-pulse rounded-full bg-primary" /> : null}
        <TileFace tile={tile} />
      </button>
      {editing ? (
        <button
          type="button"
          aria-label={`Hide ${tile.title}`}
          onClick={onHide}
          className="absolute -left-1.5 -top-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-foreground/80 text-background shadow-sm"
        >
          <Icon icon={MinusSignIcon} className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

export function BentoGrid({
  tiles,
  editing,
  onOpen,
}: {
  tiles: Tile[];
  editing: boolean;
  onOpen: (tile: Tile) => void;
}) {
  const saved = useLayout();
  const { shown, hidden } = arrange(tiles, saved);
  const [dragging, setDragging] = useState<string | null>(null);

  const move = (id: string, beforeId: string) => {
    if (id === beforeId) return;
    const ids = shown.map((tile) => tile.id).filter((candidate) => candidate !== id);
    ids.splice(ids.indexOf(beforeId), 0, id);
    updateLayout((current) => ({ ...current, order: [...ids, ...current.order.filter((candidate) => !ids.includes(candidate))] }));
  };
  const hide = (id: string) => updateLayout((current) => ({ ...current, hidden: [...new Set([...current.hidden, id])] }));
  const unhide = (id: string) => updateLayout((current) => ({ ...current, hidden: current.hidden.filter((candidate) => candidate !== id) }));
  const resize = (tile: Tile) => {
    const next = tile.sizes[(tile.sizes.indexOf(tile.size) + 1) % tile.sizes.length] ?? tile.size;
    updateLayout((current) => ({ ...current, sizes: { ...current.sizes, [tile.id]: next } }));
  };

  if (shown.length === 0 && !editing) {
    return <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing to show for this thread yet.</p>;
  }

  return (
    <div className="px-3 pb-3">
      <div className="grid grid-flow-row-dense grid-cols-4 gap-2" style={{ gridAutoRows: "var(--env-panel-tile)" } as CSSProperties}>
        {shown.map((tile) => (
          <TileButton
            key={tile.id}
            tile={tile}
            editing={editing}
            onOpen={() => onOpen(tile)}
            onHide={() => hide(tile.id)}
            onResize={() => resize(tile)}
            dragProps={
              editing
                ? {
                    draggable: true,
                    "data-dragging": dragging === tile.id ? "" : undefined,
                    onDragStart: (event: DragEvent) => {
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(tile.id);
                    },
                    onDragOver: (event: DragEvent) => {
                      event.preventDefault();
                      if (dragging !== null) move(dragging, tile.id);
                    },
                    onDragEnd: () => setDragging(null),
                  }
                : {}
            }
          />
        ))}
      </div>
      {editing ? (
        <div className="mt-4">
          <div className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">Add tiles</div>
          {hidden.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">Every available tile is showing.</p>
          ) : (
            <div className="space-y-1">
              {hidden.map((tile) => (
                <button
                  key={tile.id}
                  type="button"
                  onClick={() => unhide(tile.id)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-foreground/5"
                >
                  <Glyph icon={tile.icon} tone={tile.tone} className="size-7" />
                  <span className="min-w-0 flex-1 truncate">{tile.title}</span>
                  <span className="text-[11px] text-muted-foreground">{tile.origin === "built-in" ? "" : tile.origin}</span>
                  <span className="flex size-5 items-center justify-center rounded-full bg-success text-background">
                    <Icon icon={PlusSignIcon} className="size-3" />
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-3 px-1 text-[11px] leading-relaxed text-muted-foreground">
            Tap a tile to change its size, drag to reorder. Add your own with <code>bb env-panel widgets new</code>, or ask
            the agent to write one.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** A tile expanded into its full detail, like pressing into a Control Center module. */
export function TileDetail({ tile, onBack }: { tile: Tile; onBack: () => void }) {
  return (
    <div data-env-panel-detail="" className="pb-2">
      <div className="flex items-center gap-2 px-2 pb-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to all tiles"
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
        >
          <Icon icon={ArrowLeft01Icon} className="size-4" />
        </button>
        <Glyph icon={tile.icon} tone={tile.tone} className="size-7" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{tile.title}</span>
      </div>
      <div className="px-2">
        <SectionChrome.Provider value="plain">{tile.detail?.()}</SectionChrome.Provider>
      </div>
    </div>
  );
}

/** The panel body: the grid, or one tile expanded into its detail. */
export function BentoPanel({ tiles, editing }: { tiles: Tile[]; editing: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId === null ? null : (tiles.find((tile) => tile.id === openId) ?? null);
  if (open !== null && !editing) return <TileDetail tile={open} onBack={() => setOpenId(null)} />;
  return <BentoGrid tiles={tiles} editing={editing} onOpen={(tile) => setOpenId(tile.id)} />;
}
