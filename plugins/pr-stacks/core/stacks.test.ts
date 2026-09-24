import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRepoGroups,
  canMarkReady,
  deriveStackTitle,
  extractPrKeys,
  parsePrRef,
  prKey,
  type PullRequest,
} from "./stacks.ts";
import { checkProgressFrom, reviewersFrom } from "./github.ts";

function pr(
  repo: string,
  number: number,
  head: string,
  base: string,
  updatedAt = "2026-09-01",
  title = `PR ${number}`,
): PullRequest {
  return {
    key: prKey(repo, number),
    repo,
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    state: "open",
    isDraft: false,
    headRefName: head,
    baseRefName: base,
    createdAt: updatedAt,
    updatedAt,
    additions: 1,
    deletions: 1,
    checks: "passing",
    checkProgress: { finished: 1, total: 1 },
    review: "none",
    reviewers: [],
    conflicts: false,
  };
}

const noThread = () => null;

test("chains PRs by base branch in merge order", () => {
  const groups = buildRepoGroups(
    [
      pr("acme/app", 3, "c", "b"),
      pr("acme/app", 1, "a", "master"),
      pr("acme/app", 2, "b", "a"),
    ],
    noThread,
  );
  assert.equal(groups.length, 1);
  const [stack] = groups[0]!.stacks;
  assert.equal(stack!.base, "master");
  assert.deepEqual(
    stack!.rows.map((row) => [row.pr.number, row.position, row.depth]),
    [
      [1, 1, 0],
      [2, 2, 0],
      [3, 3, 0],
    ],
  );
});

test("indents only the branches of a fork", () => {
  const groups = buildRepoGroups(
    [
      pr("o/r", 1, "root", "main"),
      pr("o/r", 2, "left", "root"),
      pr("o/r", 3, "right", "root"),
      pr("o/r", 4, "left-2", "left"),
    ],
    noThread,
  );
  const rows = groups[0]!.stacks[0]!.rows;
  assert.deepEqual(
    rows.map((row) => [row.pr.number, row.depth, row.parentKey, row.branchesFrom]),
    [
      [1, 0, null, null],
      [2, 1, "o/r#1", null],
      [4, 1, "o/r#2", null],
      [3, 1, "o/r#1", 1],
    ],
  );
});

test("keeps repositories apart even when branch names collide", () => {
  const groups = buildRepoGroups(
    [pr("o/a", 1, "feature", "main"), pr("o/b", 2, "child", "feature")],
    noThread,
  );
  assert.equal(groups.length, 2);
  for (const group of groups) assert.equal(group.stacks.length, 1);
});

test("a base-branch cycle still emits every PR once", () => {
  const groups = buildRepoGroups([pr("o/r", 1, "a", "b"), pr("o/r", 2, "b", "a")], noThread);
  const numbers = groups[0]!.stacks.flatMap((stack) => stack.rows.map((row) => row.pr.number));
  assert.deepEqual(numbers.sort(), [1, 2]);
});

test("sorts repos and stacks by latest activity", () => {
  const groups = buildRepoGroups(
    [
      pr("o/old", 1, "x", "main", "2026-01-01"),
      pr("o/new", 2, "y", "main", "2026-02-01"),
      pr("o/new", 3, "z", "main", "2026-03-01"),
    ],
    noThread,
  );
  assert.deepEqual(groups.map((group) => group.repo), ["o/new", "o/old"]);
  assert.deepEqual(groups[0]!.stacks.map((stack) => stack.rows[0]!.pr.number), [3, 2]);
});

test("attaches thread refs from the lookup", () => {
  const groups = buildRepoGroups([pr("o/r", 7, "x", "main")], (candidate) =>
    candidate.number === 7 ? { id: "thr_1", title: "Work", archived: false, source: "branch" } : null,
  );
  assert.equal(groups[0]!.stacks[0]!.rows[0]!.thread?.id, "thr_1");
});

test("parses PR references and URLs", () => {
  assert.equal(parsePrRef("https://github.com/Acme/App/pull/89"), "acme/app#89");
  assert.equal(parsePrRef("acme/app#12"), "acme/app#12");
  assert.equal(parsePrRef("89"), null);
  assert.equal(parsePrRef("see https://github.com/o/r/pull/1"), null);
  assert.deepEqual(
    extractPrKeys(
      "Opened https://github.com/o/r/pull/1 and https://github.com/o/r/pull/2, then https://github.com/o/r/pull/1 again.",
    ),
    ["o/r#1", "o/r#2"],
  );
});

