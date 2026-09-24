See your open pull requests the way you manage them: by repository, by stack,
and by the thread that created them.

## What you get

- A **PR Stacks** page. Each repository has its own section. Each stack is
  listed in merge order, with checks, review, and conflict status on every PR.
- A button on every PR that opens the bb thread behind it.
- A **PR stacks** side panel in every thread. It shows the stacks the thread
  created, with their progress, next to the chat.
- A button in the thread header that opens that panel.
- A `::pr-stacks` directive, so an agent can show the stacks in the chat.
- A `bb pr-stacks` command, so agents link the PRs they open to their thread.

## How it works

The plugin asks the GitHub CLI for your open pull requests every few minutes.
It chains PRs into stacks by their base branches. It links a PR to a thread
when an agent links it, when a thread mentions the PR URL or branch, or when a
thread works on the PR's branch. Links are stored on your bb server.

## Requirements

The GitHub CLI (`gh`), signed in.
