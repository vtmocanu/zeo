---
name: roadmap-sync
description: Use when a PRD issue is filed, a PRD pull request merges, a human adds or edits a roadmap feature, or anyone asks what the roadmap or a feature's status is. Also use when decomposing a feature into PRD issues.
---

# Roadmap sync

The roadmap is the GitHub Project **zeo roadmap** (`vtmocanu`, project 3), linked to
`vtmocanu/zeo`. Anything a human puts on that board is a **feature**: a broad, plain-language
spec with no PRD rigor. Agents turn features into **PRD issues** and keep the board in step
with the issues. Humans only insert and drag; agents keep it true.

## Hierarchy

| Level | Who writes it | Where | How to recognise it |
|-------|---------------|-------|---------------------|
| Milestone | human | repo milestones | `Epic N: ...`, one per design-spec milestone, due date |
| Feature | human | item on the board | any board item that is not a sub-issue; drafts are converted to issues by the sync |
| PRD issue | agent | sub-issue of the feature | label `uzi`, links `prds/<n>-slug.md`, technical contract |
| PR | uzi | closes the PRD issue | `Closes #<prd-issue>` |

Status ownership is split. Humans own **Wishlist** and **Todo** (drag on the board; a
milestone also promotes Wishlist to Todo). Agents own **In Progress** and **Done**:

| Sub-issues | Status the sync sets |
|------------|----------------------|
| new item, nothing known | Wishlist |
| has PRDs or a milestone, currently Wishlist or unset | Todo |
| any closed, or any open PR | In Progress |
| feature issue closed | Done |

PRD issues reach the board automatically as sub-issues; the sync marks them Todo, In Progress
(open PR) or Done (closed). The sync never moves a feature back to Wishlist. `Start` is set when a feature first reaches
In Progress, `Target` when it reaches Done, unless a human filled one in earlier.

## Decomposing a feature

1. Read the feature issue and `docs/specs/`; write `prds/<epic>.<n>-slug.md` the usual way
   (docs PR, CodeRabbit round, merge).
2. File the PRD issue titled `PRD <epic>.<n>: <title>` with the body pointing at the PRD
   file, label `uzi`, and the feature's milestone. Add `autopilot` when uzi should run it
   unattended and `Planned` only when it is the next issue to run; everything else waits
   with `Later`.
3. Attach it as a sub-issue. There is no `gh` verb for it:

```bash
parent=$(gh api repos/vtmocanu/zeo/issues/<feature> --jq .node_id)
child=$(gh api repos/vtmocanu/zeo/issues/<prd-issue> --jq .node_id)
gh api graphql -f query="mutation { addSubIssue(input:{issueId:\"$parent\", subIssueId:\"$child\"}) { subIssue { number } } }"
```

4. Run the sync. Feature bodies need no checklist; sub-issue progress is the tracker.

## Syncing

```bash
.claude/skills/roadmap-sync/sync.sh            # reconcile every feature
DRY_RUN=1 .claude/skills/roadmap-sync/sync.sh  # print what would change
```

The script adds missing features to the project, sets Status/Start/Target from the rules
above, and prints `ACTION` lines for what only a person or a decomposition can settle:
a feature whose PRDs are all closed, a scheduled feature with no PRDs, an open `uzi` issue
that belongs to no feature. Act on the lines
that are yours; report the rest.

Run it after filing a PRD issue, after merging a PRD pull request, and whenever a human
touched the project. It is idempotent.

## Without project scope

`gh` needs the `project` scope; uzi's bot token and fresh `gh` logins lack it, and the
script exits 3 before computing anything. Do not retry. Leave one comment on the feature
issue so the next agent with scope runs the sync:

```
roadmap: PRD #<n> merged in #<pr>; run roadmap-sync
```

## Common mistakes

- Setting a feature's Status by hand on the board. The next sync overwrites it; change the
  sub-issues instead.
- Filing a PRD issue without `addSubIssue`. It shows up as an orphan `ACTION` line and the
  feature never reaches In Progress.
- Closing a feature because its listed PRDs are done while the design spec still names
  more. Closing is the human's call; file the next PRD or ask.
- Labelling a feature `uzi`. Only PRD issues are uzi's work.
- Putting an agent-filed issue on the board by hand. The board is the human layer; PRD issues
  reach it as sub-issues.
