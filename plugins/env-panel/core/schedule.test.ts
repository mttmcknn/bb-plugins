import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, summarizeSubagents } from "./schedule.ts";

test("describes common cron shapes in English", () => {
  assert.equal(describeCron("*/10 * * * *"), "Every 10 minutes");
  assert.equal(describeCron("* * * * *"), "Every minute");
  assert.equal(describeCron("15 * * * *"), "Hourly at :15");
  assert.equal(describeCron("0 */2 * * *"), "Every 2 hours");
  assert.equal(describeCron("0 9 * * *"), "Daily at 9am");
  assert.equal(describeCron("30 14 * * 1-5"), "Weekdays at 2:30pm");
  assert.equal(describeCron("0 0 * * 1"), "Mondays at 12am");
  assert.equal(describeCron("5 4 1 * *"), "5 4 1 * *");
});

test("summarizes subagents with problems first", () => {
  assert.equal(
    summarizeSubagents([{ status: "done" }, { status: "running" }, { status: "done" }, { status: "failed" }]),
    "1 failed · 1 running · 2 done",
  );
  assert.equal(summarizeSubagents([]), "");
});
