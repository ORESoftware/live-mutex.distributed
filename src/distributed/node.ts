'use strict';

import {
  Acquired,
  ConsensusMessage,
  ConsensusMsgType,
  LEASE,
  Outgoing,
  RENEW_INTERVAL,
  isConsensusMessage,
} from './messages';
import {
  Fence,
  Instant,
  Lamport,
  LockId,
  NodeId,
  RequestId,
  reqEq,
  reqKey,
  reqLt,
} from './request-id';

/**
 * An ordered set of waiting requests supporting min-extraction and removal of
 * an arbitrary element (the TS analogue of the Rust `BTreeSet` queue). Queues
 * are bounded by the cluster size, so the linear min-scan is cheap.
 */
class ReqQueue {
  private readonly m = new Map<string, RequestId>();

  insert(r: RequestId): void {
    this.m.set(reqKey(r), r);
  }

  remove(r: RequestId): void {
    this.m.delete(reqKey(r));
  }

  isEmpty(): boolean {
    return this.m.size === 0;
  }

  popMin(): RequestId | undefined {
    let best: RequestId | undefined;
    for (const r of this.m.values()) {
      if (best === undefined || reqLt(r, best)) {
        best = r;
      }
    }
    if (best !== undefined) {
      this.m.delete(reqKey(best));
    }
    return best;
  }
}

/** Per-lock state when this node acts as an arbiter (a voter). */
interface ArbiterState {
  votedFor: RequestId | null;
  inquired: boolean;
  queue: ReqQueue;
  fenceMax: Fence;
  /** Deadline by which the current votee must renew; meaningful while votedFor. */
  lease: Instant;
}

/** Per-lock state when this node acts as a requester (wants the lock). */
interface RequesterState {
  req: RequestId;
  votes: Set<NodeId>;
  /** Unlocked: max fence seen from granters. Locked: the chosen token. */
  bestFence: Fence;
  locked: boolean;
  nextRenew: Instant;
}

const newArbiter = (): ArbiterState => ({
  votedFor: null,
  inquired: false,
  queue: new ReqQueue(),
  fenceMax: 0,
  lease: 0,
});

/** A grant decision produced while mutating arbiter state. */
interface GrantOut {
  to: NodeId;
  req: RequestId;
  fence: Fence;
}

/**
 * One node's quorum/vote mutual-exclusion state machine. Pure logic — no I/O.
 *
 * Safety (mutual exclusion) comes from quorum intersection + single-vote-held;
 * deadlock-freedom from Lamport-timestamp INQUIRE/YIELD preemption; a
 * downstream backstop from strictly-monotonic per-lock fence tokens. Physical
 * time enters only via {@link LMXConsensusNode.tick} for lease expiry on the
 * failure path; the happy path is clock-free.
 *
 * Drive it: {@link request}/{@link release} to express intent, {@link handle}
 * to feed an inbound message, {@link tick} to advance time, then
 * {@link drainOutbox} to collect what it wants to send. {@link takeAcquired}
 * reports locks just entered; {@link takeLost} reports locks lost to a lapse.
 */
/**
 * How a requester chooses which arbiters to collect votes from, and how many it
 * needs. Safety in every policy rests on the same invariant: any two
 * requesters' fully-granted vote sets must intersect, so a single arbiter would
 * have to grant its one vote twice — impossible. Only the quorum *shape* differs.
 * See `live-mutex-mills.rs/docs/sqrt-n-quorum-design.md`.
 *
 *  - `'majority'`: ask every member, acquire on `floor(n/2)+1`. O(n) messages.
 *  - `'grid'`: √n Maekawa — pack members row-major into a ceil(√n)×ceil(√n)
 *    grid; a node's quorum is its row ∪ column (≈ 2√n−1 nodes, all of which
 *    must grant). Any two row∪column sets intersect. O(√n) messages.
 *
 * SAFETY: the policy MUST be identical on every node in a cluster. A 'grid'
 * quorum and a 'majority' quorum are NOT guaranteed to intersect, so a mixed
 * cluster can grant the same lock to two holders. Never switch policy with a
 * rolling update; drain and restart the whole cluster instead.
 */
export type QuorumPolicy = 'majority' | 'grid';

