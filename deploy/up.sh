#!/usr/bin/env bash
# Stand up the live-mutex.distributed leaderless cluster on k3d (DEMO workload)
# and run the log-scrape correctness gate.
#
#   deploy/up.sh            # create cluster, build, deploy, verify
#   deploy/up.sh --verify   # just (re-)run the verify Job against a live cluster
set -euo pipefail
export KUBECTL_NO_CONFIRM=1   # some envs wrap kubectl with a confirmation guard

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CLUSTER="live-mutex-distributed"
IMAGE="live-mutex-distributed:dev"
NS="live-mutex-distributed"

run_verify() {
  echo "==> applying RBAC + verify Job"
  kubectl -n "$NS" delete job lmx-verify --ignore-not-found
  kubectl -n "$NS" delete configmap lmx-verify --ignore-not-found
  kubectl apply -n "$NS" -f deploy/k8s/rbac.yaml
  kubectl -n "$NS" apply -f deploy/k8s/verify-job.yaml
  echo "==> waiting for verify Job (it watches a 35s demo window)"
  kubectl -n "$NS" wait --for=condition=complete job/lmx-verify --timeout=240s 2>/dev/null &
  cpid=$!
  kubectl -n "$NS" wait --for=condition=failed job/lmx-verify --timeout=240s 2>/dev/null &
  fpid=$!
  wait -n "$cpid" "$fpid" || true
  kubectl -n "$NS" logs job/lmx-verify
  if kubectl -n "$NS" get job lmx-verify -o jsonpath='{.status.succeeded}' | grep -q 1; then
    echo "==> VERIFY PASSED"; return 0
  else
    echo "==> VERIFY FAILED"; return 1
  fi
}

if [[ "${1:-}" == "--verify" ]]; then
  run_verify; exit $?
fi

echo "==> ensuring k3d cluster '$CLUSTER'"
if ! k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster create --config deploy/k3d/cluster.yaml
else
  echo "    cluster exists; reusing"
fi

echo "==> building image $IMAGE (context = repo root)"
docker build -f deploy/Dockerfile -t "$IMAGE" .

echo "==> importing image into k3d"
k3d image import "$IMAGE" -c "$CLUSTER"

echo "==> applying manifests"
kubectl apply -k deploy/k8s

echo "==> waiting for StatefulSet rollout"
kubectl -n "$NS" rollout status statefulset/lmx --timeout=180s
kubectl -n "$NS" get pods -o wide

run_verify
