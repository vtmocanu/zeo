#!/usr/bin/env bash
set -euo pipefail

REPO="${ROADMAP_REPO:-vtmocanu/zeo}"
OWNER="${ROADMAP_PROJECT_OWNER:-vtmocanu}"
PROJECT="${ROADMAP_PROJECT_NUMBER:-3}"
DRY_RUN="${DRY_RUN:-0}"
TODAY="$(date -u +%Y-%m-%d)"
GQL_OWNER="${REPO%/*}"
GQL_NAME="${REPO#*/}"

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = "1" ]; then say "  dry-run: $*"; else "$@" >/dev/null; fi; }

if ! project_json="$(gh project view "$PROJECT" --owner "$OWNER" --format json 2>&1)"; then
  say "cannot read project $OWNER/$PROJECT: $project_json"
  say "no project scope: comment the intended change on the feature issue instead (see SKILL.md)"
  exit 3
fi
PROJECT_ID="$(jq -r .id <<<"$project_json")"
REPO_ID="$(gh api "repos/$REPO" --jq .node_id)"

fields_json="$(gh project field-list "$PROJECT" --owner "$OWNER" --format json)"
field_id() { jq -r --arg n "$1" '.fields[] | select(.name==$n) | .id' <<<"$fields_json"; }
option_id() { jq -r --arg f "$1" --arg o "$2" '.fields[] | select(.name==$f) | .options[] | select(.name==$o) | .id' <<<"$fields_json"; }
STATUS_FIELD="$(field_id Status)"
START_FIELD="$(field_id Start)"
TARGET_FIELD="$(field_id Target)"
for s in Wishlist Todo "In Progress" Done; do
  [ -n "$(option_id Status "$s")" ] || { say "Status option '$s' missing on the project"; exit 1; }
done

set_status() { run gh project item-edit --project-id "$PROJECT_ID" --id "$1" --field-id "$STATUS_FIELD" --single-select-option-id "$(option_id Status "$2")"; }
set_date() { run gh project item-edit --project-id "$PROJECT_ID" --id "$1" --field-id "$2" --date "$3"; }

ITEM_LIMIT=500
load_items() {
  items_json="$(gh project item-list "$PROJECT" --owner "$OWNER" --format json -L "$ITEM_LIMIT")"
  if [ "$(jq '.totalCount' <<<"$items_json")" -gt "$(jq '.items | length' <<<"$items_json")" ]; then
    say "project has more than $ITEM_LIMIT items; raise ITEM_LIMIT before syncing"
    exit 1
  fi
}
load_items

while IFS=$'\t' read -r id title; do
  say "draft \"$title\": converting to an issue"
  run gh api graphql -F itemId="$id" -F repositoryId="$REPO_ID" -F title="$title" \
    -f query='mutation($itemId:ID!,$repositoryId:ID!,$title:String!){convertProjectV2DraftIssueItemToIssue(input:{itemId:$itemId,repositoryId:$repositoryId,title:$title}){item{id}}}'
done < <(jq -r '.items[] | select(.content.type=="DraftIssue") | [.id, .title] | @tsv' <<<"$items_json")
[ "$DRY_RUN" = "1" ] || load_items

all_sub_numbers=""
feature_count=0

