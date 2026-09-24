Everything about the thread in view, in bb's Thread info tab and in a
floating panel inspired by the Codex app.

## What you get

- **In Thread info**, below bb's own rows: the GitHub stack and
  Attachments.
- **A floating panel**: open it from the branch button in the thread header.
  It's draggable and remembers its position.
  - **Environment**: changes, worktree, branch, ahead/behind, and Commit.
  - **Pull request**: checks and review state, Ready for review, and one-click
    "Ask agent to fix CI" or "Address review".
  - **Stack**: the branch PR's GitHub stack (stacked PRs), with Submit stack
    and Sync stack (`gh stack`).
  - **Agent**: to-do progress, context usage, and running background tasks.
  - **Attachments**: see below.
- **Attachments** are everything the thread refers to, as rich cards:
  - **Linear tickets** from links and branch names (like `eng-123-…`): state,
    priority, assignee, labels, project and cycle, the description, sub-issues,
    and linked PRs.
  - **Notion pages**: title, icon, last edit, and the opening text.
  - **GitHub PRs and issues**: state, author, labels, and body.
  - **Web pages**: title, site, description, and preview image.
  - **Figma and Slack links.**
  - **Images**: thumbnails of linked images and thread-storage images.
  - **Files** in thread storage.
- `bb env-panel` prints the same snapshot for agents and terminals.

## Setup

- **Linear**: add a personal Linear API key in this plugin's settings. The key
  stays on the bb server.
- **Notion**: uses the signed-in `ntn` CLI. **GitHub**: uses `gh`.

## How it works

bb data comes from the bb SDK. Rich details are fetched in the background and
cached, so the panel never waits on a slow service. Web previews and remote
images are fetched by the bb server, not the browser; local and private
addresses are refused. bb has no plugin slot inside Thread info, so the
sections are added to that tab's markup; turn this off in settings if a bb
update ever misplaces them.
