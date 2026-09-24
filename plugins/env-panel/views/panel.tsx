// The floating Environment panel body. Pure view: it renders a Snapshot and
// reports user intent through callbacks; app.tsx owns data and navigation.
import { useState, type CSSProperties, type DOMAttributes, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/CancelCircleIcon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import CircleIcon from "@hugeicons/core-free-icons/CircleIcon";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon";
import GitCommitIcon from "@hugeicons/core-free-icons/GitCommitIcon";
import GitMergeIcon from "@hugeicons/core-free-icons/GitMergeIcon";
import GitPullRequestClosedIcon from "@hugeicons/core-free-icons/GitPullRequestClosedIcon";
import GitPullRequestDraftIcon from "@hugeicons/core-free-icons/GitPullRequestDraftIcon";
import GitPullRequestIcon from "@hugeicons/core-free-icons/GitPullRequestIcon";
import GithubIcon from "@hugeicons/core-free-icons/GithubIcon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import PlusMinusSquare01Icon from "@hugeicons/core-free-icons/PlusMinusSquare01Icon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import Target02Icon from "@hugeicons/core-free-icons/Target02Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import { cn } from "@/lib/utils";
import { AttachmentsSection } from "./attachments";
import type {
  AgentInfo,
  ChangesInfo,
  ChecksState,
  EnvironmentInfo,
  PullRequestInfo,
  Section,
  Snapshot,
  StackInfo,
} from "../core/types.ts";

export type AgentAction = "submit-stack" | "fix-checks" | "address-review" | "restack";

export interface PanelActions {
  /** Renders an external link; the host decides how URLs open. */
  Link: (props: { href: string; className?: string; title?: string; children: ReactNode }) => ReactNode;
  /** Renders a link to a file in thread storage. */
  FileLink: (props: { path: string; className?: string; children: ReactNode }) => ReactNode;
  /** Renders Markdown the way BB renders a chat message. */
  Markdown: (props: { content: string }) => ReactNode;
  /** Renders an image the server fetched: a remote URL or a thread-storage file. */
  Thumbnail: (props: {
    source: { kind: "url"; url: string } | { kind: "file"; path: string };
    alt: string;
    className?: string;
    fallback?: ReactNode;
  }) => ReactNode;
  copy: (text: string, what: string) => void;
  commit: () => void;
  markReady: () => void;
  askAgent: (action: AgentAction) => void;
  /** The action currently running, so its button can show progress. */
  busy: string | null;
}

const COLLAPSED_LIMIT = 4;

export function Icon({ icon, className }: { icon: IconSvgElement; className?: string }) {
  return <HugeiconsIcon icon={icon} className={cn("size-4 shrink-0", className)} strokeWidth={1.8} />;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function DiffStat({ insertions, deletions, className }: { insertions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("shrink-0 font-mono text-xs tabular-nums", className)}>
      <span className="text-success">+{formatCount(insertions)}</span>{" "}
      <span className="text-destructive">−{formatCount(deletions)}</span>
    </span>
  );
}

function SectionTitle({ title, count, trailing }: { title: string; count?: number; trailing?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1 pb-1 pt-3 text-xs font-medium text-muted-foreground">
      <span>
        {title}
        {count === undefined ? null : <span className="ml-1.5 tabular-nums opacity-70">{count}</span>}
      </span>
      {trailing}
    </div>
  );
}

function Row({
  icon,
  iconClassName,
  label,
  trailing,
  muted,
  onClick,
  expanded,
  title,
}: {
  icon: IconSvgElement;
  iconClassName?: string;
  label: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
  onClick?: () => void;
  expanded?: boolean;
  title?: string;
}) {
  const body = (
    <>
      <Icon icon={icon} className={cn("text-muted-foreground", iconClassName)} />
      <span className={cn("min-w-0 flex-1 truncate text-left", muted && "text-muted-foreground")}>{label}</span>
      {trailing}
      {expanded === undefined ? null : (
        <Icon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} className="size-3.5 text-muted-foreground" />
      )}
    </>
  );
  const className = "flex min-h-8 w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-sm";
  if (onClick === undefined) {
    return (
      <div className={className} title={title}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(className, "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none")}
      onClick={onClick}
      aria-expanded={expanded}
      title={title}
    >
      {body}
    </button>
  );
}

