# Quorum Scaling Plan

## Decision For Now

Keep the current strict-majority quorum model.

Today the distributed engine uses the full member set for every lock and requires
`floor(n / 2) + 1` votes before entering the critical section. That is simple,
safe, and appropriate for small clusters such as 3, 5, 7, or 9 nodes.

For a 5-node cluster, a quorum is 3. That is a good tradeoff.

For a 100-node cluster, a majority quorum would be 51. That is too much fanout
for a lock service: every hot lock would involve a large fraction of the cluster,
tail latency would be dominated by many remote arbiters, and each acquisition
would create unnecessary network and CPU load.

The plan below keeps majority as the default while making room for smaller,
carefully constructed quorums.

## Safety Invariant

The requirement is not "majority" specifically. The requirement is quorum
intersection.

For a given lock key, every valid quorum that can grant that key must intersect
with every other valid quorum for that same key. Because each arbiter grants at
most one vote for a lock at a time, two holders would imply two intersecting
quorums and therefore one arbiter voting twice, which is impossible.

Any future quorum design must preserve:

- Same-key quorum intersection.
- One active vote per `(arbiter, lock)` at a time.
- FIFO point-to-point delivery between peers.
- Fencing-token monotonicity through quorum intersection.
- Safe membership changes where old and new quorum systems overlap.

## Current Membership Model

There are no membership epochs today.

The current distributed node receives a fixed member list at construction time.
That list determines the quorum size for the lifetime of the node:

```text
members = fixed constructor argument
quorum = floor(members.length / 2) + 1
```

Protocol messages do not carry a membership epoch, and nodes do not have a
dynamic add/remove-node path. A node can crash or become unreachable, but it is
still part of the configured member set until every process is restarted with a
different configuration.

That means today's behavior is:

- Add node: not supported dynamically.
- Remove node: not supported dynamically.
- Dead node: handled only as a failure inside the fixed membership.
- Quorum size: does not shrink when a node dies.

## Node Death In The Current Model

A node dying is not the same thing as removing it from membership.

If a requester/holder dies, the arbiters that voted for it stop receiving
renewals. After the lease expires, those arbiters reclaim their votes and can
grant them to the next waiting request. The dead holder may not send `Release`,
so lease expiry is the recovery path.

If an arbiter dies, requesters can still acquire locks as long as they can gather
a majority from the remaining live arbiters. For example, in a 5-node cluster,
one dead arbiter still leaves 4 live nodes and a quorum of 3 is still reachable.
Two dead arbiters still leave exactly 3 live nodes, so progress is possible but
fragile. Three dead arbiters leave only 2 live nodes, so no new majority quorum
can form.

If a holder is partitioned away from the majority, its votes at the majority side
eventually expire and another requester can acquire the lock with a higher fence
token. The partitioned holder might not receive the revocation promptly, so the
protected resource must enforce fencing tokens. Fencing is the backstop for slow,
partitioned, or paused holders.

Current failure handling therefore tolerates a minority of dead/unreachable nodes
but does not change membership automatically.

## Future Membership Epochs

Dynamic membership needs explicit epochs.

An epoch is a versioned cluster configuration:

```text
epoch 7:
  members = [0, 1, 2, 3, 4]
  quorum strategy = all-members-majority

epoch 8:
  members = [0, 1, 2, 3, 4, 5]
  quorum strategy = all-members-majority
```

Every request, grant, confirm, renew, release, and revoke should carry the epoch
or enough information to derive it unambiguously. A node must not count votes
from different epochs as if they belonged to the same quorum.

The core rule:

```text
old quorums and new quorums must overlap during reconfiguration
```

The conservative design is a joint epoch:

```text
epoch 7      = old config
epoch 7->8   = joint config; acquire must satisfy old quorum and new quorum
epoch 8      = new config
```

During the joint epoch, a lock acquisition is not complete until it has enough
votes under both configurations. This is more expensive during reconfiguration,
but reconfiguration is rare and safety is the priority.

## Adding A Node

Adding a node should be a controlled membership change, not an automatic side
effect of a process appearing on the network.

Planned flow:

