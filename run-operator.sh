#!/bin/bash
# Local operator runner for Charon dry_run in this VM.
# Does NOT push to upstream, does NOT contain credentials.
# Credentials live only in ~/workspace/charon/.env (chmod 600, no private key line).
set -u
cd /home/hatch/workspace/charon || exit 1
mkdir -p logs data
if pgrep -f "node index[.]js" > /dev/null 2>&1; then
  echo "charon already running"
  exit 0
fi
nohup node index.js >> logs/operator-run.log 2>&1 &
echo "charon started pid $!"