while IFS=$'\t' read -r id n; do
  detail="$(gh api graphql -F n="$n" -F owner="$GQL_OWNER" -F name="$GQL_NAME" \
    -f query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){title state milestone{title} parent{number} subIssuesSummary{total completed} subIssues(first:100){totalCount nodes{number state closedByPullRequestsReferences(first:10){totalCount nodes{state}}}}}}}' \
    --jq '.data.repository.issue')"
  if [ "$(jq -r '(.subIssues.totalCount > (.subIssues.nodes | length)) or ([.subIssues.nodes[].closedByPullRequestsReferences | .totalCount > (.nodes | length)] | any)' <<<"$detail")" = "true" ]; then
    say "#$n: sub-issue or pull-request list truncated; raise the query limits before syncing"
    exit 1
  fi
  parent="$(jq -r '.parent.number // ""' <<<"$detail")"
  current="$(jq -r --arg id "$id" '.items[] | select(.id==$id) | .status // ""' <<<"$items_json")"
  if [ -n "$parent" ]; then
    own_prs="$(gh api graphql -F n="$n" -F owner="$GQL_OWNER" -F name="$GQL_NAME" \
      -f query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){closedByPullRequestsReferences(first:10){totalCount nodes{state}}}}}' \
      --jq '.data.repository.issue.closedByPullRequestsReferences')"
    if [ "$(jq '.totalCount > (.nodes | length)' <<<"$own_prs")" = "true" ]; then
      say "#$n: pull-request list truncated; raise the query limit before syncing"
      exit 1
    fi
    own_prs="$(jq '[.nodes[] | select(.state=="OPEN")] | length' <<<"$own_prs")"
    if [ "$(jq -r .state <<<"$detail")" = "CLOSED" ]; then desired=Done
    elif [ "$own_prs" -gt 0 ]; then desired="In Progress"
    else desired=Todo
    fi
    [ "$current" = "$desired" ] || { say "#$n (PRD of #$parent) -> $desired${current:+ (was $current)}"; set_status "$id" "$desired"; }
    continue
  fi
  feature_count=$((feature_count + 1))

  title="$(jq -r .title <<<"$detail")"
  state="$(jq -r .state <<<"$detail")"
  milestone="$(jq -r '.milestone.title // ""' <<<"$detail")"
  total="$(jq -r .subIssuesSummary.total <<<"$detail")"
  completed="$(jq -r .subIssuesSummary.completed <<<"$detail")"
  open_prs="$(jq -r '[.subIssues.nodes[].closedByPullRequestsReferences.nodes[] | select(.state=="OPEN")] | length' <<<"$detail")"
  all_sub_numbers="$all_sub_numbers $(jq -r '[.subIssues.nodes[].number] | join(" ")' <<<"$detail")"

  start="$(jq -r --arg id "$id" '.items[] | select(.id==$id) | .start // ""' <<<"$items_json")"
  target="$(jq -r --arg id "$id" '.items[] | select(.id==$id) | .target // ""' <<<"$items_json")"

  if [ "$state" = "CLOSED" ]; then desired=Done
  elif [ "$completed" -gt 0 ] || [ "$open_prs" -gt 0 ]; then desired="In Progress"
  elif { [ "$total" -gt 0 ] || [ -n "$milestone" ]; } && { [ -z "$current" ] || [ "$current" = Wishlist ]; }; then desired=Todo
  elif [ -z "$current" ]; then desired=Wishlist
  else desired="$current"
  fi

  say "#$n $title: $total PRDs, $completed done, $open_prs PRs open -> $desired${current:+ (was $current)}"
  [ "$current" = "$desired" ] || set_status "$id" "$desired"
  case "$desired" in
    "In Progress"|Done) [ -n "$start" ] || set_date "$id" "$START_FIELD" "$TODAY" ;;
  esac
  [ "$desired" = Done ] && [ -z "$target" ] && set_date "$id" "$TARGET_FIELD" "$TODAY"

  if [ "$state" = "OPEN" ] && [ "$total" -gt 0 ] && [ "$completed" -eq "$total" ]; then
    say "  ACTION #$n: every PRD is closed; close the feature or file the next PRD issue"
  fi
  if [ "$total" -eq 0 ] && [ "$desired" = Todo ]; then
    say "  ACTION #$n: scheduled but has no PRD issues yet; decompose it"
  fi
done < <(jq -r '.items[] | select(.content.type=="Issue") | [.id, .content.number] | @tsv' <<<"$items_json")

say "features: $feature_count"

for n in $(gh issue list --repo "$REPO" --label uzi --state open --limit 200 --json number --jq '.[].number'); do
  case " $all_sub_numbers " in *" $n "*) ;; *) say "  ACTION #$n: open PRD issue is not a sub-issue of any feature; attach it" ;; esac
done
