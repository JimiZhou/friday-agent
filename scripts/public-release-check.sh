#!/usr/bin/env bash
set -euo pipefail

command -v rg >/dev/null 2>&1 || { echo "public release check requires ripgrep (rg)" >&2; exit 2; }

files=()
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] && files+=("$file")
done < <(git ls-files -z --cached --others --exclude-standard)
if ((${#files[@]} == 0)); then
  echo "public release check found no candidate files" >&2
  exit 2
fi

failed=0
for file in "${files[@]}"; do
  case "$file" in
    *.env.example|deploy/hub/.env.example) ;;
    *.env|.env|.env.*|*.pem|*.key|*.p12|*.pfx)
      echo "private file must not be published: $file" >&2
      failed=1
      ;;
  esac
  if [[ -f "$file" ]] && (( $(wc -c < "$file") > 2097152 )); then
    echo "unexpected file larger than 2 MiB: $file" >&2
    failed=1
  fi
done

forbidden_environment='oracle|racknerd|home-diskstation|alpaca-neon|/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+/\.ssh'
secret_signatures='-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(proj-)?[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{20,}|tskey-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{20,}'
telegram_token='[0-9]{6,}:[A-Za-z0-9_-]{30,}'

environment_files=()
for file in "${files[@]}"; do
  [[ "$file" == "scripts/public-release-check.sh" ]] || environment_files+=("$file")
done
if rg -l -i -- "$forbidden_environment" "${environment_files[@]}"; then
  echo "deployment-specific environment names remain in the candidate tree" >&2
  failed=1
fi
if rg -l -- "$secret_signatures" "${files[@]}"; then
  echo "a high-confidence credential signature remains in the candidate tree" >&2
  failed=1
fi
if rg -l -- "$telegram_token" "${files[@]}"; then
  echo "a Telegram Bot Token-like value remains in the candidate tree" >&2
  failed=1
fi

git diff --check
if ((failed != 0)); then exit 1; fi
echo "public release check passed (${#files[@]} files)"
