#!/usr/bin/env bash
set -euo pipefail

# Calendar-based release: YYYY.M.D, with -N suffix for same-day patches
# Usage: ./scripts/release.sh

# Must be on main
branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "Error: must be on main branch (currently on $branch)"
  exit 1
fi

# Must be clean
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working directory is not clean"
  git status --short
  exit 1
fi

# Pull latest
git pull --ff-only

# Calculate version: YYYY.M.D or YYYY.M.D-N
today=$(date +"%Y.%-m.%-d")
existing=$(git tag --list "v${today}*" | sort -V)

if [ -z "$existing" ]; then
  version="$today"
elif echo "$existing" | grep -qx "v${today}"; then
  # v2026.4.16 exists, next is v2026.4.16-1
  version="${today}-1"
else
  # Find highest suffix
  last=$(echo "$existing" | tail -1 | sed "s/v${today}-//")
  next=$((last + 1))
  version="${today}-${next}"
fi

echo "Releasing v${version}"

# Bump version in package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"${version}\"/" package.json

# Commit, tag, push
git add package.json
git commit -m "${version}"
git tag "v${version}"
git push origin main --tags

# Create GitHub Release (triggers npm publish workflow)
gh release create "v${version}" --title "v${version}" --generate-notes

echo ""
echo "Released v${version}"
echo "npm publish will run automatically via GitHub Actions."
