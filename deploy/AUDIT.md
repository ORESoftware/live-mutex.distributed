# live-mutex.distributed — cluster audit findings

## Finding 0 — the distributed engine has no external client API

`src/distributed/lmxd.ts` is a consensus **node**: it forms the peer mesh over
TCP, accepts `acquire`/`release` on **stdin**, and runs an in-process `LMX_DEMO`
self-test. It does **not** expose any HTTP/TCP client listener. The HTTP server
and TCP client (`src/http-server.ts`, `src/client.ts`) belong to the **legacy
single-broker** path, not the distributed engine. This matches the repo's own
note that `LMXDistributedBroker extends Broker1` is a "Next" step.

**Consequence for this cluster:** there is nothing external to drive, so the
local cluster runs every node with `LMX_DEMO=1` (all nodes contend on the same
composite lock) and the gate **observes** correctness from the logs rather than
driving it. See `deploy/k8s/verify-job.yaml`.

**Consequence for #4 (EC2 benchmark):** the `k8s-cluster` benchmark harness
drives mutex brokers over HTTP, so the distributed engine cannot be benchmarked
there until it grows a client API. The sibling Rust repo `live-mutex-mills.rs`
already has one (`POST /locks/{lock}/acquire|release`, `GET /healthz`).

## What the live cluster proves

- 3 lmxd pods form the peer mesh across 3 separate k8s nodes over real TCP.
- Under the demo workload, the same composite lock is handed off **across nodes**
  with **strictly-increasing, never-repeated per-key fence tokens** — i.e. no
  node ever double-grants, so mutual exclusion holds over the network.

## Carry-over from the Rust sibling (will apply once an API is added)

When the distributed engine grows an external client API, expect the same two
caveats found in `live-mutex-mills.rs/deploy/AUDIT.md`:
1. holder tokens are node-local (acquire/release affinity), and
2. a client that dies without releasing holds the lock until a held-lock TTL or
   connection-tied lifetime is added.
The shared core logic (`node.ts`) is a close port of the Rust `lib.rs`, so the
external-surface design should account for these up front.
