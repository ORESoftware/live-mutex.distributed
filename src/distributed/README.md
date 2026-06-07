# live-mutex distributed consensus (`src/distributed`)

A leaderless, fault-tolerant **quorum/vote** mutual-exclusion engine — the
distributed locking core of `live-mutex.distributed`. It is a TypeScript
backport of the Rust crate `live-mutex-mills`, and is independent of the legacy
single-broker code (which is unchanged).

## Why

The legacy broker is a single authority (one TCP server grants locks). This
engine spreads locking across N peer nodes: any node serves any request,
independent locks run in parallel, there is no leader election to stall on, and
a crashed holder is recovered via leases. Safety needs **no clock** (it is a
quorum-intersection invariant); physical time matters only for lease expiry on
the failure path.

## Pieces

| File | Role |
|---|---|
| `request-id.ts` | scalar types + the totally-ordered `RequestId` |
| `messages.ts` | wire message union, `LEASE`/`RENEW_INTERVAL` |
| `node.ts` | `LMXConsensusNode` — the pure state machine (no I/O, no clock) |
| `sim.ts` | deterministic FIFO simulator with `crash()` / `advance()` |
| `transport.ts` | `LMXDistributedNode` — real TCP transport (one conn per directed link = FIFO) |
| `lmxd.ts` | CLI daemon (one process per node) |

Three mechanisms, three jobs: **quorum voting → safety**, **Lamport-timestamp
INQUIRE/YIELD preemption → deadlock-freedom**, **monotonic per-lock fence tokens
→ downstream backstop**.

## Build & test

```bash
# isolated build of just this module + its tests
./node_modules/.bin/tsc -p tsconfig.distributed.json

node dist/test/distributed/mutual-exclusion-test.js   # exclusion / progress / fencing
node dist/test/distributed/failover-test.js           # holder-crash recovery
node dist/test/distributed/tcp-smoke-test.js          # 3 nodes over real loopback TCP
```

## Run a cluster (cross-process)

```bash
node dist/src/distributed/lmxd.js 0 127.0.0.1:9300 127.0.0.1:9301 127.0.0.1:9302
node dist/src/distributed/lmxd.js 1 127.0.0.1:9300 127.0.0.1:9301 127.0.0.1:9302
node dist/src/distributed/lmxd.js 2 127.0.0.1:9300 127.0.0.1:9301 127.0.0.1:9302
```

Type `acquire <lock>` / `release <lock>` / `quit` on any node's stdin; it prints
`ACQUIRED <lock> fence=<n>` when held. Kill a holder and a survivor takes over
after the lease lapses, with a higher fence.

## Status / roadmap

- ✅ Engine, simulator, property + failover tests (parity with the Rust crate).
- ✅ TCP transport + `lmxd`, verified in-process and cross-process.
- ✅ Uses `@oresoftware/json-stream-parser` 0.1.x (`createLiveMutexJSONParser`)
  at the broker layer via `src/json-parser.ts`.
- ⏭️ **Next: `LMXDistributedBroker extends Broker1`** — reuse Broker1's
  client/protocol/timeout machinery, but route `lock`/`unlock` through this
  engine (peer mesh as a second transport plane) and return the fence token in
  the lock response. The transport above is the proven foundation for that.
- ⏭️ Known limitation (from the Rust port): a holder that crashes in the narrow
  lock→Confirm window can have its fence token reused; fix is a Confirm-ack
  before reporting acquired.