test("suggests a title from the tag and branch words most PRs share", () => {
  const cart = [
    pr("r/a", 1, "me/api-client-cleanup", "master", "x", "[networking] Clean up client"),
    pr("r/a", 2, "me/cart-avatar-fallback", "me/api-client-cleanup", "x", "[ui] Avatars"),
    pr("r/a", 3, "me/cart-shipping-options", "me/cart-avatar-fallback", "x", "[shop] Shipping"),
    pr("r/a", 4, "me/cart-payment-options", "me/cart-shipping-options", "x", "[shop] Payment"),
  ];
  assert.equal(deriveStackTitle(cart), "shop · cart");
  const search = [
    pr("r/a", 1, "me/store-search-icon", "master", "x", "[shop] Icon"),
    pr("r/a", 2, "me/store-search-section", "me/store-search-icon", "x", "[shop] Section"),
  ];
  assert.equal(deriveStackTitle(search), "shop · store search");
  const repeated = [
    pr("r/a", 1, "me/store-cart-shipping", "master", "x", "[store] Shipping"),
    pr("r/a", 2, "me/store-cart-payment", "me/store-cart-shipping", "x", "[store] Payment"),
  ];
  assert.equal(deriveStackTitle(repeated), "store · cart");
  assert.equal(deriveStackTitle([cart[0]!]), "");
});

test("prefers a stored name, then the linked thread, then the suggestion", () => {
  const prs = [
    pr("o/r", 1, "me/cart-a", "main", "x", "[shop] A"),
    pr("o/r", 2, "me/cart-b", "me/cart-a", "x", "[shop] B"),
  ];
  const thread = { id: "thr_1", title: "Build cart checkout", archived: false, source: "manual" as const };
  const named = buildRepoGroups(prs, () => thread, (keys) => (keys.includes("o/r#2") ? "Cart v2" : null));
  assert.deepEqual(
    [named[0]!.stacks[0]!.title, named[0]!.stacks[0]!.titleSource],
    ["Cart v2", "named"],
  );
  const fromThread = buildRepoGroups(prs, () => thread);
  assert.deepEqual(
    [fromThread[0]!.stacks[0]!.title, fromThread[0]!.stacks[0]!.titleSource],
    ["Build cart checkout", "thread"],
  );
  const derived = buildRepoGroups(prs, noThread);
  assert.deepEqual(
    [derived[0]!.stacks[0]!.title, derived[0]!.stacks[0]!.titleSource],
    ["shop · cart", "derived"],
  );
});

test("offers ready-for-review only for green, mergeable drafts", () => {
  const draft = { ...pr("o/r", 1, "a", "main"), isDraft: true };
  assert.equal(canMarkReady(draft), true);
  assert.equal(canMarkReady({ ...draft, checks: "pending" }), false);
  assert.equal(canMarkReady({ ...draft, checks: "none" }), false);
  assert.equal(canMarkReady({ ...draft, conflicts: true }), false);
  assert.equal(canMarkReady({ ...draft, isDraft: false }), false);
  assert.equal(canMarkReady({ ...draft, state: "merged" }), false);
});

test("orders reviewers by verdict and shows re-requests as pending", () => {
  const avatar = (login: string) => ({ login, avatarUrl: `https://a/${login}` });
  const result = reviewersFrom({
    latestReviews: {
      nodes: [
        { state: "APPROVED", author: avatar("amy") },
        { state: "COMMENTED", author: avatar("cal") },
        { state: "CHANGES_REQUESTED", author: avatar("bo") },
        { state: "DISMISSED", author: avatar("dee") },
        { state: "APPROVED", author: null },
        { state: "APPROVED", author: avatar("eve") },
      ],
    },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { slug: "android", avatarUrl: "https://a/team" } },
        { requestedReviewer: { login: "eve", avatarUrl: "https://a/eve" } },
        { requestedReviewer: null },
      ],
    },
  });
  assert.deepEqual(
    result.map((reviewer) => [reviewer.login, reviewer.state]),
    [
      ["bo", "changes_requested"],
      ["amy", "approved"],
      ["cal", "commented"],
      ["android", "requested"],
      ["eve", "requested"],
    ],
  );
});

test("counts finished checks across check runs and commit statuses", () => {
  assert.deepEqual(
    checkProgressFrom({
      checkRunCount: 7,
      statusContextCount: 4,
      checkRunCountsByState: [
        { state: "SUCCESS", count: 3 },
        { state: "IN_PROGRESS", count: 2 },
        { state: "QUEUED", count: 1 },
        { state: "SKIPPED", count: 1 },
      ],
      statusContextCountsByState: [
        { state: "SUCCESS", count: 3 },
        { state: "PENDING", count: 1 },
      ],
    }),
    { finished: 7, total: 11 },
  );
  assert.deepEqual(checkProgressFrom(undefined), { finished: 0, total: 0 });
});
