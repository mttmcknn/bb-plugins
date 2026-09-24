---
name: pr-stacks
description: Link pull requests to the bb thread that created them, and look up a thread's PR stacks, with the `bb pr-stacks` CLI. Use right after you open or submit pull requests (gh pr create, gt submit, cloud agent sessions), or when the user asks which PRs or stacks belong to a thread or repo.
---

# PR Stacks

The PR Stacks plugin shows the user's open pull requests grouped by repository
and stack, and links each PR to the bb thread that created it. The user
navigates from a PR to its thread, so a correct link matters.

## After you open pull requests

Link every PR you opened or submitted in this thread, in one command:

```bash
bb pr-stacks link https://github.com/acme/app/pull/123 https://github.com/acme/app/pull/124
```

- Run it from this thread. The link defaults to the current thread.
- It accepts PR URLs or `owner/repo#number`.
- For a stack, link every PR in the stack, not only the top one.
- For PRs opened by a cloud agent, link each PR once the agent reports its PR number.

## Name the stack

When you open a stack of two or more PRs, give it a title that says what the
whole stack accomplishes. Pass any PR in the stack:

```bash
bb pr-stacks name acme/app#123 "Redesign the checkout flow"
```

- Write a short outcome, not a list of PRs: under 60 characters, no tags.
- When the user asks you to name their stacks, run `bb pr-stacks list`, read
  each stack's PR titles, and name each stack that shows `(suggested)` or no
  title.

The plugin also links PRs automatically. It matches a thread whose branch is
the PR's head branch, and a thread whose final message contains the PR URL.
Linking by hand is still the reliable path, so do it anyway.

## Show the stack to the user

After you link PRs, or when the user asks about this thread's PRs, put this
directive on its own line in your reply:

```
::pr-stacks
```

It renders this thread's stacks in the chat, live, with checks, review, and
conflict status on every PR, plus a button that opens them in the right-hand
panel. It shows only PRs that are linked, so link them first. Do not put it in
a code block, or it stays plain text.

The user can also open the panel from the PR count in the thread header, or
from the side panel's new-tab list ("PR stacks").

## Commands

| Command | Effect |
| --- | --- |
| `bb pr-stacks list [--repo owner/repo]` | Open PRs grouped by repo and stack, in merge order, with linked threads. |
| `bb pr-stacks thread [<thread-id>]` | Stacks that contain PRs linked to a thread (default: this thread). |
| `bb pr-stacks link <pr>... [--thread <id>]` | Link PRs to a thread. Replaces any earlier link. |
| `bb pr-stacks unlink <pr>` | Remove a wrong link. Automatic matching stays off for that PR. |
| `bb pr-stacks ready <pr>...` | Mark drafts ready for review. Refuses any PR whose checks are not all passing or that has conflicts. |
| `bb pr-stacks name <pr> <title>` | Title the stack that contains the PR. `--clear` removes it. |
| `bb pr-stacks refresh` | Fetch from GitHub now instead of waiting for the next refresh. |

Add `--json` when the output drives code.

## Rules

- Run `bb pr-stacks ready` only when the user asks you to mark PRs ready.

- Only link PRs this thread created or took over. Do not link PRs that you
  only reviewed or mentioned.
- A "gh api graphql failed" error means the GitHub CLI is not signed in. Tell
  the user to run `gh auth login`. Do not try to fix it yourself.
