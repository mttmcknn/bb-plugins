// Reads open pull requests through the GitHub CLI's GraphQL endpoint. One
// search returns every repository at once, with the head and base branches
// that stack detection needs.
import { execFile } from "node:child_process";
import { z } from "zod";
import {
  prKey,
  type ChecksState,
  type PullRequest,
  type Reviewer,
  type ReviewerState,
  type ReviewState,
} from "./stacks.ts";

const QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url state isDraft createdAt updatedAt
        headRefName baseRefName additions deletions
        reviewDecision mergeable
        repository { nameWithOwner }
        latestReviews(first: 10) { nodes { state author { login avatarUrl(size: 48) } } }
        reviewRequests(first: 10) { nodes { requestedReviewer {
          ... on User { login avatarUrl(size: 48) }
          ... on Bot { login avatarUrl(size: 48) }
          ... on Team { slug avatarUrl(size: 48) }
        } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts {
          checkRunCount statusContextCount
          checkRunCountsByState { state count }
          statusContextCountsByState { state count }
        } } } } }
      }
    }
  }
}`;

const countSchema = z.object({ state: z.string(), count: z.number() });

const nodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: z.number(),
  deletions: z.number(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  latestReviews: z.object({
    nodes: z.array(
      z.object({
        state: z.string(),
        author: z.object({ login: z.string(), avatarUrl: z.string() }).nullable(),
      }),
    ),
  }),
  reviewRequests: z.object({
    nodes: z.array(
      z.object({
        // Null for a reviewer type the query does not spread (e.g. a Mannequin).
        requestedReviewer: z
          .object({
            login: z.string().optional(),
            slug: z.string().optional(),
            avatarUrl: z.string().nullable().optional(),
          })
          .nullable(),
      }),
    ),
  }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({
              state: z.string(),
              contexts: z.object({
                checkRunCount: z.number(),
                statusContextCount: z.number(),
                checkRunCountsByState: z.array(countSchema),
                statusContextCountsByState: z.array(countSchema),
              }),
            })
            .nullable(),
        }),
      }),
    ),
  }),
});

const responseSchema = z.object({
  data: z.object({
    search: z.object({
      issueCount: z.number(),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
      // Non-PR search hits come back as empty objects; skip them.
      nodes: z.array(z.union([nodeSchema, z.object({}).strict()])),
    }),
  }),
});

/** GitHub caps search at 1,000 results; stop well before that. */
const MAX_PAGES = 6;

function checksState(rollup: string | undefined): ChecksState {
  switch (rollup) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

function reviewState(decision: string | null): ReviewState {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

// Check runs and commit statuses that have not produced a result yet.
const RUNNING_CHECK_RUN = new Set(["IN_PROGRESS", "PENDING", "QUEUED", "WAITING", "REQUESTED"]);
const RUNNING_STATUS = new Set(["PENDING", "EXPECTED"]);

type Rollup = NonNullable<z.infer<typeof nodeSchema>["commits"]["nodes"][number]["commit"]["statusCheckRollup"]>;

/** How many of a commit's checks have finished, counting runs and statuses. */
export function checkProgressFrom(contexts: Rollup["contexts"] | undefined): {
  finished: number;
  total: number;
} {
  if (contexts === undefined) return { finished: 0, total: 0 };
  const running = (counts: { state: string; count: number }[], states: Set<string>) =>
    counts.reduce((sum, { state, count }) => sum + (states.has(state) ? count : 0), 0);
  const total = contexts.checkRunCount + contexts.statusContextCount;
  const pending =
    running(contexts.checkRunCountsByState, RUNNING_CHECK_RUN) +
    running(contexts.statusContextCountsByState, RUNNING_STATUS);
  return { finished: Math.max(0, total - pending), total };
}

const REVIEW_STATE: Record<string, ReviewerState | undefined> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
};
const REVIEWER_ORDER: ReviewerState[] = ["changes_requested", "approved", "commented", "requested"];

/** Latest verdict per person, then pending requests, blocking reviews first. */
export function reviewersFrom(node: Pick<z.infer<typeof nodeSchema>, "latestReviews" | "reviewRequests">): Reviewer[] {
  const byLogin = new Map<string, Reviewer>();
  for (const review of node.latestReviews.nodes) {
    const state = REVIEW_STATE[review.state];
    if (state === undefined || review.author === null) continue;
    byLogin.set(review.author.login, { ...review.author, state });
  }
  for (const { requestedReviewer: who } of node.reviewRequests.nodes) {
    const login = who?.login ?? who?.slug;
    // A re-requested reviewer shows as pending again.
    if (login !== undefined) {
      byLogin.delete(login);
      byLogin.set(login, { login, avatarUrl: who?.avatarUrl ?? "", state: "requested" });
    }
  }
  return [...byLogin.values()].sort(
    (a, b) => REVIEWER_ORDER.indexOf(a.state) - REVIEWER_ORDER.indexOf(b.state),
  );
}

function run(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(Object.assign(error, { stderr: String(stderr).trim() }));
      },
    );
  });
}

// A GUI-launched server may not have Homebrew on PATH.
const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
let resolvedGh: string | null = null;

async function ghBinary(configured: string): Promise<string> {
  if (configured !== "") return configured;
  if (resolvedGh !== null) return resolvedGh;
  for (const candidate of GH_CANDIDATES) {
    try {
      await run(candidate, ["--version"]);
      resolvedGh = candidate;
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  throw new Error(
    "GitHub CLI not found. Install it (brew install gh) and run `gh auth login`, or set the plugin's gh path setting.",
  );
}

/** Take a draft out of draft with `gh pr ready`. */
export async function markReadyForReview(options: { url: string; ghPath: string }): Promise<void> {
  const gh = await ghBinary(options.ghPath);
  try {
    await run(gh, ["pr", "ready", options.url]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(`gh pr ready failed: ${stderr || (error as Error).message}`);
  }
}

export async function fetchPullRequests(options: {
  query: string;
  ghPath: string;
  signal?: AbortSignal;
}): Promise<{ prs: PullRequest[]; total: number }> {
  const gh = await ghBinary(options.ghPath);
  const prs: PullRequest[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${options.query}`];
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    let stdout: string;
    try {
      stdout = await run(gh, args, options.signal);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr;
      throw new Error(`gh api graphql failed: ${stderr || (error as Error).message}`);
    }
    const { search } = responseSchema.parse(JSON.parse(stdout)).data;
    total = search.issueCount;
    for (const hit of search.nodes) {
      if (!("number" in hit)) continue;
      const node = hit as z.infer<typeof nodeSchema>;
      const repo = node.repository.nameWithOwner;
      prs.push({
        key: prKey(repo, node.number),
        repo,
        number: node.number,
        title: node.title,
        url: node.url,
        state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
        isDraft: node.isDraft,
        headRefName: node.headRefName,
        baseRefName: node.baseRefName,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        additions: node.additions,
        deletions: node.deletions,
        checks: checksState(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
        checkProgress: checkProgressFrom(node.commits.nodes[0]?.commit.statusCheckRollup?.contexts),
        review: reviewState(node.reviewDecision),
        reviewers: reviewersFrom(node),
        conflicts: node.mergeable === "CONFLICTING",
      });
    }
    if (!search.pageInfo.hasNextPage || search.pageInfo.endCursor === null) break;
    cursor = search.pageInfo.endCursor;
  }
  return { prs, total };
}
