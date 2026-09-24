import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnrichment, type Fetchers } from "./enrichment.ts";
import type { AttachmentRef, LinearIssue } from "./types.ts";

const linearRef: AttachmentRef = { id: "linear:ENG-1", kind: "linear", url: "https://linear.app/x/issue/ENG-1", label: "ENG-1", identifier: "ENG-1" };
const issue = { identifier: "ENG-1", title: "Fix login" } as LinearIssue;

function setup(overrides: Partial<Fetchers> = {}, apiKey = "key") {
  const ready: string[][] = [];
  const calls: string[] = [];
  const fetchers: Fetchers = {
    linear: async (id) => {
      calls.push(id);
      return issue;
    },
    notion: async () => {
      throw new Error("unused");
    },
    github: async () => {
      throw new Error("unused");
    },
    web: async () => null,
    ...overrides,
  };
  const enrichment = createEnrichment({
    fetchers,
    linearApiKey: async () => apiKey,
    linkPreviews: async () => true,
    onReady: (threads) => ready.push(threads),
  });
  return { enrichment, ready, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("returns nothing first, fetches once, then serves the cache", async () => {
  const { enrichment, ready, calls } = setup();
  assert.deepEqual(enrichment.get(linearRef, "thr_a"), { detail: null, hint: null, pending: true });
  enrichment.get(linearRef, "thr_b");
  await settle();
  assert.deepEqual(calls, ["ENG-1"]);
  assert.deepEqual(ready, [["thr_a", "thr_b"]]);
  const cached = enrichment.get(linearRef, "thr_a");
  assert.equal(cached.detail?.kind, "linear");
  assert.equal(cached.pending, false);
});

test("explains a missing Linear key instead of fetching", async () => {
  const { enrichment, calls } = setup({}, "");
  enrichment.get(linearRef, "thr_a");
  await settle();
  assert.deepEqual(calls, []);
  assert.match(enrichment.get(linearRef, "thr_a").hint ?? "", /Linear API key/u);
});

test("keeps a failure as a hint", async () => {
  const { enrichment } = setup({
    linear: async () => {
      throw new Error("Linear rejected the API key.");
    },
  });
  enrichment.get(linearRef, "thr_a");
  await settle();
  const result = enrichment.get(linearRef, "thr_a");
  assert.equal(result.detail, null);
  assert.equal(result.hint, "Linear rejected the API key.");
});
