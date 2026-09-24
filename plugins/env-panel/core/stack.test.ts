import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStack, checksFromRollupState, parsePullUrl, prState, type StackPullRequest } from "./stack.ts";

const pull = (number: number, state: StackPullRequest["state"] = "draft"): StackPullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  headRefName: `branch-${number}`,
  state,
});

test("shows GitHub's bottom-first stack top first and marks the current PR", () => {
  const stack = buildStack({
    number: 162,
    trunk: "master",
    pulls: [pull(149, "merged"), pull(150), pull(151)],
    statuses: new Map([[150, { checks: "failing", review: "approved" }]]),
    currentNumber: 150,
  });
  assert.deepEqual(stack.prs.map((pr) => pr.number), [151, 150, 149]);
  assert.deepEqual(stack.prs.filter((pr) => pr.isCurrent).map((pr) => pr.number), [150]);
  assert.equal(stack.prs[1]?.checks, "failing");
  assert.equal(stack.prs[0]?.checks, "none");
});

test("derives the display state from REST fields", () => {
  assert.equal(prState({ state: "open", draft: true, merged_at: null }), "draft");
  assert.equal(prState({ state: "open", draft: false, merged_at: null }), "open");
  assert.equal(prState({ state: "closed", draft: false, merged_at: "2026-09-01T00:00:00Z" }), "merged");
  assert.equal(prState({ state: "closed", draft: false, merged_at: null }), "closed");
});

test("parses pull request URLs", () => {
  assert.deepEqual(parsePullUrl("https://github.com/acme/app/pull/154"), { repo: "acme/app", number: 154 });
  assert.equal(parsePullUrl("https://github.com/acme/app/issues/1"), null);
});

test("maps rollup states", () => {
  assert.equal(checksFromRollupState("SUCCESS"), "passing");
  assert.equal(checksFromRollupState("ERROR"), "failing");
  assert.equal(checksFromRollupState("EXPECTED"), "pending");
  assert.equal(checksFromRollupState(undefined), "none");
});
