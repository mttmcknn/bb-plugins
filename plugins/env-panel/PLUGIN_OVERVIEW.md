Everything about the thread in view, in bb's Thread info tab and in a
floating panel inspired by the Codex app.

## What you get

- **In Thread info**, below bb's own rows: the GitHub stack and
  Attachments.
- **A panel beside the chat**, like the Codex app. It opens by itself when
  the thread has room for it next to the full-width chat, and the chat moves
  over to make room. Close it and it stays closed until you click the header
  button again. In a narrow window, the header button shows it over the chat
  instead; click anywhere else to dismiss it.
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

## Control Center grid and widgets

The panel is a grid of tiles, like Control Center. Each tile shows one thing
at a glance: changes, the PR and its checks, the stack's CI as a dot rail,
context usage, tasks, subagents, schedules, the Linear ticket, and
attachments. Tap a tile to expand it into its full detail. Action tiles
(Commit, Fix CI) act on tap. **Edit** hides, resizes, reorders, and adds
tiles; your layout is remembered.

Add your own tiles with **widgets**: small scripts in
`~/.config/bb-env-panel/widgets/` that print JSON (`bb env-panel widgets new`
starts one, and agents can write them for you), or other bb plugins that
publish `env-panel.widgets.v1.render`. An Android devices widget, powered by
`adb`, ships as a template.

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
