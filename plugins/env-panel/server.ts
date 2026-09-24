// bb-plugin-env-panel — backend entry.
//
// Builds one snapshot per thread for the floating Environment panel: git
// changes, the branch's PR, its GitHub stack, agent progress, and attachments: Linear tickets, Notion docs, GitHub
// items, web links, images, and files the thread refers to, enriched with
// rich details in the background. Each section loads independently so one
// slow or failing source never blanks the panel.
import {
  defineRpcContract,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { cached, fetchStack } from "./core/cli.ts";
import { extractLinks, isImagePath, linearKeysFromBranch, storageAttachments } from "./core/attachments.ts";
import {
  fetchGithubItem,
  fetchImageDataUrl,
  fetchLinearIssue,
  fetchNotionPage,
  fetchWebPreview,
  IMAGE_BYTES_MAX,
} from "./core/enrich.ts";
import { createEnrichment } from "./core/enrichment.ts";
import { parsePullUrl } from "./core/stack.ts";
import type {
  AgentInfo,
  Attachment,
  AttachmentRef,
  AttachmentsInfo,
  ChangesInfo,
  EnvironmentInfo,
  PullRequestInfo,
  Section,
  Snapshot,
  StackInfo,
} from "./core/types.ts";

export type * from "./core/types.ts";

const threadIdSchema = z.string().regex(/^thr_[A-Za-z0-9]+$/u);

// The snapshot is server-built and trusted, so its output schema is a
// passthrough; inputs are what the boundary must check.
const snapshotSchema = z.custom<Snapshot>((value) => typeof value === "object" && value !== null);
const messageSchema = z.object({ message: z.string() });

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ threadId: threadIdSchema, force: z.boolean().optional() }).strict(),
    output: snapshotSchema,
  },
  commit: { input: z.object({ threadId: threadIdSchema }).strict(), output: messageSchema },
  markReady: { input: z.object({ threadId: threadIdSchema }).strict(), output: messageSchema },
  thumbnail: {
    input: z
      .object({
        threadId: threadIdSchema,
        source: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("url"), url: z.string().url().max(4_000) }),
          z.object({ kind: z.literal("file"), path: z.string().min(1).max(1_000) }),
        ]),
      })
      .strict(),
    output: z.object({ dataUrl: z.string().nullable() }),
  },
  askAgent: {
    input: z
      .object({ threadId: threadIdSchema, action: z.enum(["submit-stack", "fix-checks", "address-review", "restack"]) })
      .strict(),
    output: messageSchema,
  },
});

/** Realtime channel: a thread's panel data probably changed. */
export const THREAD_CHANGED = "thread-changed";

const ASK_AGENT_PROMPTS = {
  "submit-stack":
    "Push this GitHub stack and open PRs for any new branches: run `gh stack submit --auto` (non-interactive; never run `gh stack view` without `--json`). If the branch is not tracked locally, run `gh stack checkout <pr-number>` first. Then report each PR URL and whether it is still a draft.",
  "fix-checks":
    "CI is failing on this branch's pull request. Find the failing checks with `gh pr checks`, read the logs, fix the cause, and push the fix.",
  "address-review":
    "Read the unresolved review comments on this branch's pull request and address them in code. Do not reply to reviewers.",
  restack:
    "Sync this GitHub stack: run `gh stack sync --prune`. If it exits with code 3, resolve the conflicts, `git add` the files, and run `gh stack rebase --continue` until it finishes. Then summarize what moved and which PRs merged.",
} as const;

