#!/usr/bin/env bash
# Tear down the local k3d cluster for live-mutex.distributed.
set -euo pipefail
CLUSTER="live-mutex-distributed"
if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster delete "$CLUSTER"
else
  echo "cluster '$CLUSTER' not found; nothing to do"
fi