1. Start the new node as a non-voting learner.
2. Establish its FIFO peer links.
3. Distribute the next membership epoch to the existing cluster.
4. Enter a joint epoch where acquisitions satisfy both old and new quorum rules.
5. Let the new node receive confirms/releases/renewals and any required fence
   snapshots for keys it may arbitrate.
6. Finalize the new epoch and allow new requests to use the expanded membership.

For majority quorums, adding one node at a time keeps old and new majorities
overlapping, but the implementation should still use epochs so that in-flight
requests cannot accidentally mix votes from old and new configurations.

## Removing A Node

Removing a node also needs an epoch change.

Graceful planned flow:

1. Mark the node as leaving in the next epoch.
2. Stop assigning it as an arbiter for new requests in the next epoch.
3. Enter a joint epoch where acquisitions satisfy both old and new quorum rules.
4. Continue accepting old-epoch releases/renews long enough to drain in-flight
   holders.
5. Finalize the new epoch.
6. Shut down the removed node after it is no longer needed for old-epoch traffic.

Forced removal of a dead node is harder. The remaining nodes should only remove
it if they can still form a quorum in the old epoch. If they cannot form an old
quorum, the system should prefer unavailability over inventing a new membership
on the minority side of a partition.

Removal is a safety operation, not just a liveness operation.

## Client Access Surface

The cluster should support both client-facing TCP and client-facing HTTP.

Current state:

- `Broker1` already has a client TCP protocol: newline-delimited JSON frames for
  `lock`, `unlock`, `acquire-many`, `release-many`, `ping`, and stats.
- `Broker1` already has an optional HTTP front-end with `/v1/lock`,
  `/v1/unlock`, `/v1/acquire-many`, `/v1/release-many`, `/healthz`, `/metrics`,
  and `/v1/stats`.
- The cross-runtime clients speak the TCP JSON protocol. Runtimes without a
  first-party client can use HTTP.
- The distributed engine currently has peer TCP for consensus traffic and a
  daemon/CLI path for manual `acquire` / `release`. It does not yet expose a
  full Broker1-compatible client gateway for the cluster.

Target state:

```text
client TCP / HTTP request
  -> any live cluster node
  -> local distributed gateway
  -> quorum acquire/release through the peer mesh
  -> client response with lock uuid + fencing token
```

The node should therefore have two separate network planes:

```text
client plane: TCP JSON protocol + HTTP JSON API
peer plane:   quorum/vote protocol between cluster nodes
```

Do not reuse the peer protocol as the public client protocol. Peer messages are
membership-sensitive and epoch-sensitive; clients should only speak stable
lock-service APIs.

Client-facing TCP should preserve the existing wire protocol so every language
client can point at a distributed node without learning a new protocol:

```text
client -> node: {type:"lock", uuid, key, ttl?, max?, pid?}
node -> client: {type:"lock", uuid, key, acquired:true, lockUuid, fencingToken}

client -> node: {type:"unlock", uuid, key, _uuid:<lockUuid>}
node -> client: {type:"unlock", uuid, key, unlocked:true}
```

Client-facing HTTP should preserve the existing `/v1/*` API so any runtime can
use the cluster without a custom client library:

```text
POST /v1/lock
POST /v1/unlock
POST /v1/acquire-many
POST /v1/release-many
GET  /healthz
GET  /metrics
GET  /v1/stats
```

Every cluster node may expose both client surfaces. A load balancer can route a
client to any live node because the serving node becomes the requester for that
lock and obtains the required quorum from the peer mesh.

Important requirements:

- The TCP and HTTP responses must use the same successful grant shape, including
  fencing tokens.
- A client should not need to know the key's replica group, quorum strategy, or
  membership epoch.
- The serving node must not report `acquired:true` until the distributed acquire
  is complete under the active quorum rules.
- Once confirm-ack is implemented, the serving node must not report
  `acquired:true` until the chosen fencing token is durably acknowledged.
- Client TCP connection close should release or abandon that connection's held
  locks using the same ownership semantics as `Broker1`.
- HTTP callers must provide the returned `lockUuid` on release; TTLs/fencing
  tokens are still required because HTTP is stateless and clients can disappear.
- The client TCP listener and peer TCP listener should use different ports or an
  explicit first-frame protocol discriminator.
- Multi-key client requests should be supported on both HTTP and TCP, but the
  distributed implementation may internally acquire component keys in canonical
  order until a native multi-key quorum protocol exists.