function SmallButton({
  children,
  onClick,
  busy,
  disabled,
  tone = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: "default" | "primary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-50",
        tone === "primary"
          ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
          : "border-border bg-background hover:bg-accent",
      )}
    >
      {busy ? <Icon icon={Loading03Icon} className="size-3 animate-spin" /> : null}
      {children}
    </button>
  );
}

function IconButton({ icon, label, onClick, spin }: { icon: IconSvgElement; label: string; onClick: () => void; spin?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon icon={icon} className={cn("size-3.5", spin && "animate-spin")} />
    </button>
  );
}

function SectionError({ error }: { error: string }) {
  return (
    <p className="px-1.5 py-1 text-xs text-destructive" role="alert">
      {error}
    </p>
  );
}

function ShowMore({ hidden, expanded, onToggle }: { hidden: number; expanded: boolean; onToggle: () => void }) {
  if (hidden <= 0 && !expanded) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex min-h-7 w-full items-center gap-2.5 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-accent"
    >
      <span className="w-4" />
      {expanded ? "Show less" : `View all (${hidden} more)`}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 my-2 border-t border-border" />;
}

// ---- Environment -------------------------------------------------------

function workspaceLabel(env: EnvironmentInfo): string {
  if (env.kind === "personal") return env.name ?? "Personal workspace";
  if (env.isWorktree) return env.name ? `Worktree · ${env.name}` : "Local worktree";
  return env.name ?? "Local checkout";
}