/**
 * The √n grid quorum for `id`: every member sharing its row or its column when
 * the membership is packed row-major into a ceil(√n)×ceil(√n) grid. Includes `id`.
 *
 * The grid is a function of the membership SET, NOT the order of the input array:
 * `members` is sorted (numerically) before placement. This is a SAFETY
 * requirement — differently-ordered member lists on different nodes could yield
 * row∪column quorums that fail to intersect, letting two nodes hold one lock.
 * Sorting makes every node compute the identical grid with no coordination.
 */
export function gridQuorum(id: NodeId, members: ReadonlyArray<NodeId>): NodeId[] {
  const n = members.length;
  let side = 1;
  while (side * side < n) {
    side++;
  }
  // Canonical, order-independent layout: sort numerically (NOT default
  // lexicographic sort, which would order 10 before 2 and break the grid).
  const sorted = members.slice().sort((a, b) => a - b);
  const idx = sorted.indexOf(id);
  if (idx < 0) {
    throw new Error('gridQuorum: id must be a member');
  }
  const row = Math.floor(idx / side);
  const col = idx % side;
  const seen = new Set<NodeId>();
  const q: NodeId[] = [];
  for (let c = 0; c < side; c++) {
    const i = row * side + c;
    if (i < n && !seen.has(sorted[i])) {
      seen.add(sorted[i]);
      q.push(sorted[i]);
    }
  }
  for (let r = 0; r < side; r++) {
    const i = r * side + col;
    if (i < n && !seen.has(sorted[i])) {
      seen.add(sorted[i]);
      q.push(sorted[i]);
    }
  }
  return q;
}

export class LMXConsensusNode {
  readonly id: NodeId;
  /** Full cluster membership (sender validation + grid construction). */
  private readonly members: ReadonlyArray<NodeId>;
  /** Arbiters this node (as requester) asks/renews/releases at. */
  private readonly targets: ReadonlyArray<NodeId>;
  /** Grants needed to hold a lock (majority count, or |row∪col| under grid). */
  private readonly threshold: number;
  /** `targets` as a set, for O(1) membership checks on the grant/revoke hot path
   * and as a safety guard: votes are only counted from nodes in this set, so
   * `votes.size >= threshold` can never be satisfied by a grant from OUTSIDE the
   * quorum (which would break the quorum-intersection invariant). */
  private readonly targetSet: Set<NodeId>;
  private readonly policy: QuorumPolicy;
  private lamport: Lamport = 0;
  private readonly arbiter = new Map<LockId, ArbiterState>();
  private readonly requester = new Map<LockId, RequesterState>();
  private outbox: Outgoing[] = [];
  private acquired: Acquired[] = [];
  private lostLocks: LockId[] = [];
  private now: Instant = 0;

  constructor(
    id: NodeId,
    members: ReadonlyArray<NodeId>,
    policy: QuorumPolicy = 'majority',
  ) {
    validateMembers(id, members);
    this.id = id;
    this.members = members.slice();
    this.policy = policy;
    if (policy === 'grid') {
      this.targets = gridQuorum(id, this.members);
      this.threshold = this.targets.length;
    } else {
      this.targets = this.members;
      this.threshold = Math.floor(members.length / 2) + 1;
    }
    this.targetSet = new Set(this.targets);
  }

  /** Grants needed to hold a lock: `floor(n/2)+1` (majority) or `|row∪col|` (grid). */
  quorumSize(): number {
    return this.threshold;
  }

  /** The arbiters this node collects votes from (all members, or its row∪col). */
  quorumMembers(): ReadonlyArray<NodeId> {
    return this.targets;
  }

  /** This node's quorum policy. */
  quorumPolicy(): QuorumPolicy {
    return this.policy;
  }

  /** Begin acquiring `lock`; sends a vote request to this node's quorum
   * (every member under majority; its row∪column under grid). */
  request(now: Instant, lock: LockId): void {
    this.now = now;
    if (this.requester.has(lock)) {
      return;
    }
    const ts = this.lamportTick();
    const req: RequestId = {ts, node: this.id};
    this.requester.set(lock, {
      req,
      votes: new Set<NodeId>(),
      bestFence: 0,
      locked: false,
      nextRenew: now + RENEW_INTERVAL,
    });
    for (const m of this.targets) {
      this.send(m, {type: ConsensusMsgType.Request, lock, req});
    }
  }

