# Shared helpers for the devtools scripts - sourced, not run directly.

# Repositories live alongside ffc-pay-core, as with ./update
projectRoot="$(a="/$0"; a=${a%/*}; a=${a:-.}; a=${a#/}/; cd "$a/../.." || return; pwd)"

# Shared packages are deliberately excluded.
payments=(
  ffc-pay-batch-verifier
  ffc-pay-batch-processor
  ffc-pay-enrichment
  ffc-pay-processing
  ffc-pay-submission
  ffc-pay-file-publisher
  ffc-pay-file-receiver
  ffc-pay-responses
  ffc-pay-tracking
  ffc-pay-web
  ffc-pay-request-editor
  ffc-pay-event-hub
  ffc-pay-report-generator
  ffc-pay-alerting
  ffc-pay-gateway
  ffc-pay-injection
  ffc-pay-xb
  ffc-pay-dps
  ffc-pay-demographics
)

documents=(
  ffc-doc-statement-data
  ffc-doc-statement-constructor
  ffc-doc-statement-generator
  ffc-doc-statement-publisher
  ffc-doc-statement-receiver
  ffc-doc-alerting
)

pds=(
  fcp-pds-web
  fcp-pds-data-retention
)

repos=("${payments[@]}" "${documents[@]}" "${pds[@]}")

# Narrows repos to a group: payments, documents, pds or all
use_group() {
  case $1 in
    payments) repos=("${payments[@]}") ;;
    documents|docs) repos=("${documents[@]}") ;;
    pds) repos=("${pds[@]}") ;;
    all) ;;
    *) echo "Error: unknown group '$1' - use payments, documents, pds or all"; return 1 ;;
  esac
}

yes=false

# Asks a yes/no question, always "yes" when -y was passed
confirm() {
  $yes && return 0
  local ans
  read -rp "$1 [y/N] " ans
  [[ $ans == [yY] ]]
}

# Succeeds if the repo is on the branch. Warns if it has the branch but is on another one.
on_branch() {
  local repo=$1 branch=$2 current
  current=$(git -C "$projectRoot/$repo" branch --show-current)
  [[ $current == "$branch" ]] && return 0
  if git -C "$projectRoot/$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "!! $repo has '$branch' but is on '${current:-detached HEAD}' - skipping"
  fi
  return 1
}

is_cloned() {
  [[ -e $projectRoot/$1/.git ]]
}

remote_branch_exists() {
  git -C "$projectRoot/$1" ls-remote --exit-code --heads origin "$2" > /dev/null 2>&1
}
