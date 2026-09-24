# bb-plugin-pr-stacks

A bb plugin that shows your open pull requests grouped by repository and
stack, and links each one to the bb thread that created it.

## What it adds

- **PR Stacks page** in the sidebar, with an open-PR count.
  - One section per repository, newest activity first.
  - Each stack is a card, listed in merge order: 1 merges first.
  - Each stack has a title saying what it accomplishes (see below).
  - Each PR shows GitHub's state icon: open, draft, merged, or closed.
  - The PR you last opened stays marked, with a bar on its left.
  - Minimize a stack, or all stacks in a repo, to show only its progress
    bar. Hover or focus a segment to see that PR below the bar; select a
    segment to open the PR.
  - Reviewer avatars sit at the end of each PR's details. A badge marks each
    verdict: a check for approved, an X for changes requested, a speech
    bubble for commented. Faded avatars are pending review requests.
  - Each stack opens its PRs in its own browser tab (desktop app). The first
    PR you open from a stack creates the tab; later PRs from that stack reuse
    it. Different stacks get different tabs. A pinned tab's toolbar shows the
    stack, the PR's position, and previous/next buttons.
  - **Ready for review** appears on a draft only when all its checks pass
    and it has no conflicts. A stack header offers "Mark N ready" for all
    of them at once.
  - Standalone PRs are grouped in their own card.
  - Each row shows checks, review, conflicts, draft state, and size.
  - The PR title opens GitHub. The thread button opens the linked thread.
- **Thread side panel ("PR stacks")**: the stacks that contain the thread's
  PRs, in the right-hand pane beside the chat. Each stack shows a progress bar
  (ready to merge, waiting, blocked, draft) and every PR's checks, review, and
  conflicts. The thread's own PRs are marked "This thread"; other PRs in the
  stack link to their threads. It updates on every refresh.
- **Thread header button**: shows how many open PRs came from the thread, with
  a warning icon when any fail checks, conflict, or have changes requested.
  Select it to open the side panel.
- **`::pr-stacks` chat directive**: an agent writes it on its own line to show
  the thread's stacks in the chat, with a button that opens the side panel.
- **`bb pr-stacks` CLI** and an agent skill, so agents link the PRs they open.

## How stacks are found

A PR's parent is the open PR in the same repository whose head branch is its
base branch. This matches how Graphite and `gh stack` chain PRs.

## Stack titles

The first available source wins:

1. A name you set (select the pencil beside the title) or an agent set with
   `bb pr-stacks name <pr> <title>`. Names are stored on every PR in the
   stack, so a name stays when the bottom PR merges.
2. The title of the thread behind most of the stack.
3. A suggestion from what most PRs share: the `[tag]` in their titles and the
   leading words of their branch names, for example "shop · cart".

Ask any agent to "name my PR stacks" for better titles than the suggestion.

## How PRs are linked to threads

The first match wins:

1. A link made with `bb pr-stacks link` (by you or an agent).
2. A link found automatically: the first thread whose messages contain the PR
   URL or its head branch name. A thread that finishes a turn with a PR URL in
   its final message is linked right away.
3. The thread whose bb environment is on the PR's head branch.

Select the X beside a thread to unlink it. That also stops automatic matching
for that PR.

## Requirements

- The GitHub CLI (`gh`), signed in with `gh auth login`.

## Settings

| Setting | Default | Use |
| --- | --- | --- |
| GitHub search query | `is:pr is:open author:@me archived:false` | Which PRs to show. |
| Refresh every (minutes) | `5` | How often to fetch from GitHub. |
| gh path | empty | Full path to `gh`, if it is not found automatically. |

## Develop

```bash
npm install --include=dev
npm test          # stack-building unit tests
npm run typecheck
bb plugin install .
bb plugin dev     # rebuild and reload on save
```
