#!/bin/sh
# Entrypoint for a live-mutex.distributed `lmxd` node as a StatefulSet pod.
#
# Unlike the Rust mills daemon, this TS daemon takes its membership as POSITIONAL
# argv only ( `lmxd <my_id> <addr_0> ... <addr_{n-1}>` ), so we synthesize the
# argv here from the pod ordinal + a headless Service. We also enable LMX_DEMO so
# every node continuously contends on the same composite lock — the cross-node
# exclusive handoff (and its strictly-increasing per-key fences) is what the
# verify Job scrapes from the logs.
#
# Inputs (set by the StatefulSet):
#   POD_NAME, POD_NAMESPACE   (downward API)
#   LMX_PEERS_SVC             headless Service name (DNS subdomain)
#   LMX_REPLICAS              cluster size N
#   LMX_PEER_PORT             peer-mesh port        (default 9000)
#   LMX_CLUSTER_DOMAIN        cluster DNS domain    (default cluster.local)
set -eu

ORDINAL="${POD_NAME##*-}"
STS_NAME="${POD_NAME%-*}"
PEER_PORT="${LMX_PEER_PORT:-9000}"
DOMAIN="${LMX_CLUSTER_DOMAIN:-cluster.local}"

set --                                   # reset positional params; build argv
set -- "$ORDINAL"                        # argv[0] = my_id
i=0
while [ "$i" -lt "$LMX_REPLICAS" ]; do
  fqdn="${STS_NAME}-${i}.${LMX_PEERS_SVC}.${POD_NAMESPACE}.svc.${DOMAIN}"
  set -- "$@" "${fqdn}:${PEER_PORT}"     # argv[1..N] = addr_0..addr_{N-1}
  i=$((i + 1))
done

self_fqdn="${STS_NAME}-${ORDINAL}.${LMX_PEERS_SVC}.${POD_NAMESPACE}.svc.${DOMAIN}"
echo "# waiting for own DNS record ${self_fqdn} ..."
until getent hosts "$self_fqdn" >/dev/null 2>&1; do
  sleep 0.5
done
echo "# DNS ready: $(getent hosts "$self_fqdn")"

# LMX_DEMO drives the self-test contention workload on every node.
export LMX_DEMO="${LMX_DEMO:-1}"
export LMX_DEMO_KEYS="${LMX_DEMO_KEYS:-cap,mid,zed}"

echo "# node ${ORDINAL}/${LMX_REPLICAS} argv: $*"
exec node /app/dist/src/distributed/lmxd.js "$@"
