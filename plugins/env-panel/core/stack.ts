// Pure GitHub stacked-PR logic: no bb, no gh, no I/O. GitHub lists a stack's
// pull requests bottom (closest to trunk) first; the panel shows them top first.
import type { ChecksState, PrState, ReviewState, StackInfo, StackPr } from "./types.ts";

export interface StackPullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: PrState;
}

export interface PrStatus {
  checks: ChecksState;
  review: ReviewState;
}

export function checksFromRollupState(state: string | null | undefined): ChecksState {
  switch (state) {
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

export function reviewFromDecision(decision: string | null | undefined): ReviewState {
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

/** REST pull state plus draft and merge flags, as one display state. */
export function prState(pull: { state: string; draft: boolean; merged_at: string | null }): PrState {
  if (pull.merged_at !== null) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

/** `owner/repo` and number from a pull request URL, or null. */
export function parsePullUrl(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/u.exec(url);
  return match === null ? null : { repo: match[1]!, number: Number(match[2]) };
}

export function buildStack(options: {
  number: number;
  trunk: string;
  /** Bottom first, as GitHub returns them. */
  pulls: readonly StackPullRequest[];
  statuses: ReadonlyMap<number, PrStatus>;
  currentNumber: number;
}): StackInfo {
  const prs: StackPr[] = options.pulls.map((pull) => ({
    ...pull,
    checks: options.statuses.get(pull.number)?.checks ?? "none",
    review: options.statuses.get(pull.number)?.review ?? "none",
    isCurrent: pull.number === options.currentNumber,
  }));
  return { number: options.number, trunk: options.trunk, prs: prs.reverse() };
}