  /** Release a held (or in-flight) lock, freeing votes at every arbiter. */
  release(now: Instant, lock: LockId): void {
    this.now = now;
    const state = this.requester.get(lock);
    if (!state) {
      return;
    }
    this.requester.delete(lock);
    const fence = state.bestFence;
    for (const m of this.targets) {
      this.send(m, {type: ConsensusMsgType.Release, lock, req: state.req, fence});
    }
  }

  /** Feed an inbound message; `from` is the sender, `now` the current time. */
  handle(now: Instant, from: NodeId, msg: ConsensusMessage): void {
    this.now = now;
    if (!isConsensusMessage(msg) || !this.validInbound(from, msg)) {
      return;
    }
    switch (msg.type) {
      case ConsensusMsgType.Request:
        return this.onRequest(msg.lock, msg.req);
      case ConsensusMsgType.Grant:
        return this.onGrant(from, msg.lock, msg.req, msg.fence);
      case ConsensusMsgType.Inquire:
        return this.onInquire(from, msg.lock, msg.req);
      case ConsensusMsgType.Yield:
        return this.onYield(msg.lock, msg.req);
      case ConsensusMsgType.Confirm:
        return this.onConfirm(msg.lock, msg.fence);
      case ConsensusMsgType.Release:
        return this.onRelease(msg.lock, msg.req, msg.fence);
      case ConsensusMsgType.Renew:
        return this.onRenew(msg.lock, msg.req);
      case ConsensusMsgType.Revoked:
        return this.onRevoked(from, msg.lock, msg.req);
      default:
        return assertNever(msg);
    }
  }

  /**
   * Advance time. Reclaims votes whose holders stopped renewing, and emits
   * renewals for votes this node still holds. Call periodically.
   */
  tick(now: Instant): void {
    this.now = now;

    // Arbiter role: reclaim any votee whose lease lapsed.
    const revoked: Array<{to: NodeId; lock: LockId; req: RequestId}> = [];
    const grants: Array<{lock: LockId; g: GrantOut}> = [];
    for (const [lock, a] of this.arbiter) {
      if (a.votedFor !== null && now >= a.lease) {
        revoked.push({to: a.votedFor.node, lock, req: a.votedFor});
        const g = grantNext(a, now);
        if (g) {
          grants.push({lock, g});
        }
      }
    }
    for (const {to, lock, req} of revoked) {
      this.send(to, {type: ConsensusMsgType.Revoked, lock, req});
    }
    for (const {lock, g} of grants) {
      this.send(g.to, {type: ConsensusMsgType.Grant, lock, req: g.req, fence: g.fence});
    }

    // Bound memory: drop arbiter entries that are fully idle AND never recorded a
    // fence (e.g. created by a spurious Request/Confirm{fence:0} for a lock name
    // that was never really held). We must NOT prune entries with fenceMax>0 —
    // that would reset the fence for a previously-used lock and let a token be
    // reused, defeating the downstream backstop.
    for (const [lock, a] of this.arbiter) {
      if (a.votedFor === null && a.queue.isEmpty() && a.fenceMax === 0) {
        this.arbiter.delete(lock);
      }
    }

    // Requester role: renew held votes, and re-broadcast any request still
    // acquiring. Re-broadcasting recovers a Request lost while a link was
    // churning (e.g. a rolling restart): receivers de-duplicate it and the
    // RequestId is unchanged, so queue fairness is preserved. (A lost Grant
    // self-heals separately via arbiter lease expiry.)
    const renews: Array<{to: NodeId; lock: LockId; req: RequestId}> = [];
    const rebroadcasts: Array<{lock: LockId; req: RequestId}> = [];
    for (const [lock, r] of this.requester) {
      if (now >= r.nextRenew) {
        r.nextRenew = now + RENEW_INTERVAL;
        for (const v of r.votes) {
          renews.push({to: v, lock, req: r.req});
        }
        if (!r.locked && r.votes.size < this.threshold) {
          rebroadcasts.push({lock, req: r.req});
        }
      }
    }
    for (const {to, lock, req} of renews) {
      this.send(to, {type: ConsensusMsgType.Renew, lock, req});
    }
    for (const {lock, req} of rebroadcasts) {
      for (const m of this.targets) {
        this.send(m, {type: ConsensusMsgType.Request, lock, req});
      }
    }
  }