- Cross-runtime clients should continue to target the stable TCP protocol; they
  should not be rewritten to speak the peer protocol.

## Semaphore Support

The cluster should support semaphores, not only exclusive locks.

Current state:

- `Broker1` already supports non-binary semaphore behavior through `max`.
- The default is `max=1`, which is an exclusive lock.
- A request with `max=2`, `max=10`, or `max=100` allows that many concurrent
  holders for a single key, with queued callers admitted as slots open.
- Existing client TCP frames and HTTP `/v1/lock` already carry `max`.
- The distributed quorum engine currently models only exclusive ownership of a
  lock key.

Target behavior:

```text
max = 1    -> exclusive lock
max = K    -> semaphore with at most K concurrent holders
```

Do not implement distributed semaphores by simply allowing each arbiter to grant
up to `K` votes for the same key. Majority quorums only guarantee pairwise
intersection. They do not guarantee that every set of `K + 1` quorums shares one
common arbiter, so this can admit more than `K` holders.

Unsafe shape to avoid:

```text
each arbiter grants up to K votes
requester enters after majority grants
```

For `K > 1`, that local-capacity rule is not enough to prove a global capacity
limit.

Recommended first design: model a semaphore as a pool of `K` exclusive permits.

```text
public key:  "api-rate-limit"
capacity:    5

internal permits:
  "api-rate-limit#permit/0"
  "api-rate-limit#permit/1"
  "api-rate-limit#permit/2"
  "api-rate-limit#permit/3"
  "api-rate-limit#permit/4"
```

Each permit is acquired with the normal exclusive quorum protocol. Because each
permit can have at most one holder, the public key can have at most `K` holders.

Client-facing behavior should remain compatible with `Broker1`:

```text
client -> node: {type:"lock", uuid, key, max:5, ttl?}
node -> client: {type:"lock", uuid, key, acquired:true, lockUuid, fencingToken}

client -> node: {type:"unlock", uuid, key, _uuid:<lockUuid>}
node -> client: {type:"unlock", uuid, key, unlocked:true}
```

The serving node may encode the selected permit inside `lockUuid` or keep a
local holder table. Clients should not need to know which permit they received.

Capacity rules:

- Default capacity is 1.
- Capacity must be a positive integer.
- The cluster should enforce a configured cap, such as 100 or 1000, to prevent a
  caller from creating huge permit pools accidentally.
- In the distributed design, capacity should become stable key metadata. A later
  request should not silently change an active key from `max=5` to `max=2` or
  `max=100`.
- If a request supplies `max`, it should match the established capacity for that
  key, or be rejected with a clear error.
- Capacity changes should be explicit configuration changes and should not shrink
  below the number of currently held permits.

Permit selection:

- A requester should try permits in a deterministic order derived from
  `(key, requester id, request id)` to spread load.
- If one permit is busy, it can try another permit.
- Because a caller only needs one permit, there is no multi-permit deadlock for a
  single semaphore acquire.
- Queuing should avoid a hot `permit/0` bottleneck by distributing first choices.

Fencing-token note:

`Broker1` returns a per-key `fencingToken` on every successful grant, including
semaphore grants. The distributed design should preserve that response shape.

For strict per-key monotonic numeric tokens with `K` concurrent holders, the
permit pool alone is not enough because each permit has independent fence state.
The simplest safe design is:

1. Acquire one exclusive semaphore permit.
2. Allocate a per-key fencing token through a short-lived quorum-protected token
   allocator for the public key.
3. Attach that token to the permit holder.
4. Release only the token allocator, not the semaphore permit.

This serializes token minting, but not the whole semaphore hold.

Semaphores also change the meaning of downstream fencing. With an exclusive
lock, a downstream high-water mark cleanly rejects stale previous holders. With a
semaphore, multiple holders are intentionally valid at the same time, so a
resource that rejects every token lower than the highest token seen may reject an
older-but-still-valid concurrent holder. For rate limiting this is usually fine
because the semaphore itself is the useful primitive. For shared-resource writes,
callers need a resource-side policy that is compatible with concurrent holders.

Multi-key note:

Keep `max > 1` semaphore behavior single-key at first. Composite
`acquire-many` should continue to behave as `max=1` per member until there is a
separate design for multi-key semaphores.

## Sharding Is Separate From Quorum Choice

Sharding answers: which nodes own this key?

Quorum choice answers: within those nodes, which votes are enough?

The scalable shape should be:

```text
lock key -> replica group -> quorum inside that replica group
```

For example:

```text
orders:123 -> replica group [2, 8, 14, 20, 33] -> majority 3 of 5
```

This lets a 100-node deployment avoid a 51-node quorum without immediately
switching to a complex Maekawa quorum system. A key can be assigned to a small
replica group, and that group can continue using majority.

## Recommended Path

### Phase 1: Keep Majority, Add A Quorum Abstraction

Introduce an internal `QuorumStrategy` concept without changing behavior.

The first implementation should be the current model:

```text
strategy: all-members-majority
members: all cluster nodes
quorum size: floor(n / 2) + 1
request fanout: all members
```

This phase is mainly a refactor boundary. The protocol should still behave
exactly as it does now.

### Phase 2: Add Per-Key Replica Groups

Add deterministic key routing:

```text
replicaGroup = placement(key, clusterMembership)
quorum = majority(replicaGroup)
```

A 100-node cluster could use 5-node or 7-node replica groups:

```text
5 replicas -> quorum 3
7 replicas -> quorum 4
9 replicas -> quorum 5
```

This is the likely first production scaling step. It preserves the majority
proof locally while reducing lock fanout dramatically.

Important design points:

- Placement must be deterministic and stable across nodes.
- The selected replica group must be included in every protocol message or be
  derivable from the same membership epoch.
- Membership changes need epochs and overlap rules.
- A requester may be any node, but the arbiters for a key are the key's replica
  group.
- Multi-key locks may span replica groups and need canonical ordering or a
  higher-level composite protocol.

### Phase 3: Consider True Maekawa / Grid Quorums

For very large single replica groups, add an optional quorum system where each
requester uses a small intersecting request set instead of a majority.

For a 100-node group arranged as a 10x10 grid, a row-plus-column quorum has:

```text
quorum size: 10 + 10 - 1 = 19
```

That is much smaller than majority 51, while every pair of row-plus-column
quorums still intersects.

This should be treated as a later optimization, not the first scaling move.
Compared with per-key small replica groups, Maekawa-style quorums are more
delicate:

- The quorum sets must be generated and validated, not chosen ad hoc.
- Failure handling is harder because losing one fixed quorum member can block a
  requester unless alternate intersecting quorums are supported.
- Reconfiguration is harder because the intersection property must survive
  membership changes.
- Tests need to cover the quorum-system generator itself, not only the lock
  protocol.

## API Shape To Aim For

Eventually the node should not directly assume `members.length / 2 + 1`.

The protocol should ask a placement/quorum layer:

```text
participantsFor(lock, requester, epoch) -> NodeId[]
quorumReached(lock, requester, epoch, votes) -> boolean
quorumStillHeld(lock, requester, epoch, votes) -> boolean
```

For majority mode, `participantsFor` returns all current members and
`quorumReached` checks `votes.size >= floor(n / 2) + 1`.

For sharded majority mode, `participantsFor` returns the key's replica group and
`quorumReached` checks majority of that group.

For Maekawa mode, `participantsFor` returns the requester's intersecting request
set and `quorumReached` checks that the full required set, or an approved
intersecting alternative, has granted.

## Testing Requirements

Before enabling anything beyond full-cluster majority:

- Unit-test quorum generation for pairwise intersection.
- Property-test mutual exclusion under randomized FIFO delivery.
- Property-test monotonic fencing across release, crash, and recovery.
- Test membership epoch mismatches.
- Test that two same-key requesters can never use disjoint quorums.
- Test multi-key locking across different replica groups.
- Add simulation cases for 100-node clusters with hot-key contention.

## Working Recommendation

Use this order:

1. Keep full-cluster majority as the default and current behavior.
2. Add a quorum abstraction with no behavior change.
3. Add key-to-replica-group sharding with local majority.
4. Only then consider Maekawa/grid quorums for unusually large replica groups.

This gives us a practical path from 5 nodes to 100 nodes without giving up the
simple safety story too early.
