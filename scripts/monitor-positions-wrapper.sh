#!/bin/bash
# Wrapper to run monitor-positions.sh with docker group access
# This is needed because cron jobs don't inherit group memberships

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run with docker group context
sg docker -c "bash ${SCRIPT_DIR}/monitor-positions.sh"