  /** Take everything the node wants to send since the last drain. */
  drainOutbox(): Outgoing[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** Take the locks newly entered since the last call, each with its token. */
  takeAcquired(): Acquired[] {
    const out = this.acquired;
    this.acquired = [];
    return out;
  }

  /** Take the locks lost since the last call (lease lapsed; another took over). */
  takeLost(): LockId[] {
    const out = this.lostLocks;
    this.lostLocks = [];
    return out;
  }

  // ---- internals -------------------------------------------------------

  private lamportTick(): Lamport {
    this.lamport += 1;
    return this.lamport;
  }

  private observe(ts: Lamport): void {
    if (ts > this.lamport) {
      this.lamport = ts;
    }
  }

  private send(to: NodeId, msg: ConsensusMessage): void {
    this.outbox.push({to, msg});
  }

  private isMember(id: NodeId): boolean {
    return this.members.indexOf(id) >= 0;
  }

  private validInbound(from: NodeId, msg: ConsensusMessage): boolean {
    if (!this.isMember(from) || !this.isMember(msg.req.node)) {
      return false;
    }
    switch (msg.type) {
      case ConsensusMsgType.Request:
      case ConsensusMsgType.Yield:
      case ConsensusMsgType.Confirm:
      case ConsensusMsgType.Release:
      case ConsensusMsgType.Renew:
        return from === msg.req.node;
      case ConsensusMsgType.Grant:
      case ConsensusMsgType.Inquire:
      case ConsensusMsgType.Revoked:
        return msg.req.node === this.id;
      default:
        return assertNever(msg);
    }
  }

  // ---- arbiter role ----------------------------------------------------

  private onRequest(lock: LockId, req: RequestId): void {
    this.observe(req.ts);
    const now = this.now;
    let a = this.arbiter.get(lock);
    if (!a) {
      a = newArbiter();
      this.arbiter.set(lock, a);
    }

    if (a.votedFor === null) {
      // Free: grant immediately.
      a.votedFor = req;
      a.lease = now + LEASE;
      this.send(req.node, {type: ConsensusMsgType.Grant, lock, req, fence: a.fenceMax});
      return;
    }

    const current = a.votedFor;
    if (reqEq(current, req)) {
      return; // duplicate of the current votee
    }
    a.queue.insert(req);
    // A strictly-smaller request should preempt the votee.
    if (reqLt(req, current) && !a.inquired) {
      a.inquired = true;
      this.send(current.node, {type: ConsensusMsgType.Inquire, lock, req: current});
    }
  }

  private onYield(lock: LockId, req: RequestId): void {
    const now = this.now;
    const a = this.arbiter.get(lock);
    if (!a || a.votedFor === null || !reqEq(a.votedFor, req)) {
      return; // stale yield
    }
    // The yielder rejoins the queue; grant to whoever is now smallest.
    a.queue.insert(req);
    a.inquired = false;
    a.votedFor = null;
    const g = grantNext(a, now);
    if (g) {
      this.send(g.to, {type: ConsensusMsgType.Grant, lock, req: g.req, fence: g.fence});
    }
  }

  private onConfirm(lock: LockId, fence: Fence): void {
    let a = this.arbiter.get(lock);
    if (!a) {
      a = newArbiter();
      this.arbiter.set(lock, a);
    }
    if (fence > a.fenceMax) {
      a.fenceMax = fence;
    }
  }

  private onRelease(lock: LockId, req: RequestId, fence: Fence): void {
    const now = this.now;
    const a = this.arbiter.get(lock);
    if (!a) {
      return;
    }
    // Record the departing holder's token BEFORE granting next, so the next
    // holder's grant carries a strictly-greater fence.
    if (fence > a.fenceMax) {
      a.fenceMax = fence;
    }
    // Evict the releasing request wherever it sits — including the queue: a
    // request can acquire/release via a quorum that excluded this arbiter while
    // still lingering in its queue (it yielded this vote earlier). Without this
    // we'd later grant our vote to a dead request and stick forever.
    a.queue.remove(req);
    if (a.votedFor === null || !reqEq(a.votedFor, req)) {
      return; // not the current votee; queue eviction was enough
    }
    a.inquired = false;
    a.votedFor = null;
    const g = grantNext(a, now);
    if (g) {
      this.send(g.to, {type: ConsensusMsgType.Grant, lock, req: g.req, fence: g.fence});
    }
  }

  // ---- requester role --------------------------------------------------

  private onGrant(from: NodeId, lock: LockId, req: RequestId, fence: Fence): void {
    // Safety guard: only count votes from arbiters in our quorum set, so a grant
    // from outside the quorum can never contribute to reaching `threshold`.
    if (!this.targetSet.has(from)) {
      return;
    }
    const r = this.requester.get(lock);
    if (!r || !reqEq(r.req, req)) {
      return; // grant for a superseded request
    }

    if (r.locked) {
      // Late grant after locking: count the voter (so we release its vote
      // later) and record our token at it too.
      r.votes.add(from);
      this.send(from, {type: ConsensusMsgType.Confirm, lock, req, fence: r.bestFence});
      return;
    }

    r.votes.add(from);
    if (fence > r.bestFence) {
      r.bestFence = fence;
    }
    if (r.votes.size >= this.threshold) {
      // Quorum reached — enter the critical section.
      r.locked = true;
      // Clamp at MAX_SAFE_INTEGER so a poisoned/huge bestFence can't push the
      // token into the imprecise-float range (where token+1 === token), which
      // would let two holders observe the same fence. (Rust uses saturating_add.)
      const token = Math.min(r.bestFence + 1, Number.MAX_SAFE_INTEGER);
      r.bestFence = token;
      this.acquired.push({lock, fence: token});
      for (const to of r.votes) {
        this.send(to, {type: ConsensusMsgType.Confirm, lock, req, fence: token});
      }
    }
  }

  private onInquire(from: NodeId, lock: LockId, req: RequestId): void {
    const r = this.requester.get(lock);
    if (!r || !reqEq(r.req, req)) {
      return;
    }
    // Yield only if we have NOT yet locked. A holder keeps its votes until it
    // releases — this is what lets the globally-smallest request always win and
    // keeps exclusion intact.
    if (!r.locked) {
      r.votes.delete(from);
      this.send(from, {type: ConsensusMsgType.Yield, lock, req});
    }
  }

  // ---- lease maintenance ----------------------------------------------

  private onRenew(lock: LockId, req: RequestId): void {
    const now = this.now;
    const a = this.arbiter.get(lock);
    if (a && a.votedFor !== null && reqEq(a.votedFor, req)) {
      a.lease = now + LEASE;
      return;
    }
    // We no longer vote for this requester — tell it so.
    this.send(req.node, {type: ConsensusMsgType.Revoked, lock, req});
  }

  private onRevoked(from: NodeId, lock: LockId, req: RequestId): void {
    // Mirror the onGrant guard: only quorum members ever held our votes.
    if (!this.targetSet.has(from)) {
      return;
    }
    const r = this.requester.get(lock);
    if (!r || !reqEq(r.req, req)) {
      return;
    }
    r.votes.delete(from);
    if (r.locked && r.votes.size < this.threshold) {
      this.requester.delete(lock);
      const fence = r.bestFence;
      for (const m of this.targets) {
        this.send(m, {type: ConsensusMsgType.Release, lock, req: r.req, fence});
      }
      this.lostLocks.push(lock);
    }
  }
}

/**
 * Grant the vote to the smallest waiting request, if any. Updates `votedFor`
 * (to the chosen request, or `null` if the queue is empty), arms a fresh lease,
 * and returns the grant to send.
 */
function grantNext(a: ArbiterState, now: Instant): GrantOut | null {
  a.inquired = false;
  const next = a.queue.popMin();
  if (next === undefined) {
    a.votedFor = null;
    return null;
  }
  a.votedFor = next;
  a.lease = now + LEASE;
  return {to: next.node, req: next, fence: a.fenceMax};
}

function assertNever(x: never): never {
  throw new Error(`unreachable consensus message: ${JSON.stringify(x)}`);
}

function validateMembers(id: NodeId, members: ReadonlyArray<NodeId>): void {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('node id must be a non-negative integer');
  }
  if (members.length === 0) {
    throw new Error('members must not be empty');
  }
  const seen = new Set<NodeId>();
  for (const m of members) {
    if (!Number.isInteger(m) || m < 0) {
      throw new Error('members must be non-negative integers');
    }
    if (seen.has(m)) {
      throw new Error('members must be unique');
    }
    seen.add(m);
  }
  if (!seen.has(id)) {
    throw new Error('members must include the local node id');
  }
}
