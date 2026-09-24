import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, type DiffFile } from "./contract.js";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.rpc.register(rpcContract, {
    changes: async ({ threadId, scope }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId === null) {
        return { files: [], message: "This thread has no workspace yet." };
      }
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      if (environment.path === null || !environment.isGitRepo) {
        return { files: [], message: "This thread's workspace is not a Git repository." };
      }
      const baseBranch = environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch;
      if (scope !== "last-turn") {
        return host.call("snapshot", {
          directory: environment.path, scope, baseBranch,
        }, { hostId: environment.hostId });
      }
      const timeline = await bb.sdk.threads.timeline({ threadId, segmentLimit: "20" });
      const lastTurnId = [...timeline.rows].reverse().find((row) => row.turnId !== null)?.turnId;
      if (lastTurnId === undefined || lastTurnId === null) {
        return { files: [], message: "No turn changes are recorded yet." };
      }
      const changed: { path: string; patch: string }[] = [];
      for (const row of timeline.rows) {
        if (row.turnId === lastTurnId && row.kind === "work" && row.workKind === "file-change" && row.change.diff) {
          changed.push({ path: row.change.path, patch: row.change.diff });
        }
      }
      const paths = [...new Set(changed.map((change) => change.path))];
      if (paths.length === 0) {
        return { files: [], message: "No file patches were recorded in the last turn." };
      }
      const current = await host.call("snapshot", {
        directory: environment.path, scope: "last-turn", baseBranch, paths,
      }, { hostId: environment.hostId });
      const previews = new Map(current.files.map((file) => [file.path, file.preview]));
      const files: DiffFile[] = changed.map((change) => ({
        path: change.path,
        patch: change.patch,
        preview: previews.get(change.path) ?? null,
        truncated: false,
      }));
      return { files, message: null };
    },
  });
}
