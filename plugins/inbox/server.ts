// bb-plugin-inbox — backend entry.
//
// The sidebar list itself lives in app.tsx and reads threads from the host.
// This server only answers one question for the Stacks view: which open PR
// stacks exist, and which thread owns each PR. The PR Stacks plugin already
// fetches PRs and matches them to threads, so this asks it over plugin RPC
// and narrows its snapshot to what a sidebar row needs.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { InboxStack } from "./core/inbox.ts";

const PR_STACKS_PLUGIN_ID = "pr-stacks";

// `sidebar.threadListProvider` values: `<pluginId>/<threadList slot id>`.
const LIST_PROVIDERS = { inbox: "inbox/inbox", bb: "thread-list/thread-list" } as const;
const LIST_PREFERENCE = "sidebar.threadListProvider";
const sidebarListSchema = z.enum(["inbox", "bb"]);
export type SidebarList = z.infer<typeof sidebarListSchema>;

export interface StacksResult {
  /** False when the PR Stacks plugin is missing, disabled, or failing. */
  available: boolean;
  error: string | null;
  fetchedAt: string | null;
  stacks: InboxStack[];
}

// The subset of PR Stacks' snapshot this plugin reads. Unknown keys pass
// through untouched, so its additions do not break this parse.
const prSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  checks: z.enum(["passing", "failing", "pending", "none"]).catch("none"),
  review: z.enum(["approved", "changes_requested", "review_required", "none"]).catch("none"),
  conflicts: z.boolean(),
});
const snapshotSchema = z.object({
  fetchedAt: z.string().nullable(),
  error: z.string().nullable(),
  repos: z.array(
    z.object({
      stacks: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          repo: z.string(),
          base: z.string(),
          rows: z.array(
            z.object({
              pr: prSchema,
              thread: z.object({ id: z.string() }).nullable(),
            }),
          ),
        }),
      ),
    }),
  ),
});

const stacksResultSchema = z.custom<StacksResult>(
  (value) => typeof value === "object" && value !== null,
);

export const rpcContract = defineRpcContract({
  stacks: { input: z.null(), output: stacksResultSchema },
  /** Which list fills the sidebar; "other" is a third plugin's list. */
  sidebarList: {
    input: z.null(),
    output: z.object({ list: z.enum(["inbox", "bb", "other"]) }),
  },
  setSidebarList: {
    input: z.object({ list: sidebarListSchema }).strict(),
    output: z.object({ list: sidebarListSchema }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  async function stacks(): Promise<StacksResult> {
    try {
      const snapshot = await bb.sdk.plugins.callRpc({
        pluginId: PR_STACKS_PLUGIN_ID,
        method: "snapshot",
        input: null,
        outputSchema: snapshotSchema,
      });
      return {
        available: true,
        error: snapshot.error,
        fetchedAt: snapshot.fetchedAt,
        stacks: snapshot.repos.flatMap((repo) =>
          repo.stacks.map((stack) => ({
            id: stack.id,
            title: stack.title,
            repo: stack.repo,
            base: stack.base,
            prs: stack.rows.map((row) => ({ ...row.pr, threadId: row.thread?.id ?? null })),
          })),
        ),
      };
    } catch (error) {
      bb.log.warn(`PR Stacks snapshot failed: ${(error as Error).message}`);
      return {
        available: false,
        error: (error as Error).message,
        fetchedAt: null,
        stacks: [],
      };
    }
  }

  async function currentList() {
    const { preferences } = await bb.sdk.system.uiPreferences.list();
    const entry = preferences[LIST_PREFERENCE];
    const list =
      entry.value === LIST_PROVIDERS.inbox ? "inbox" : entry.value === LIST_PROVIDERS.bb ? "bb" : "other";
    return { list, revision: entry.revision } as const;
  }

  bb.rpc.register(rpcContract, {
    stacks,
    sidebarList: async () => ({ list: (await currentList()).list }),
    setSidebarList: async ({ list }) => {
      // The preference is revisioned; set against the revision just read.
      const { revision } = await currentList();
      await bb.sdk.system.uiPreferences.set({
        key: LIST_PREFERENCE,
        value: LIST_PROVIDERS[list],
        expectedRevision: revision,
      });
      return { list };
    },
  });
}
