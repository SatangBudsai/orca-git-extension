# Git Control for Orca

A Git client inside Orca: the commit graph, commits, branches, stashes, merge requests and pipelines for
GitHub and GitLab, in one editor tab and a sidebar panel, for projects on your computer and on your SSH
servers. It runs your installed `git` and signs in with
the Git login you already have (or `gh` / `glab` when they are set up), so there are no tokens to create.

![Git Control for Orca: commit graph, commits, branches, merge requests, CI pipelines and more](assets/promo/graph.png)

## Get started

1. Install **Git Control** from Orca's plugin marketplace (Settings → Plugins), or from this repository's Git URL.
2. Open a project that is a Git repository.
3. Click **Git** in the status bar (or run **Git: Open Git Control**) for the full tab, or open the
   **Git Control** panel (layers icon) in the right sidebar.

Requires Orca 1.4.248 or later and `git` on your PATH (and on your servers, for projects there; see
[Projects on a server](#projects-on-a-server-ssh)).

## What you can do

### See the history
The graph shows every branch with its own colour; the same colour marks that branch's labels. Click a
commit and its details open beside the graph, so you can step through commits with ↑ ↓ while the list
stays in view. Search finds messages, authors, changed files, hashes, branches and tags as you type.
Right-click any commit for checkout, branch, tag, merge, rebase, cherry-pick, revert, reset and more.
Drag a branch onto the one you are on to merge it, onto another to rebase, or onto Remotes to push.
**Explain** asks AI what a commit (or a merge request) changes and why, in plain words. A file's page shows
its whole history with each change, and who wrote each line (newer lines are warmer).

### Commit
The Commit tab lists your changes on the left and the selected file's diff on the right. Stage whole
files or single hunks, write the message (or let **AI message** draft it), and commit. When nothing is
left to commit but commits wait on your machine, the same button becomes **Push**. Before committing,
Git Control takes a second look: a secrets file, a token or key being added, a very big file, or a commit
straight to a shared main branch is pointed out first. **Ctrl+Z** undoes the last action.

![The Commit tab: changed files on the left, the diff on the right](assets/screenshots/commit.png)

### Review merge requests
**MR / PR** has two tabs. **Open** holds every open merge request of the repositories you work in (open in Orca),
whoever opened it, plus the ones asked of you anywhere; **For me**, **Mine** and **Everyone** narrow it, and each row is
tagged (Review requested, Assigned, Opened by me, No reviewer). It stays there until it is really merged (approved and
waiting, pipeline running, queued, even merged while its pipeline still runs); it shows this repository or all of them. **All** is this repository's every merge request: open ones first, then merged
ones by day, with **Show more merged** for older ones. Merged ones are only fetched when All is open, and GitHub searches
are shared and paused when GitHub's rate limit is reached;
the count is what still waits for your approval, and it shows as soon as a project opens. Search, filter by project
or label, and see new comments since you last looked. Approve or merge right from the list, or tick several and **Approve & merge** them together:
they merge in the background while you keep working. Within one project they go one at a time, each waiting
until the one before is merged and rebasing when GitLab asks, so they never collide; other projects go at the
same time, and you are told as each one merges. An approved one stays, marked **Approved · waiting merge**; one with conflicts is marked
**Conflicts**; while its pipeline runs the button reads **Merge when CI passes**. Only a real merge removes it.

Click one to read it like on GitHub or GitLab: the description, reviewers and approvals, the activity with inline
comments, its commits and changes. Under the description sits the merge box, laid out like GitLab's: the
pipeline, the approvals with **Approve** on the right (or **Revoke**), then **Merge now** with *Delete source
branch* and *Squash commits* (or **Merge when pipeline passes**), or the reason it cannot be merged yet.
**Explain**, **AI review**, **Comment** and **Request changes** are at the bottom.

![A merge request's detail page with description, reviewers, approvals and activity](assets/screenshots/merge-request.png)

When someone asks you to review or assigns you a merge request, Orca shows a notification, on your desktop and
on your phone through Orca's app, and **MR/PR 3** in the status bar counts what waits for you (and **Overview** opens Repo Overview).

![Notifications for review requests on a phone and the desktop](assets/promo/notifications.png)

### Review with AI before anyone else does
Right-click a branch: **Review with AI** sits right under **Merge request**, in purple, with the same directions
(`feature → main`). It reviews what the merge request will show (the branch from where it split off) on your
machine, with the Claude Code or Codex CLI you have, and nothing is posted anywhere. The answer says **Ready for
review**, **Fix first** or **OK, with notes**, lists *Must fix / Should fix / Suggestions*, and each `file:line` opens
that file. Then **Create merge request** goes on from there. The merge request window has **Review with AI first**,
and the Commit tab a **Review** button for what you are about to commit.

### Open a merge request
Right-click a branch → **Merge request** and pick the direction (written source → target). The title and
description are filled in the way GitLab does it, assignees and reviewers come from the project, and
**Create now** makes it with your Git login, pushing the branch first when needed.

![The new merge request dialog with assignees and reviewers](assets/screenshots/new-merge-request.png)

### Merge and resolve conflicts
Right-click any branch or tag label in the graph (or a tag in the sidebar): the first item merges that one into
your branch. If both sides changed the same lines, the conflicts page names them, **Incoming (their branch)** and
**Current (your branch)**, and lets you keep one side for all files at once, let **AI resolve all** (or one file),
or go file by file, conflict by conflict, side by side, with the result editable. Then **Commit merge**.
Parts where only one side really changed (or both made the same change) are counted for you: **Apply
non-conflicting** merges them in one click, and **Show base** shows the file as it was before either side changed it.

### Rewrite history safely
**Interactive rebase** (right-click a commit → More): drag commits to reorder; keep, reword (type the new message in
place), squash, fixup or drop each one; a line says what the branch will look like before you start. **Reset**
explains each kind (keep staged, keep unstaged, keep only your work, throw away) and how to get commits back.
**Ctrl+. → Show git commands** lists the exact git commands that ran, and can show them with each action.

### Fix a failing pipeline
The **CI** badge next to the branch shows the latest pipeline. Click it to see the jobs by stage, open
the failed one and step straight through its error lines. Retry a job, the failed jobs or the whole
pipeline without leaving Orca. Works with GitHub Actions and GitLab CI.

![A failed GitLab job's log with its error lines highlighted](assets/screenshots/pipeline.png)

### Every pipeline on one page
The **Pipelines** tab lists the latest runs of every branch, laid out like GitLab's: the status with how long it
took, the commit's message, what started it (push, merge request, schedule, by hand), the branch, tag or merge
request (as !142), each stage as a dot, and who ran it. Filter by running, failed or passed, or by text; it
updates by itself while runs go on, and a click opens the run's jobs and logs.

![The Pipelines tab with every branch's runs, their stages and who started them](assets/screenshots/pipelines.png)

### A folder of repositories
Open a folder that is not a repository itself but holds some (`ABC` with `A`, `B` and `C` inside, up to two levels
deep) and Git Control opens one of them instead of saying *Not a Git repository*. The folder's repositories show as
tabs under the header, each with its branch; one click switches, and the folder opens on the one you used last.
The repository menu and **Ctrl+.** (type its name) switch too, and Repo Overview lists them all.

### All your repos on one page
Working in several repos at once? **Repo Overview** (the button beside the branch, or **Ctrl+.**) is a dashboard: tiles
for what needs you (attention, changes, to pull, to push) that filter the list, a health bar, and the open merge
requests across every repo. Below, each repo is listed with its branch, how far it is ahead or behind, its changes, CI and its open merge requests. The ones that
need you come first; a tile on top (*With changes*, *To pull*…) shows only those.
Repos are grouped like Orca's sidebar (its Project Groups, in the same order). Each row shows its latest tag and can
fetch, pull, tag, switch branch or open that repo. Tick several and act on them together: **Fetch**, **Pull** and
**Push** (only where it is safe, saying why the rest were skipped), **Tag…**, **Switch branch…** (every repo that has
it) and **New branch…**. A fetch gives up on a slow remote after 45 s, and a failed command stays on its row with the
reason. **Tag…** fills everything in: the naming pattern the repos already use (`v*`, `dev_v*`, `uat_v*`…), each repo's
newest tag of it and the next version, on a branch as pushed to origin (the one most of them are on; each row can
pick another); a repo already tagged there says so, and existing tags are never overwritten. Each
row can fetch, pull, switch branch, or open that repo on its Graph, merge requests or pipelines. It lists the repos
opened in Orca; **Scan folders…** adds the repos inside any folder too. With two repos or more, **3 of 5 repos** in
the status bar says how many need you, and opens this page. (Idea from
[Multi-Repo Git Overview](https://github.com/gino8080/orca-git-overview) by gino8080.)

![Repos overview: every repository with its branch, ahead/behind, changes, CI and reviews](assets/screenshots/repos-overview.png)

![Tag several repos at once: each repo's newest tag and the next version, filled in](assets/screenshots/tag-many.png)

### Projects on a server (SSH)
*New in 0.9.0.* Open the repository menu: the projects on your servers are there, next to the local
ones. Every SSH host you set up in Orca is a server automatically, and its home folder is searched for
Git repositories. Pick one and everything works as on your computer (the graph, commits, conflicts,
rebase, worktrees, merge requests); the header shows which server it is on, and Repo Overview lists
the servers' repos too, under each server.

![The repository menu: projects on a server marked with its name, next to the local ones](assets/screenshots/ssh-repo-menu.png)

![A repository on an SSH server: its name and server in the header, branches, remotes and the full graph](assets/screenshots/ssh-server-graph.png)

**Servers…** at the bottom of the menu lists them: add another by its name (your SSH hosts are
suggested as you type), and from a server's ⋯ menu search it again, change the folders searched or hide it.

![The Servers page: each server with how many projects were found, and the steps to fix one that cannot be reached](assets/screenshots/servers.png)

![Add a server: one field, your SSH hosts suggested as you type](assets/screenshots/ssh-add-server.png)

Git runs on the server through your own `ssh`, so a server must log in with a key, without a password.
When one cannot be reached, its row says why and what to do, step by step.

### Work by keyboard
**Ctrl+.** opens every command by name (fetch, pull, push, stash, new branch, any tab). In the graph,
↑ ↓ (or j k) move, Enter opens, / searches and Esc closes. **Ctrl+Z** undoes the last action.

### And also
- **Fetch, Pull, Push** show how many commits wait (↑ green to push, ↓ amber to pull, red when the branch
  and its remote have gone separate ways), animate while they run and say what changed
- **Branches, tags and remotes** in the sidebar; **Worktrees**, **Stash** and **Reflog** tabs
- **Undo** takes back the last commit, reset, merge or rebase
- **Settings**: git config for the repository or globally, and name/email profiles you can switch
- Comes back to the tab, scroll position and open commit you left in each project
- Follows Orca's light and dark themes; works in the narrow sidebar and on phones through Orca's web client

AI features use the Claude Code or Codex CLI you have installed (Settings → Plugins → Git Control).

## Languages

Git Control speaks English, 简体中文 (Simplified Chinese), 日本語 (Japanese), Español (Spanish) and ไทย (Thai).
English is the default; pick another in **Settings → Language** inside Git Control, or in Orca's plugin settings.
Words people type as Git commands (commit, push, rebase, stash…) stay in English where developers in that language
usually say them in English (Thai, Spanish), and follow the VS Code language pack where they are translated (Chinese, Japanese).

### Add or improve a translation

Each language is one file, `panel/locales/<language>.json`, mapping the English text to the translation:

```json
{ "Push {n} commits to {remote}": "推送 {n} 个提交到 {remote}" }
```

- Keep every `{placeholder}` and any leading/trailing space as it is.
- An empty value shows the English, so a partial translation is fine.
- New language: copy `zh-CN.json`, clear the values, translate, and add it to `LANGS` in `panel/app.js` and the
  `language` setting in `orca-plugin.json`.
- `node tools/i18n.mjs` shows what each language is missing; `--sync` adds new keys after the code changes;
  `--check` fails on missing keys or wrong placeholders. Then `node tools/build.mjs`.

## Privacy

Git Control runs `git`, and `gh` / `glab` when present, on your machine (and `git` on your SSH hosts,
over your own ssh). It talks only to your own
GitHub or GitLab hosts, with the login Git already uses; the token is never shown, logged or sent
anywhere else.

Merge request descriptions, comments and AI answers are treated as untrusted: their Markdown becomes
text and plain `https` links, never markup of its own. The files Git Control writes in a working tree
(`Git.control`, `.gitignore`) are never written through a symlink a repository commits.

## Development

```sh
orca plugin validate .
orca plugin dev reload .     # loads into Orca; asks you to approve on first load
node tools/build.mjs         # after editing panel/: builds panel/graph.html (tab) and panel/sidebar.html (panel)
```

Tests run against throwaway repositories and a fake GitHub/GitLab API, never your accounts or config
(`cd tests && npm install` first; they need Google Chrome, found where Windows, macOS or Linux put it, or set
`CHROME=/path/to/chrome`). They run on Windows, macOS and Linux: the stand-ins for `ssh`, `orca` and the AI CLIs are Node
scripts, and on Windows the SSH tests use the `sh` that comes with Git (symlink checks are skipped without Developer Mode):

```sh
node e2e.mjs <plugin folder> <shots folder>       # the full tab, clicked through like a person
node mobile.mjs <plugin folder> <shots folder>    # phone size, loaded the way Orca's web client loads it
node sidebar.mjs <plugin folder> <shots folder>   # the right-sidebar panel at several widths
node worker-api.mjs github|gitlab                 # merge requests, reviews and CI through the Git login
node merge-queue.mjs                              # Approve & merge on several: one at a time per project
node statusbar.mjs                                # the status bar items: Git never disappears, Repos counts
node github-ratelimit.mjs                         # GitHub searches shared, paused at the rate limit
node pipelines-perf.mjs --check                   # Pipelines tab load time against a slow fake GitLab
node tag-many.mjs                                 # tag several repos: newest tag, next version, already tagged
node ai-review-local.mjs                          # Review with AI before a merge request or a commit
node notify.mjs                                   # notifications: new MR, pipeline passed / failed, merged
node remote-ops.mjs                               # a repository on an SSH host, through a stand-in ssh
node servers-ui.mjs <plugin folder> [shots folder] # servers in the panel: menu, Servers page, header badge, overview
node screenshots.mjs <plugin folder> <out folder> # the screenshots above, on a made-up project
node promo.mjs <plugin folder>                    # marketplace posters from assets/screenshots → assets/promo
```

```
orca-plugin.json   manifest (trusted-worker: the worker runs git)
worker/main.mjs    git, GitHub and GitLab operations, exposed to the panel
worker/hosts.mjs   where git runs: this machine, or an SSH host (ssh://host/path locators)
panel/             tab.html (editor tab), index.html (sidebar panel), style.css, app.js
tools/build.mjs    packs each page into one self-contained file
```