const LINK_LIMIT = 60;
const SOURCE_EVENT_PAGES = 4;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    showInThreadInfo: {
      type: "boolean",
      label: "Add sections to Thread info",
      description: "Shows the stack and attachments in BB's Thread info tab, above Thread storage.",
      default: true,
    },
    showStack: {
      type: "boolean",
      label: "Show the GitHub stack",
      description: "Reads the branch PR's stacked PRs with the GitHub CLI (`gh`).",
      default: true,
    },
    linearApiKey: {
      type: "string",
      label: "Linear API key",
      description:
        "A personal API key from Linear (Settings → Security & access → Personal API keys). Shows ticket status, assignee, and description for Linear links and branch names.",
      default: "",
      secret: true,
    },
    showLinkPreviews: {
      type: "boolean",
      label: "Show web link previews",
      description: "Fetches the title, description, and image of linked web pages from this machine.",
      default: true,
    },
  });

  // gh is slow and rate-limited: share results across threads.
  const stackCache = cached<StackInfo | null>(60_000);

  const changed = (threadId: string) => bb.realtime.publish(THREAD_CHANGED, { threadId });

  const enrichment = createEnrichment({
    fetchers: { linear: fetchLinearIssue, notion: fetchNotionPage, github: fetchGithubItem, web: fetchWebPreview },
    linearApiKey: async () => ((await settings.get()).linearApiKey ?? "").trim(),
    linkPreviews: async () => (await settings.get()).showLinkPreviews,
    onReady: (threadIds) => threadIds.forEach(changed),
  });
  bb.onDispose(() => enrichment.dispose());
  settings.onChange((next, previous) => {
    if (next.linearApiKey !== previous.linearApiKey) enrichment.invalidate();
  });

  /** Images each thread's last snapshot showed: the only ones `thumbnail` serves. */
  const thumbnailSources = new Map<string, { urls: Set<string>; paths: Set<string> }>();
  const thumbnails = cached<string | null>(30 * 60_000);

  // ---- Sections ---------------------------------------------------------

  async function loadEnvironment(environmentId: string | null): Promise<EnvironmentInfo | null> {
    if (environmentId === null) return null;
    const env = await bb.sdk.environments.get({ environmentId });
    return {
      id: env.id,
      name: env.name,
      kind: env.workspaceProvisionType,
      path: env.path,
      isWorktree: env.isWorktree,
      isGitRepo: env.isGitRepo,
      branch: env.branchName,
      baseBranch: env.mergeBaseBranch ?? env.baseBranch ?? env.defaultBranch,
    };
  }

  async function loadChanges(env: EnvironmentInfo | null): Promise<ChangesInfo | null> {
    if (env === null || !env.isGitRepo) return null;
    const status = await bb.sdk.environments.status({ environmentId: env.id });
    if (status.outcome === "not_applicable") return null;
    if (status.outcome === "unavailable") throw new Error(status.failure.message);
    const { workingTree, mergeBase } = status.workspace;
    return {
      uncommitted: {
        files: workingTree.files,
        insertions: workingTree.insertions,
        deletions: workingTree.deletions,
      },
      branch:
        mergeBase === null
          ? null
          : {
              base: mergeBase.mergeBaseBranch,
              ahead: mergeBase.aheadCount,
              behind: mergeBase.behindCount,
              insertions: mergeBase.insertions,
              deletions: mergeBase.deletions,
              commits: mergeBase.commits.slice(0, 20).map((commit) => ({
                shortSha: commit.shortSha,
                subject: commit.subject,
              })),
            },
    };
  }

  async function loadPullRequest(env: EnvironmentInfo | null): Promise<PullRequestInfo | null> {
    if (env === null || !env.isGitRepo || env.branch === null) return null;
    const result = await bb.sdk.environments.pullRequest({ environmentId: env.id });
    if (result.outcome === "absent") return null;
    if (result.outcome === "unavailable") throw new Error(result.message);
    const pr = result.pullRequest;
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      attention: pr.attention,
      checks: {
        state: pr.checks.state,
        passed: pr.checks.passedCount,
        failed: pr.checks.failedCount,
        pending: pr.checks.pendingCount,
        total: pr.checks.totalCount,
      },
      review: pr.review.state,
      mergeability: pr.mergeability.state,
      baseRefName: pr.baseRefName,
    };
  }

  async function loadStack(pr: PullRequestInfo | null, force: boolean): Promise<StackInfo | null> {
    const { showStack } = await settings.get();
    const target = pr === null ? null : parsePullUrl(pr.url);
    if (!showStack || target === null) return null;
    return stackCache(`${target.repo}#${target.number}`, () => fetchStack(target.repo, target.number), force);
  }

  async function loadAgent(threadId: string, status: string): Promise<AgentInfo> {
    const timeline = await bb.sdk.threads.timeline({ threadId, summaryOnly: "true", segmentLimit: "1" });
    const todos = timeline.pendingTodos;
    const usage = timeline.contextWindowUsage;
    return {
      status,
      goal:
        timeline.goal === null ? null : { objective: timeline.goal.objective, status: timeline.goal.status },
      todos:
        todos === null || todos.items.length === 0
          ? null
          : {
              total: todos.items.length,
              done: todos.items.filter((item) => item.status === "completed").length,
              current: todos.items.find((item) => item.status === "in_progress")?.text ?? null,
              items: todos.items.map((item) => ({ text: item.text, status: item.status })),
            },
      context:
        usage === undefined ? null : { usedTokens: usage.usedTokens, windowTokens: usage.modelContextWindow },
      backgroundTasks: timeline.activeBackgroundCommands
        .filter((command) => command.completedAt === null)
        .map((command) => command.description),
    };
  }

  async function loadMessageTexts(threadId: string): Promise<string[]> {
    // The events API pages at most 100 rows; read the newest few pages.
    const rows: Awaited<ReturnType<typeof bb.sdk.threads.events.list>> = [];
    for (let page = 0; page < SOURCE_EVENT_PAGES; page += 1) {
      const batch = await bb.sdk.threads.events.list({
        threadId,
        types: ["item/completed", "client/turn/requested"],
        order: "desc",
        limit: "100",
        beforeSeq: rows.length === 0 ? undefined : String(rows[rows.length - 1]!.seq),
      });
      rows.push(...batch);
      if (batch.length < 100) break;
    }
    const texts: string[] = [];
    for (const row of rows) {
      const data = row.data as { item?: { type?: string }; input?: unknown };
      if (row.type === "client/turn/requested") texts.push(JSON.stringify(data.input ?? ""));
      else if (data.item?.type === "agentMessage" || data.item?.type === "userMessage") {
        texts.push(JSON.stringify(data.item));
      }
    }
    // Rows arrive newest first; callers want oldest first.
    return texts.reverse();
  }

  async function loadAttachments(threadId: string, env: EnvironmentInfo | null): Promise<AttachmentsInfo> {
    const [texts, storage] = await Promise.all([
      loadMessageTexts(threadId),
      bb.sdk.threads.storageFiles({ threadId, limit: "100" }),
    ]);
    const links = extractLinks(texts, LINK_LIMIT);
    const linked = new Set(links.map((ref) => ref.id));
    const branchKeys: AttachmentRef[] = linearKeysFromBranch(env?.branch ?? null)
      .filter((key) => !linked.has(`linear:${key}`))
      .map((key) => ({ id: `linear:${key}`, kind: "linear", url: `https://linear.app/issue/${key}`, label: key, identifier: key }));

    let enriching = false;
    const enrich = (ref: AttachmentRef, origin: Attachment["origin"]): Attachment | null => {
      const result = enrichment.get(ref, threadId);
      enriching ||= result.pending;
      // A branch-name key is only a guess: show it once Linear confirms it.
      if (origin === "branch" && result.detail === null) return null;
      return { ref, origin, detail: result.detail, hint: result.hint };
    };
    const items = [
      ...branchKeys.map((ref) => enrich(ref, "branch")),
      ...links.map((ref) => enrich(ref, "message")),
      ...storageAttachments(storage.files).map((ref) => enrich(ref, "storage")),
    ].filter((item): item is Attachment => item !== null);

    rememberThumbnails(threadId, items);
    return { items, enriching, storageTruncated: storage.truncated };
  }

  function rememberThumbnails(threadId: string, items: readonly Attachment[]) {
    const urls = new Set<string>();
    const paths = new Set<string>();
    const add = (url: string | null | undefined) => {
      if (url) urls.add(url);
    };
    for (const { ref, detail } of items) {
      if (ref.kind === "image") {
        if (ref.path !== undefined) paths.add(ref.path);
        else add(ref.url);
      }
      if (detail?.kind === "linear") add(detail.issue.assignee?.avatarUrl);
      if (detail?.kind === "notion") {
        add(detail.page.coverUrl);
        if (detail.page.icon !== null && "imageUrl" in detail.page.icon) add(detail.page.icon.imageUrl);
      }
      if (detail?.kind === "github") add(detail.item.author?.avatarUrl);
      if (detail?.kind === "web") add(detail.preview.imageUrl);
    }
    thumbnailSources.set(threadId, { urls, paths });
  }

  async function loadThumbnail(
    threadId: string,
    source: { kind: "url"; url: string } | { kind: "file"; path: string },
  ): Promise<string | null> {
    const allowed = thumbnailSources.get(threadId);
    if (source.kind === "url") {
      if (!allowed?.urls.has(source.url)) return null;
      return thumbnails(source.url, () => fetchImageDataUrl(source.url));
    }
    if (!allowed?.paths.has(source.path) || !isImagePath(source.path) || source.path.split("/").includes("..")) return null;
    return thumbnails(`${threadId}:${source.path}`, async () => {
      const location = await bb.sdk.threads.storageLocation({ threadId });
      const root = location.storageRootPath.replace(/\/$/u, "");
      const file = await bb.sdk.files.read({ hostId: location.hostId, rootPath: root, path: `${root}/${source.path}` });
      if (file.sizeBytes > IMAGE_BYTES_MAX) return null;
      const type = file.mimeType ?? (source.path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png");
      const base64 = file.contentEncoding === "base64" ? file.content : Buffer.from(file.content, "utf8").toString("base64");
      return `data:${type};base64,${base64}`;
    });
  }

  async function buildSnapshot(threadId: string, force: boolean): Promise<Snapshot> {
    const thread = await bb.sdk.threads.get({ threadId });
    const environment = await section(() => loadEnvironment(thread.environmentId));
    const env = environment.ok ? environment.value : null;

    const [changes, pullRequest, agent] = await Promise.all([
      section(() => loadChanges(env)),
      section(() => loadPullRequest(env)),
      section(() => loadAgent(threadId, thread.status)),
    ]);
    const stack = await section(() => loadStack(pullRequest.ok ? pullRequest.value : null, force));
    if (force) enrichment.invalidate();
    const attachments = await section(() => loadAttachments(threadId, env));

    return {
      threadId,
      fetchedAt: new Date().toISOString(),
      environment,
      changes,
      pullRequest,
      stack,
      agent,
      attachments,
    };
  }

  async function environmentIdFor(threadId: string): Promise<string> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) throw new Error("This thread has no environment yet.");
    return thread.environmentId;
  }

  // A finished turn usually means new commits, a new PR, or new links.
  bb.events.on("thread.idle", ({ thread }) => changed(thread.id));

  // ---- RPC --------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    snapshot: ({ threadId, force }) => buildSnapshot(threadId, force === true),
    commit: async ({ threadId }) => {
      const result = await bb.sdk.environments.commit({ environmentId: await environmentIdFor(threadId) });
      changed(threadId);
      return { message: `Committed ${result.commitSha.slice(0, 7)}: ${result.commitSubject}` };
    },
    markReady: async ({ threadId }) => {
      const result = await bb.sdk.environments.markPullRequestReady({
        environmentId: await environmentIdFor(threadId),
      });
      changed(threadId);
      return { message: result.message };
    },
    thumbnail: async ({ threadId, source }) => ({
      dataUrl: await loadThumbnail(threadId, source).catch((error: unknown) => {
        bb.log.warn(`thumbnail failed for ${source.kind === "url" ? source.url : source.path}: ${errorMessage(error)}`);
        return null;
      }),
    }),
    askAgent: async ({ threadId, action }) => {
      await bb.sdk.threads.send({
        threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: ASK_AGENT_PROMPTS[action], mentions: [] }],
      });
      return { message: "Sent to the agent." };
    },
  });

  // ---- CLI --------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb env-panel [<thread-id>] [--refresh] [--json]",
    "",
    "Prints the Environment panel for a thread: changes, PR, stack, agent",
    "progress, and attachments. Defaults to $BB_THREAD_ID.",
  ].join("\n");

  function formatSnapshot(snapshot: Snapshot): string {
    const lines: string[] = [];
    const add = <T>(title: string, value: Section<T>, render: (value: T) => string[]) => {
      const body = value.ok ? render(value.value) : [`error: ${value.error}`];
      if (body.length > 0) lines.push(title, ...body.map((line) => `  ${line}`));
    };
    add("Environment", snapshot.environment, (env) =>
      env === null ? ["none"] : [`${env.name ?? env.kind ?? "workspace"}  ${env.path ?? ""}`, `branch: ${env.branch ?? "—"}`],
    );
    add("Changes", snapshot.changes, (changes) => {
      if (changes === null) return [];
      const { uncommitted, branch } = changes;
      const out = [`uncommitted: ${uncommitted.files.length} files +${uncommitted.insertions} -${uncommitted.deletions}`];
      if (branch !== null) {
        out.push(`branch vs ${branch.base}: ${branch.ahead} ahead, ${branch.behind} behind, +${branch.insertions} -${branch.deletions}`);
      }
      return out;
    });
    add("Pull request", snapshot.pullRequest, (pr) =>
      pr === null ? [] : [`#${pr.number} ${pr.title}`, `${pr.state} · ${pr.attention} · checks ${pr.checks.state} · ${pr.url}`],
    );
    add("Stack", snapshot.stack, (stack) =>
      stack === null
        ? []
        : [
            `stack #${stack.number} on ${stack.trunk}, top first:`,
            ...stack.prs.map((pr) => `${pr.isCurrent ? "▶" : " "} #${pr.number} ${pr.title} (${pr.state}, checks ${pr.checks})`),
          ],
    );
    add("Agent", snapshot.agent, (agent) => {
      const out = [`status: ${agent.status}`];
      if (agent.goal) out.push(`goal (${agent.goal.status}): ${agent.goal.objective}`);
      if (agent.todos) out.push(`todos: ${agent.todos.done}/${agent.todos.total}${agent.todos.current ? ` · now: ${agent.todos.current}` : ""}`);
      if (agent.context) out.push(`context: ${Math.round((agent.context.usedTokens / agent.context.windowTokens) * 100)}%`);
      return out;
    });
    add("Attachments", snapshot.attachments, ({ items, enriching }) => [
      ...items.map((item) => `${item.ref.kind.padEnd(7)} ${describeAttachment(item)}`),
      ...(enriching ? ["(still fetching details; run again for more)"] : []),
    ]);
    return lines.join("\n");
  }

  function describeAttachment({ ref, detail, hint }: Attachment): string {
    const where = ref.url ?? ("path" in ref ? ref.path : undefined) ?? "";
    switch (detail?.kind) {
      case "linear": {
        const { issue } = detail;
        return `${issue.identifier} ${issue.title} [${issue.state?.name ?? "?"}${issue.assignee ? ` · ${issue.assignee.name}` : ""}] ${issue.url}`;
      }
      case "notion":
        return `${detail.page.title} ${where}`;
      case "github":
        return `${ref.label} ${detail.item.title} [${detail.item.state}] ${where}`;
      case "web":
        return `${detail.preview.title ?? ref.label} ${where}`;
      default:
        return `${ref.label} ${where}${hint ? `  (${hint})` : ""}`;
    }
  }

  bb.cli.register({
    name: "env-panel",
    summary: "Show a thread's environment, PR, stack, and attachments",
    commands: [
      {
        name: "show",
        summary: "Print the Environment panel for a thread",
        usage: "bb env-panel [<thread-id>] [--refresh] [--json]",
      },
    ],
    async run(argv, context) {
      if (argv.includes("--help") || argv.includes("help")) return { exitCode: 0, stdout: usage };
      const positional = argv.filter((arg) => !arg.startsWith("--") && arg !== "show");
      const threadId = positional[0] ?? context?.threadId ?? process.env.BB_THREAD_ID;
      const parsed = threadIdSchema.safeParse(threadId);
      if (!parsed.success) return { exitCode: 1, stderr: `Pass a thread id (thr_…).\n\n${usage}` };
      const snapshot = await buildSnapshot(parsed.data, argv.includes("--refresh"));
      const stdout = argv.includes("--json") ? JSON.stringify(snapshot) : formatSnapshot(snapshot);
      return { exitCode: 0, stdout: stdout.slice(0, PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024) };
    },
  });
}
