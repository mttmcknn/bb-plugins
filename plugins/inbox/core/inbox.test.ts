import assert from "node:assert/strict";
import { test } from "vitest";
import {
  dateBucket,
  groupByDate,
  groupByStack,
  type InboxStack,
  type InboxStackPr,
  type InboxThreadFields,
} from "./inbox.ts";

const NOW = new Date(2026, 8, 23, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

function thread(id: string, updatedAt: number, extra: Partial<InboxThreadFields> = {}) {
  return {
    id,
    updatedAt,
    isPinned: false,
    isArchived: false,
    hasPendingInteraction: false,
    status: "idle",
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    ...extra,
  };
}

function pr(number: number, threadId: string | null): InboxStackPr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    isDraft: false,
    checks: "none",
    review: "none",
    conflicts: false,
    threadId,
  };
}

test("dateBucket uses local calendar days", () => {
  assert.equal(dateBucket(new Date(2026, 8, 23, 0, 1).getTime(), NOW).label, "Today");
  assert.equal(dateBucket(new Date(2026, 8, 22, 23, 59).getTime(), NOW).label, "Yesterday");
  assert.equal(dateBucket(new Date(2026, 8, 22, 0, 0).getTime(), NOW).label, "Yesterday");
  assert.equal(dateBucket(new Date(2026, 8, 17, 9).getTime(), NOW).id, "week");
  assert.equal(dateBucket(new Date(2026, 8, 1, 9).getTime(), NOW).id, "month");
  assert.equal(dateBucket(new Date(2026, 6, 4).getTime(), NOW).id, "2026-6");
  assert.match(dateBucket(new Date(2025, 6, 4).getTime(), NOW).label, /2025/);
});

test("groupByDate puts active and pinned first and drops archived", () => {
  const groups = groupByDate(
    [
      thread("old", NOW - 30 * HOUR),
      thread("today", NOW - HOUR),
      thread("running", NOW - 50 * HOUR, { status: "active" }),
      thread("asking", NOW - 2 * HOUR, { hasPendingInteraction: true }),
      thread("pinned", NOW - 3 * HOUR, { isPinned: true }),
      thread("gone", NOW, { isArchived: true }),
      thread("hidden", NOW, { isHidden: true }),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((group) => [group.id, group.threads.map((t) => t.id)]),
    [
      ["active", ["asking", "running"]],
      ["pinned", ["pinned"]],
      ["today", ["today"]],
      ["yesterday", ["old"]],
    ],
  );
});

test("groupByStack groups threads in merge order and orders stacks by recency", () => {
  const stacks: InboxStack[] = [
    { id: "a", title: "Stack A", repo: "o/r", base: "main", prs: [pr(1, "t1"), pr(2, "t2"), pr(3, "t1"), pr(4, null)] },
    { id: "b", title: "Stack B", repo: "o/r", base: "main", prs: [pr(5, "t3")] },
    { id: "c", title: "Only archived", repo: "o/r", base: "main", prs: [pr(6, "t4")] },
  ];
  const result = groupByStack(
    [
      thread("t1", NOW - 5 * HOUR),
      thread("t2", NOW - 4 * HOUR),
      thread("t3", NOW - HOUR),
      thread("t4", NOW, { isArchived: true }),
      thread("loose", NOW - 2 * HOUR),
    ],
    stacks,
  );
  assert.deepEqual(
    result.stacks.map((group) => [
      group.stack.id,
      group.rows.map((row) => [row.thread.id, row.prs.map((p) => p.number)]),
      group.unlinkedPrCount,
    ]),
    [
      ["b", [["t3", [5]]], 0],
      ["a", [["t1", [1, 3]], ["t2", [2]]], 1],
    ],
  );
  assert.deepEqual(result.unstacked.map((t) => t.id), ["loose"]);
});
