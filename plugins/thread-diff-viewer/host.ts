import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type DiffFile, type Scope } from "./contract.js";

const execute = promisify(execFile);
const MAX_FILES = 40;
const MAX_PATCH = 75_000;
const MAX_PREVIEW = 75_000;

async function git(directory: string, args: string[], allowDifference = false): Promise<string> {
  try {
    const result = await execute("git", ["-C", directory, "-c", "core.quotepath=false", ...args], {
      encoding: "utf8", maxBuffer: 8_000_000, timeout: 15_000,
    });
    return result.stdout;
  } catch (cause) {
    const error = cause as Error & { code?: number; stdout?: string; stderr?: string };
    if (allowDifference && error.code === 1) return error.stdout ?? "";
    throw new Error((error.stderr || error.message).trim());
  }
}

function safePath(directory: string, path: string): string | null {
  if (isAbsolute(path) || path.includes("\0")) return null;
  const full = resolve(directory, path);
  const rel = relative(directory, full);
  return rel === "" || rel === ".." || rel.startsWith(".." + sep) ? null : full;
}

async function workingPreview(directory: string, path: string): Promise<string | null> {
  if (!/\.(md|markdown|mdown|mdx)$/iu.test(path)) return null;
  const full = safePath(directory, path);
  if (full === null) return null;
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.size > MAX_PREVIEW) return null;
    const buffer = await readFile(full);
    return buffer.includes(0) ? null : buffer.toString("utf8");
  } catch {
    return null;
  }
}

async function gitPreview(directory: string, ref: string, path: string): Promise<string | null> {
  if (!/\.(md|markdown|mdown|mdx)$/iu.test(path)) return null;
  try {
    const content = await git(directory, ["show", ref + ":" + path]);
    return content.length <= MAX_PREVIEW && !content.includes("\0") ? content : null;
  } catch {
    return null;
  }
}

async function pathsFor(directory: string, args: string[]): Promise<string[]> {
  const output = await git(directory, ["diff", "--name-only", "-z", ...args]);
  return output.split("\0").filter(Boolean);
}

async function untrackedPaths(directory: string): Promise<string[]> {
  const output = await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return output.split("\0").filter(Boolean);
}

async function snapshot(directory: string, scope: Scope, baseBranch: string | null, paths?: string[]) {
  if (!isAbsolute(directory)) throw new Error("Workspace path must be absolute.");
  const topLevel = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(topLevel) !== await realpath(directory)) {
    throw new Error("The environment path is not the Git repository root.");
  }
  if (scope === "last-turn") {
    const files = await Promise.all((paths ?? []).slice(0, MAX_FILES).map(async (path): Promise<DiffFile> => ({
      path, patch: "", preview: await workingPreview(directory, path), truncated: false,
    })));
    return { files, message: null };
  }

  const hasHead = await git(directory, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
  let diffArgs: string[];
  if (scope === "staged") diffArgs = ["--cached"];
  else if (scope === "unstaged") diffArgs = [];
  else if (scope === "uncommitted") diffArgs = hasHead ? ["HEAD"] : ["--cached"];
  else {
    if (!hasHead) return { files: [], message: "This repository has no commits yet." };
    if (!baseBranch) return { files: [], message: "No base branch is configured for this environment." };
    const mergeBase = (await git(directory, ["merge-base", baseBranch, "HEAD"])).trim();
    diffArgs = scope === "committed" ? [mergeBase, "HEAD"] : [mergeBase];
  }

  const tracked = await pathsFor(directory, diffArgs);
  const includeUntracked = scope === "unstaged" || scope === "uncommitted" || scope === "branch";
  const untracked = includeUntracked ? await untrackedPaths(directory) : [];
  const selected = [...new Set([...tracked, ...untracked])];
  const files: DiffFile[] = [];
  for (const path of selected.slice(0, MAX_FILES)) {
    if (safePath(directory, path) === null) continue;
    const isUntracked = untracked.includes(path) && !tracked.includes(path);
    const raw = isUntracked
      ? await git(directory, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", path], true)
      : await git(directory, ["diff", "--no-ext-diff", "--no-color", ...diffArgs, "--", path]);
    const preview = scope === "staged" ? await gitPreview(directory, "", path)
      : scope === "committed" ? await gitPreview(directory, "HEAD", path)
      : await workingPreview(directory, path);
    files.push({ path, patch: raw.slice(0, MAX_PATCH), preview, truncated: raw.length > MAX_PATCH });
  }
  return {
    files,
    message: selected.length > MAX_FILES ? "Showing the first " + MAX_FILES + " of " + selected.length + " files." : null,
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    snapshot: ({ directory, scope, baseBranch, paths }) => snapshot(directory, scope, baseBranch, paths),
  },
});
