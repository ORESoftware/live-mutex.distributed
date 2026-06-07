'use strict';

import {Acquired, ConsensusMessage, RENEW_INTERVAL} from './messages';
import {LMXConsensusNode} from './node';
import {Fence, Instant, LockId, NodeId} from './request-id';

/**
 * A deterministic in-memory simulator with FIFO-per-link delivery (= TCP).
 *
 * The protocol requires FIFO point-to-point channels: an arbiter may send
 * `Grant→A` then `Inquire→A`, and reordering those could let two requesters
 * reach a quorum. So the sim keeps one queue per directed link and, each step,
 * delivers the head of a randomly chosen link — preserving per-link order while
 * interleaving links and locks. `clock` is fixed during delivery and only moves
 * via {@link advance}, so lease behaviour is exercised deliberately.
 */
export class Sim {
  readonly nodes: LMXConsensusNode[];
  private readonly links = new Map<string, ConsensusMessage[]>();
  private readonly dead = new Set<NodeId>();
  private clock: Instant = 0;
  private rng: number;

  constructor(n: number, seed = 0x9e3779b9) {
    const members: NodeId[] = [];
    for (let i = 0; i < n; i++) {
      members.push(i);
    }
    this.nodes = members.map((id) => new LMXConsensusNode(id, members));
    this.rng = (seed >>> 0) || 0x1234_5678;
  }

  now(): Instant {
    return this.clock;
  }

  /** Crash `node`: it stops sending/receiving/ticking; its in-flight messages
   *  are dropped. Its votes elsewhere lapse and are reclaimed once time moves. */
  crash(node: NodeId): void {
    this.dead.add(node);
    for (const key of [...this.links.keys()]) {
      const [from, to] = key.split('-').map(Number);
      if (from === node || to === node) {
        this.links.delete(key);
      }
    }
  }

  request(node: NodeId, lock: LockId): void {
    if (this.dead.has(node)) {
      return;
    }
    this.nodes[node].request(this.clock, lock);
    this.collect(node);
  }

  release(node: NodeId, lock: LockId): void {
    if (this.dead.has(node)) {
      return;
    }
    this.nodes[node].release(this.clock, lock);
    this.collect(node);
  }

  /**
   * Advance logical time by `dt`, in sub-lease increments so live nodes get to
   * renew (and have those renewals delivered) before any lease lapses. Only a
   * node that has stopped ticking — i.e. crashed — loses its votes.
   */
  advance(dt: Instant): void {
    const target = this.clock + dt;
    while (this.clock < target) {
      this.clock = Math.min(this.clock + RENEW_INTERVAL, target);
      for (let id = 0; id < this.nodes.length; id++) {
        if (!this.dead.has(id)) {
          this.nodes[id].tick(this.clock);
          this.collect(id);
        }
      }
      while (this.step()) {
        /* drain */
      }
    }
  }

  /** Deliver one message: the head of a randomly chosen non-empty link.
   *  Returns false when the network is idle. */
  step(): boolean {
    const active: string[] = [];
    for (const [key, q] of this.links) {
      if (q.length > 0) {
        active.push(key);
      }
    }
    if (active.length === 0) {
      return false;
    }
    active.sort(); // HashMap order is unstable; sort for determinism
    const key = active[this.nextRand() % active.length];
    const [from, to] = key.split('-').map(Number);
    const msg = this.links.get(key)!.shift()!;
    this.nodes[to].handle(this.clock, from, msg);
    this.collect(to);
    return true;
  }

  idle(): boolean {
    for (const q of this.links.values()) {
      if (q.length > 0) {
        return false;
      }
    }
    return true;
  }

  /** Drain locks newly acquired across all nodes since the last call. */
  drainAcquired(): Array<{node: NodeId; lock: LockId; fence: Fence}> {
    const out: Array<{node: NodeId; lock: LockId; fence: Fence}> = [];
    for (const n of this.nodes) {
      for (const a of n.takeAcquired() as Acquired[]) {
        out.push({node: n.id, lock: a.lock, fence: a.fence});
      }
    }
    return out;
  }

  private collect(from: NodeId): void {
    for (const {to, msg} of this.nodes[from].drainOutbox()) {
      if (this.dead.has(from) || this.dead.has(to)) {
        continue; // fail-stop + partition
      }
      const key = `${from}-${to}`;
      let q = this.links.get(key);
      if (!q) {
        q = [];
        this.links.set(key, q);
      }
      q.push(msg);
    }
  }

  private nextRand(): number {
    // mulberry32 — deterministic, returns a non-negative 32-bit int.
    let t = (this.rng += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }
}
