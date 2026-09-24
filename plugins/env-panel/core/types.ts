// The snapshot the floating panel renders. server.ts builds it; app.tsx and
// views/ only read it. Every section is independent: a failing section
// reports its own error and the rest still render.

export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

export interface FileChange {
  path: string;
  status: string;
  insertions: number | null;
  deletions: number | null;
}

export interface EnvironmentInfo {
  id: string;
  name: string | null;
  /** "managed-worktree" | "personal" | "unmanaged", or null when unknown. */
  kind: string | null;
  path: string | null;
  isWorktree: boolean;
  isGitRepo: boolean;
  branch: string | null;
  baseBranch: string | null;
}

export interface ChangesInfo {
  uncommitted: { files: FileChange[]; insertions: number; deletions: number };
  /** Committed on this branch but not on its merge base. Null off a branch. */
  branch: {
    base: string;
    ahead: number;
    behind: number;
    insertions: number;
    deletions: number;
    commits: { shortSha: string; subject: string }[];
  } | null;
}

export type ChecksState = "passing" | "failing" | "pending" | "none";
export type ReviewState = "approved" | "changes_requested" | "review_required" | "none";

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: PrState;
  /** bb's single most important reason to look at the PR. */
  attention: string;
  checks: { state: string; passed: number; failed: number; pending: number; total: number };
  review: string;
  mergeability: string;
  baseRefName: string;
}

export type PrState = "open" | "draft" | "merged" | "closed";

export interface StackPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: PrState;
  checks: ChecksState;
  review: ReviewState;
  isCurrent: boolean;
}

/** A GitHub stacked PR set, as `gh stack` and github.com show it. */
export interface StackInfo {
  /** The stack's number on GitHub (`gh stack checkout <number>`). */
  number: number;
  trunk: string;
  /** Top of the stack first. The PR closest to trunk is last. */
  prs: StackPr[];
}

export interface AgentInfo {
  status: string;
  goal: { objective: string; status: string } | null;
  todos: { total: number; done: number; current: string | null; items: { text: string; status: string }[] } | null;
  context: { usedTokens: number; windowTokens: number } | null;
  backgroundTasks: string[];
}

// ---- Subagents and schedules ----------------------------------------------

export interface Subagent {
  id: string;
  label: string;
  /** A BB child thread, or a subagent the provider delegated to within this thread. */
  kind: "thread" | "delegation";
  status: "pending" | "running" | "done" | "failed" | "stopped";
  /** Set for child threads, so the panel can open them. */
  threadId: string | null;
  providerId: string | null;
  summary: string | null;
  background: boolean;
  /** Epoch milliseconds; `endedAt` is null while it runs. */
  startedAt: number | null;
  endedAt: number | null;
}

export interface ScheduledItem {
  id: string;
  name: string;
  enabled: boolean;
  /** Plain English when possible: "Every 10 minutes". */
  schedule: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  lastRunThreadId: string | null;
  runCount: number;
  /** How it relates to this thread: it re-prompts it, or this thread created it. */
  relation: "targets" | "created";
}

// ---- Attachments --------------------------------------------------------

interface RefBase {
  /** Stable identity: two URLs for the same issue share one id. */
  id: string;
  label: string;
}

/** Something the thread refers to, before enrichment. */
export type AttachmentRef =
  | (RefBase & { kind: "linear"; url: string; identifier: string })
  | (RefBase & { kind: "notion"; url: string; pageId: string })
  | (RefBase & { kind: "github"; url: string; repo: string; number: number; isPull: boolean })
  | (RefBase & { kind: "figma" | "slack" | "web"; url: string })
  | (RefBase & { kind: "image"; url: string; path?: undefined })
  | (RefBase & { kind: "image" | "file"; path: string; url?: undefined });

export type AttachmentKind = AttachmentRef["kind"];

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  state: { name: string; color: string; type: string } | null;
  priority: number;
  priorityLabel: string;
  assignee: { name: string; avatarUrl: string | null } | null;
  labels: { name: string; color: string }[];
  team: string | null;
  project: string | null;
  cycle: string | null;
  estimate: number | null;
  dueDate: string | null;
  /** Markdown, truncated. */
  description: string | null;
  children: { identifier: string; title: string; stateType: string | null }[];
  links: { title: string; url: string }[];
  updatedAt: string;
}

export interface NotionPage {
  title: string;
  url: string;
  /** An emoji character, or an image URL for uploaded and custom icons. */
  icon: { emoji: string } | { imageUrl: string } | null;
  coverUrl: string | null;
  lastEditedAt: string;
  excerpt: string | null;
}

export interface GithubItem {
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  author: { login: string; avatarUrl: string | null } | null;
  labels: { name: string; color: string }[];
  comments: number;
  updatedAt: string;
  excerpt: string | null;
}

export interface WebPreview {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

export type AttachmentDetail =
  | { kind: "linear"; issue: LinearIssue }
  | { kind: "notion"; page: NotionPage }
  | { kind: "github"; item: GithubItem }
  | { kind: "web"; preview: WebPreview };

export interface Attachment {
  ref: AttachmentRef;
  /** Where it came from: a message link, the branch name, or thread storage. */
  origin: "message" | "branch" | "storage";
  /** Rich data, once fetched. Null while loading or when none is available. */
  detail: AttachmentDetail | null;
  /** Why enrichment is unavailable, such as a missing Linear API key. */
  hint: string | null;
}

export interface AttachmentsInfo {
  items: Attachment[];
  /** True while enrichment is still fetching; the panel refreshes after. */
  enriching: boolean;
  storageTruncated: boolean;
}

export interface Snapshot {
  threadId: string;
  fetchedAt: string;
  environment: Section<EnvironmentInfo | null>;
  changes: Section<ChangesInfo | null>;
  pullRequest: Section<PullRequestInfo | null>;
  stack: Section<StackInfo | null>;
  agent: Section<AgentInfo>;
  subagents: Section<Subagent[]>;
  scheduled: Section<ScheduledItem[]>;
  attachments: Section<AttachmentsInfo>;
  /** Tiles from sub-plugins: script widgets and other bb plugins. */
  widgets: Section<import("./widgets.ts").Widget[]>;
}