function ChangesRows({ changes, actions }: { changes: ChangesInfo; actions: PanelActions }) {
  const [open, setOpen] = useState(false);
  const { uncommitted, branch } = changes;
  const total = {
    insertions: uncommitted.insertions + (branch?.insertions ?? 0),
    deletions: uncommitted.deletions + (branch?.deletions ?? 0),
  };
  const hasUncommitted = uncommitted.files.length > 0;
  return (
    <>
      <Row
        icon={PlusMinusSquare01Icon}
        label="Changes"
        trailing={<DiffStat insertions={total.insertions} deletions={total.deletions} />}
        expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div className="mb-1 ml-8 space-y-0.5 text-xs">
          {branch === null ? null : (
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span className="truncate">
                Committed vs {branch.base} · {branch.ahead} ahead{branch.behind > 0 ? `, ${branch.behind} behind` : ""}
              </span>
              <DiffStat insertions={branch.insertions} deletions={branch.deletions} />
            </div>
          )}
          {branch?.commits.slice(0, 6).map((commit) => (
            <div key={commit.shortSha} className="flex gap-2 truncate">
              <span className="font-mono text-muted-foreground">{commit.shortSha}</span>
              <span className="truncate">{commit.subject}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 pt-1 text-muted-foreground">
            <span>Uncommitted · {uncommitted.files.length} files</span>
            <DiffStat insertions={uncommitted.insertions} deletions={uncommitted.deletions} />
          </div>
          {uncommitted.files.slice(0, 12).map((file) => (
            <div key={file.path} className="flex items-center gap-2">
              <span className="w-4 font-mono text-muted-foreground">{file.status}</span>
              <span className="min-w-0 flex-1 truncate" title={file.path}>
                {file.path}
              </span>
            </div>
          ))}
          {uncommitted.files.length > 12 ? (
            <div className="text-muted-foreground">…and {uncommitted.files.length - 12} more</div>
          ) : null}
        </div>
      ) : null}
      <Row
        icon={GitCommitIcon}
        label={hasUncommitted ? "Commit changes" : "Nothing to commit"}
        muted={!hasUncommitted}
        trailing={
          hasUncommitted ? (
            <SmallButton onClick={actions.commit} busy={actions.busy === "commit"}>
              Commit
            </SmallButton>
          ) : null
        }
      />
    </>
  );
}

function EnvironmentSection({
  environment,
  changes,
  actions,
}: {
  environment: Section<EnvironmentInfo | null>;
  changes: Section<ChangesInfo | null>;
  actions: PanelActions;
}) {
  if (!environment.ok) return <SectionError error={environment.error} />;
  const env = environment.value;
  if (env === null) return <Row icon={ComputerTerminal01Icon} label="No environment yet" muted />;
  const branch = changes.ok ? changes.value?.branch : null;
  return (
    <>
      {changes.ok ? (changes.value === null ? null : <ChangesRows changes={changes.value} actions={actions} />) : (
        <SectionError error={changes.error} />
      )}
      <Row
        icon={ComputerTerminal01Icon}
        label={workspaceLabel(env)}
        title={env.path ?? undefined}
        trailing={env.path ? <IconButton icon={Copy01Icon} label="Copy path" onClick={() => actions.copy(env.path!, "Path")} /> : null}
      />
      {env.branch === null ? null : (
        <Row
          icon={GitBranchIcon}
          label={env.branch}
          title={env.branch}
          trailing={
            <>
              {branch && (branch.ahead > 0 || branch.behind > 0) ? (
                <span className="shrink-0 font-mono text-xs text-muted-foreground" title={`vs ${branch.base}`}>
                  ↑{branch.ahead} ↓{branch.behind}
                </span>
              ) : null}
              <IconButton icon={Copy01Icon} label="Copy branch name" onClick={() => actions.copy(env.branch!, "Branch")} />
            </>
          }
        />
      )}
    </>
  );
}

// ---- Pull request ------------------------------------------------------

function prIcon(state: string): { icon: IconSvgElement; className: string } {
  switch (state) {
    case "draft":
      return { icon: GitPullRequestDraftIcon, className: "text-muted-foreground" };
    case "merged":
      return { icon: GitMergeIcon, className: "text-primary" };
    case "closed":
      return { icon: GitPullRequestClosedIcon, className: "text-destructive" };
    default:
      return { icon: GitPullRequestIcon, className: "text-success" };
  }
}

const ATTENTION_LABEL: Record<string, string> = {
  blocked: "Blocked",
  changes_requested: "Changes requested",
  checks_failed: "Checks failing",
  checks_pending: "Checks running",
  closed: "Closed",
  conflicts: "Merge conflicts",
  draft: "Draft",
  merged: "Merged",
  none: "Open",
  ready_to_merge: "Ready to merge",
  review_requested: "Review requested",
};

function ChecksBadge({ state }: { state: ChecksState | string }) {
  if (state === "passing") return <Icon icon={CheckmarkCircle02Icon} className="size-3.5 text-success" />;
  if (state === "failing") return <Icon icon={CancelCircleIcon} className="size-3.5 text-destructive" />;
  if (state === "pending") return <Icon icon={CircleIcon} className="size-3.5 text-warning" />;
  return null;
}

function PullRequestSection({ pullRequest, actions }: { pullRequest: Section<PullRequestInfo | null>; actions: PanelActions }) {
  if (!pullRequest.ok) return <SectionError error={pullRequest.error} />;
  const pr = pullRequest.value;
  if (pr === null) return <Row icon={GithubIcon} label="No pull request for this branch" muted />;
  const { icon, className } = prIcon(pr.state);
  const checks = pr.checks;
  return (
    <>
      <actions.Link href={pr.url} className="block" title={pr.title}>
        <div className="flex min-h-8 items-center gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-accent">
          <Icon icon={icon} className={className} />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
          </span>
        </div>
      </actions.Link>
      <div className="ml-8 flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-xs text-muted-foreground">
        <span className={cn(pr.attention === "ready_to_merge" && "text-success", ["checks_failed", "conflicts", "changes_requested"].includes(pr.attention) && "text-destructive")}>
          {ATTENTION_LABEL[pr.attention] ?? pr.attention}
        </span>
        {checks.total > 0 ? (
          <span className="inline-flex items-center gap-1">
            <ChecksBadge state={checks.state} />
            {checks.passed}/{checks.total} checks
            {checks.failed > 0 ? <span className="text-destructive">· {checks.failed} failed</span> : null}
          </span>
        ) : null}
      </div>
      <div className="ml-8 flex flex-wrap gap-1.5 pb-1">
        {pr.state === "draft" ? (
          <SmallButton onClick={actions.markReady} busy={actions.busy === "markReady"}>
            Ready for review
          </SmallButton>
        ) : null}
        {checks.state === "failing" ? (
          <SmallButton onClick={() => actions.askAgent("fix-checks")} busy={actions.busy === "fix-checks"}>
            Ask agent to fix CI
          </SmallButton>
        ) : null}
        {pr.review === "changes_requested" ? (
          <SmallButton onClick={() => actions.askAgent("address-review")} busy={actions.busy === "address-review"}>
            Address review
          </SmallButton>
        ) : null}
      </div>
    </>
  );
}

// ---- Stack -------------------------------------------------------------

function StackSection({ stack, actions }: { stack: Section<StackInfo | null>; actions: PanelActions }) {
  if (!stack.ok) {
    return (
      <>
        <Divider />
        <SectionTitle title="Stack" />
        <SectionError error={stack.error} />
      </>
    );
  }
  const value = stack.value;
  if (value === null) return null;
  const currentIndex = value.prs.findIndex((pr) => pr.isCurrent);
  // prs are top first; position counts up from trunk like github.com does.
  const position = currentIndex === -1 ? null : value.prs.length - currentIndex;
  return (
    <>
      <Divider />
      <SectionTitle
        title={`Stack #${value.number}`}
        trailing={
          <span className="font-normal">
            {position === null ? `${value.prs.length} PRs` : `${position} of ${value.prs.length}`} · on {value.trunk}
          </span>
        }
      />
      {value.prs.map((pr) => {
        const { icon, className } = prIcon(pr.state);
        const done = pr.state === "merged" || pr.state === "closed";
        return (
          <actions.Link key={pr.number} href={pr.url} className="block" title={`${pr.state} · ${pr.title}`}>
            <div
              className={cn(
                "flex min-h-8 items-center gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-accent",
                pr.isCurrent && "bg-accent/60",
                done && "text-muted-foreground",
              )}
            >
              <Icon icon={icon} className={className} />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
              </span>
              {pr.review === "approved" && !done ? <span className="shrink-0 text-xs text-success">approved</span> : null}
              {done ? null : <ChecksBadge state={pr.checks} />}
            </div>
          </actions.Link>
        );
      })}
      <div className="ml-8 flex flex-wrap gap-1.5 pt-1">
        <SmallButton onClick={() => actions.askAgent("submit-stack")} busy={actions.busy === "submit-stack"}>
          Submit stack
        </SmallButton>
        <SmallButton onClick={() => actions.askAgent("restack")} busy={actions.busy === "restack"}>
          Sync stack
        </SmallButton>
      </div>
    </>
  );
}

// ---- Agent -------------------------------------------------------------

function Meter({ value, className }: { value: number; className?: string }) {
  return (
    <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      <span className={cn("block h-full rounded-full bg-primary", className)} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </span>
  );
}

function AgentSection({ agent }: { agent: Section<AgentInfo> }) {
  const [showTodos, setShowTodos] = useState(false);
  if (!agent.ok) return null;
  const { goal, todos, context, backgroundTasks } = agent.value;
  if (goal === null && todos === null && context === null && backgroundTasks.length === 0) return null;
  const contextShare = context === null ? 0 : context.usedTokens / context.windowTokens;
  return (
    <>
      <Divider />
      <SectionTitle title="Agent" />
      {goal === null ? null : <Row icon={Target02Icon} label={goal.objective} title={`${goal.status}: ${goal.objective}`} trailing={<span className="shrink-0 text-xs text-muted-foreground">{goal.status}</span>} />}
      {todos === null ? null : (
        <>
          <Row
            icon={Task01Icon}
            label={todos.current ?? (todos.done === todos.total ? "All tasks done" : "Tasks")}
            trailing={
              <>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {todos.done}/{todos.total}
                </span>
                <Meter value={todos.done / todos.total} />
              </>
            }
            expanded={showTodos}
            onClick={() => setShowTodos(!showTodos)}
          />
          {showTodos ? (
            <ul className="mb-1 ml-8 space-y-0.5 text-xs">
              {todos.items.map((item, index) => (
                <li key={index} className={cn("flex gap-2", item.status === "completed" && "text-muted-foreground line-through")}>
                  <span className="w-3">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "·"}</span>
                  <span className="min-w-0 flex-1">{item.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {context === null ? null : (
        <Row
          icon={CircleIcon}
          label="Context used"
          trailing={
            <>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{Math.round(contextShare * 100)}%</span>
              <Meter value={contextShare} className={contextShare > 0.8 ? "bg-destructive" : undefined} />
            </>
          }
        />
      )}
      {backgroundTasks.map((task, index) => (
        <Row key={index} icon={Loading03Icon} iconClassName="animate-spin" label={task} muted />
      ))}
    </>
  );
}

// ---- Sources and files ----------------------------------------------------

// ---- Panel -------------------------------------------------------------

export function PanelBody({ snapshot, actions }: { snapshot: Snapshot; actions: PanelActions }) {
  return (
    <div className="px-2 pb-2">
      <EnvironmentSection environment={snapshot.environment} changes={snapshot.changes} actions={actions} />
      {snapshot.environment.ok && snapshot.environment.value?.isGitRepo ? (
        <PullRequestSection pullRequest={snapshot.pullRequest} actions={actions} />
      ) : null}
      <StackSection stack={snapshot.stack} actions={actions} />
      <AgentSection agent={snapshot.agent} />
      <Divider />
      <AttachmentsSection attachments={snapshot.attachments} actions={actions} />
    </div>
  );
}

/**
 * The part of the panel BB's Thread info tab lacks: it already shows the
 * environment, branch, PR, goal, and plan, so this adds the stack and
 * attachments below them.
 */
export function ThreadInfoExtras({ snapshot, actions }: { snapshot: Snapshot; actions: PanelActions }) {
  return (
    <div className="-mx-2 pb-2">
      <StackSection stack={snapshot.stack} actions={actions} />
      <Divider />
      <AttachmentsSection attachments={snapshot.attachments} actions={actions} />
    </div>
  );
}

/** The floating window chrome: a draggable title bar and a scrolling body. */
export function PanelFrame({
  style,
  loading,
  updatedLabel,
  onRefresh,
  onClose,
  dragHandlers,
  children,
}: {
  style: CSSProperties;
  loading: boolean;
  updatedLabel: string;
  onRefresh: () => void;
  onClose: () => void;
  dragHandlers?: DOMAttributes<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <section
      aria-label="Environment panel"
      className="fixed z-30 flex max-h-[calc(100vh-72px)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
      style={style}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-1 px-3 pb-1 pt-2.5 active:cursor-grabbing"
        {...dragHandlers}
      >
        <h2 className="flex-1 text-sm font-medium text-muted-foreground">Environment</h2>
        <IconButton icon={loading ? Loading03Icon : RefreshIcon} label={`Refresh (${updatedLabel})`} onClick={onRefresh} spin={loading} />
        <IconButton icon={Cancel01Icon} label="Close environment panel" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </section>
  );
}
