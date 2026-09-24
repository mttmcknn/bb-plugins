// Local CLIs the panel reads, such as `gh` for GitHub stacked PRs. They run
// through a login zsh so a GUI-launched bb server sees the same PATH and
// ~/.zshenv credentials as a terminal.
import { execFile } from "node:child_process";
import { z } from "zod";
import { buildStack, checksFromRollupState, prState, reviewFromDecision, type PrStatus } from "./stack.ts";
import type { StackInfo } from "./types.ts";

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // "$0" "$@" passes every argument through untouched: nothing is re-parsed by the shell.
    const child = execFile(
      "/bin/zsh",
      ["-l", "-c", '"$0" "$@"', command, ...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: options.env === undefined ? undefined : { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        // Some CLIs (ntn) report errors on stdout; fall back to it.
        const output = String(stderr).trim() || String(stdout).trim();
        const detail = output.split("\n").slice(-3).join(" ").slice(0, 300);
        const { code, signal, killed } = error as { code?: unknown; signal?: unknown; killed?: boolean };
        const reason = killed ? `timed out after ${options.timeoutMs / 1000}s` : `exit ${code ?? signal ?? "?"}`;
        reject(new Error(`${command} ${args[0] ?? ""} failed (${reason}): ${detail || error.message}`));
      },
    );
    // Nothing is piped in. Some CLIs (ntn) wait for stdin to close before running.
    child.stdin?.end();
  });
}

/** Caches one value per key for `ttlMs`, sharing in-flight loads. */
export function cached<T>(ttlMs: number) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>, force = false): Promise<T> => {
    const entry = entries.get(key);
    if (!force && entry !== undefined && Date.now() - entry.at < ttlMs) return entry.value;
    const value = load();
    entries.set(key, { at: Date.now(), value });
    // A failure is not cached: the next caller retries.
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}

const pullStackSchema = z.object({
  stack: z.object({ number: z.number() }).nullable().optional(),
});

const stackSchema = z.object({
  number: z.number(),
  base: z.object({ ref: z.string() }),
  pull_requests: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      state: z.string(),
      draft: z.boolean(),
      merged_at: z.string().nullable(),
      head: z.object({ ref: z.string() }),
    }),
  ),
});

const statusSchema = z.object({
  data: z.object({
    repository: z.record(
      z.string(),
      z
        .object({
          reviewDecision: z.string().nullable(),
          commits: z.object({
            nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
          }),
        })
        .nullable(),
    ),
  }),
});

async function ghJson(args: string[]): Promise<unknown> {
  return JSON.parse(await run("gh", args, { timeoutMs: 30_000 }));
}

/**
 * The GitHub stack containing pull request `number` in `repo`, or null when
 * the PR is not stacked. Reads the PR's `stack` link, the stack's pull
 * requests, then their checks and review state in one GraphQL query.
 */
export async function fetchStack(repo: string, number: number): Promise<StackInfo | null> {
  const link = pullStackSchema.parse(await ghJson(["api", `repos/${repo}/pulls/${number}`])).stack;
  if (link == null) return null;
  const stack = stackSchema.parse(await ghJson(["api", `repos/${repo}/stacks/${link.number}`]));

  const [owner, name] = repo.split("/");
  const fields = stack.pull_requests
    .map(
      (pull) =>
        `p${pull.number}: pullRequest(number: ${pull.number}) { reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`,
    )
    .join("\n");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const statuses = new Map<number, PrStatus>();
  const result = statusSchema.parse(
    await ghJson(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`]),
  );
  for (const [alias, pr] of Object.entries(result.data.repository)) {
    if (pr === null) continue;
    statuses.set(Number(alias.slice(1)), {
      checks: checksFromRollupState(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
      review: reviewFromDecision(pr.reviewDecision),
    });
  }

  return buildStack({
    number: stack.number,
    trunk: stack.base.ref,
    currentNumber: number,
    statuses,
    pulls: stack.pull_requests.map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      headRefName: pull.head.ref,
      state: prState(pull),
    })),
  });
}
