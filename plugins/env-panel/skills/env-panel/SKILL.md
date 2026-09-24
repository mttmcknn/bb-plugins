---
name: env-panel
description: Read a thread's environment snapshot (git changes, branch PR and checks, GitHub stacked PRs, agent progress, and attachments such as Linear tickets, Notion docs, GitHub items, links, images, and files) with `bb env-panel`. Use when you need the current PR, stack, or the ticket and docs this thread refers to.
---

# Environment Panel

`bb env-panel [<thread-id>] [--refresh] [--json]` prints what the user's
floating Environment panel shows. The thread defaults to `$BB_THREAD_ID`.

- `--refresh` skips the 60-second cache for `gh` results.
- `--json` prints the full snapshot. Each section is `{ ok, value }` or
  `{ ok: false, error }`, so one failing source never hides the others.

Sections:

- **Environment and Changes**: workspace path, branch, uncommitted and
  committed diff stats, and ahead/behind counts against the merge base.
- **Pull request**: bb's view of the branch PR, with attention state and checks.
- **Stack**: the GitHub stack (stacked PRs) that contains the branch PR, top
  first, with each PR's state, checks, and review. Manage it with `gh stack`
  (see the gh-stack skill), not Graphite.
- **Agent**: goal, to-do progress, context usage, and background tasks.
- **Attachments**: what the thread refers to, with rich details when available:
  Linear tickets (from links and branch names; needs the plugin's Linear API
  key), Notion pages, GitHub PRs and issues, web previews, Figma and Slack
  links, images, and thread-storage files. Details load in the
  background; `enriching: true` means run the command again for more.

This command is read-only. The panel's buttons (Commit, Ready for review, and
the "ask agent" actions) run only when the user clicks them.
