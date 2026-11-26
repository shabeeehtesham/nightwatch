#!/bin/sh
# Runs on the Oracle server every 2 minutes (systemd timer).
# Pull-based deploy: the server checks GitHub for a new commit on main and
# only deploys it once the "tests" workflow has passed for that commit.
# Nothing on GitHub needs a key to the server.
set -eu

REPO="shabeeehtesham/nightwatch"
APP_DIR="$HOME/nightwatch"
cd "$APP_DIR"

git fetch -q origin main
current=$(git rev-parse HEAD)
latest=$(git rev-parse origin/main)
[ "$current" = "$latest" ] && exit 0

# What did GitHub's test run say about this commit?
verdict=$(curl -fsS -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/commits/$latest/check-runs" | python3 -c '
import json, sys
runs = [r for r in json.load(sys.stdin)["check_runs"] if r["name"] == "pytest"]
if not runs or any(r["status"] != "completed" for r in runs):
    print("waiting")
elif all(r["conclusion"] == "success" for r in runs):
    print("passed")
else:
    print("failed")
')

short=$(echo "$latest" | cut -c1-7)
case "$verdict" in
  waiting) exit 0 ;;   # tests still running, try again next tick
  failed)
    # log once per commit, keep running the old version
    grep -q "skip $short" "$HOME/deploy.log" 2>/dev/null || echo "$(date -Is) skip $short: tests failed" >> "$HOME/deploy.log"
    exit 0 ;;
esac

echo "$(date -Is) deploying $short" >> "$HOME/deploy.log"
git reset -q --hard "$latest"          # .env is gitignored, so it survives
docker build -q -t nightwatch . >/dev/null
docker rm -f nightwatch >/dev/null 2>&1 || true
docker run -d --name nightwatch --restart unless-stopped \
  --env-file .env -p 127.0.0.1:7860:7860 nightwatch >/dev/null
docker image prune -f >/dev/null
echo "$(date -Is) live $short" >> "$HOME/deploy.log"
