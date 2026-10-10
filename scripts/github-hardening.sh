#!/usr/bin/env bash
# Harden the GitHub repo before it goes public. Needs the GitHub CLI (gh) signed in as the repo owner.
#
#   ./scripts/github-hardening.sh              show current state and what would change (changes nothing)
#   ./scripts/github-hardening.sh --apply      make the changes
#   ./scripts/github-hardening.sh --apply --prune-cursor   also delete the cursor/* and schema-items-migration branches on GitHub
#
# Some settings only exist on public repos or paid plans. Those steps report "skipped" and the script goes on.
set -u
REPO="${REPO:-hkrlogic/MCPEncode}"
BRANCH="${BRANCH:-main}"
APPLY=0; PRUNE=0
for arg in "$@"; do
  case "$arg" in --apply) APPLY=1 ;; --prune-cursor) PRUNE=1 ;; *) echo "unknown option: $arg"; exit 2 ;; esac
done
command -v gh >/dev/null || { echo "gh is not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: run gh auth login"; exit 1; }

step() { echo; echo "== $1"; }
try() { # try <label> <command...>
  local label="$1"; shift
  if [ "$APPLY" = 1 ]; then
    if out="$("$@" 2>&1)"; then echo "  done:    $label"; else echo "  skipped: $label  ($(echo "$out" | head -1 | cut -c1-140))"; fi
  else
    echo "  would:   $label"
  fi
}

step "Current state of $REPO"
gh api "repos/$REPO" --jq '"  visibility: \(.visibility)  default branch: \(.default_branch)  wiki: \(.has_wiki)  projects: \(.has_projects)  delete-branch-on-merge: \(.delete_branch_on_merge)"'
gh api "repos/$REPO" --jq '"  secret scanning: \(.security_and_analysis.secret_scanning.status // "n/a")  push protection: \(.security_and_analysis.secret_scanning_push_protection.status // "n/a")"'
echo "  private vulnerability reporting: $(gh api "repos/$REPO/private-vulnerability-reporting" --jq .enabled 2>&1 | head -1)"
echo "  branch protection on $BRANCH: $(gh api "repos/$REPO/branches/$BRANCH/protection" --jq '"on, checks: \(.required_status_checks.contexts | join(", "))"' 2>&1 | head -1 | cut -c1-120)"
echo "  branches on GitHub:"; gh api "repos/$REPO/branches" --paginate --jq '.[].name' | sed 's/^/    /'

step "Reporting and scanning"
try "private vulnerability reporting" gh api -X PUT "repos/$REPO/private-vulnerability-reporting"
try "Dependabot alerts" gh api -X PUT "repos/$REPO/vulnerability-alerts"
try "Dependabot security updates" gh api -X PUT "repos/$REPO/automated-security-fixes"
try "secret scanning + push protection" gh api -X PATCH "repos/$REPO" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'

step "Actions: read-only token by default, no auto-approving PRs"
try "default workflow token = read" gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

step "Repo housekeeping"
try "delete branches after merge, no wiki, no projects" gh repo edit "$REPO" --delete-branch-on-merge --enable-wiki=false --enable-projects=false

step "Branch protection on $BRANCH (checks must pass; no force-push; no deletion; admin can still bypass)"
if [ "$APPLY" = 1 ]; then
  if out="$(gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - 2>&1 <<JSON
{
  "required_status_checks": { "strict": false, "contexts": ["Typecheck and test", "Secret scan"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
)"; then echo "  done:    branch protection"; else echo "  skipped: branch protection  ($(echo "$out" | head -1 | cut -c1-140))"; fi
else
  echo "  would:   require 'Typecheck and test' and 'Secret scan', block force-push and deletion"
  echo "  note:    a check name only works after that check has run once on GitHub"
fi

step "Dependabot branches: built on the clean history?"
if git rev-parse --git-dir >/dev/null 2>&1; then
  git fetch -q origin 'refs/heads/dependabot/*:refs/remotes/origin/dependabot/*' 2>/dev/null
  clean="$(git rev-parse "$BRANCH")"
  for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/dependabot); do
    if git merge-base --is-ancestor "$clean" "$b" 2>/dev/null; then echo "  ok   $b"; else echo "  OLD  $b  (built before the rewrite; delete it, Dependabot recreates it)"; fi
  done
fi

step "Branches"
if [ "$PRUNE" = 1 ]; then
  for b in $(gh api "repos/$REPO/branches" --paginate --jq '.[].name' | grep -E '^(cursor/|schema-items-migration$)'); do
    try "delete branch $b" gh api -X DELETE "repos/$REPO/git/refs/heads/$b"
  done
else
  echo "  (not touching branches; add --prune-cursor to delete cursor/* and schema-items-migration)"
fi

echo; [ "$APPLY" = 1 ] || echo "Nothing was changed. Run again with --apply to make the changes."
