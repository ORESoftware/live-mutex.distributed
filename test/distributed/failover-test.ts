'use strict';

// Holder-failure recovery via vote leases (ported from the Rust crate's
// tests/failover.rs). When a holder crashes, its votes are reclaimed once their
// leases lapse and a survivor takes over — with a strictly greater fence token,
// so a partitioned zombie is fenced out downstream.
// Run after compiling: `node dist/test/distributed/failover-test.js`.

import * as assert from 'assert';
import {Sim} from '../../src/distributed/sim';
import {LEASE} from '../../src/distributed/messages';
import {Fence, NodeId} from '../../src/distributed/request-id';

/** Step until `node` reports acquiring `lock`; returns its fence token. */
function stepUntilAcquired(sim: Sim, node: NodeId, lock: string): Fence {
  for (let i = 0; i < 1_000_000; i++) {
    for (const a of sim.drainAcquired()) {
      if (a.node === node && a.lock === lock) {
        return a.fence;
      }
    }
    if (!sim.step()) {
      break;
    }
  }
  throw new Error(`node ${node} never acquired ${lock}`);
}

function survivorTakesOverAfterHolderCrash(): void {
  // 3 nodes, quorum 2. Node 0 grabs the lock, then dies; node 1 takes over
  // once node 0's leases lapse, with a strictly greater fence.
  const sim = new Sim(3, 7);

  sim.request(0, 'A');
  const token0 = stepUntilAcquired(sim, 0, 'A');

  sim.request(1, 'A');
  for (let i = 0; i < 1000; i++) {
    if (!sim.step()) {
      break;
    }
  }
  assert.strictEqual(sim.drainAcquired().length, 0, 'node 1 must not acquire while node 0 holds');

  sim.crash(0);
  sim.advance(LEASE * 2);

  const token1 = stepUntilAcquired(sim, 1, 'A');
  assert.ok(token1 > token0, `fence must increase across failover: dead ${token0}, survivor ${token1}`);
}

function contendedFailoverAllSurvivorsAcquire(): void {
  // 5 nodes, quorum 3. Everyone wants "A". The first winner is crashed; the
  // remaining four must still each acquire, with strictly increasing fences.
  const sim = new Sim(5, 13);
  for (let id = 0; id < 5; id++) {
    sim.request(id, 'A');
  }

  const tokens: Fence[] = [];
  let first: NodeId | null = null;
  outer: for (let i = 0; i < 1_000_000; i++) {
    for (const a of sim.drainAcquired()) {
      first = a.node;
      tokens.push(a.fence);
      break outer;
    }
    if (!sim.step()) {
      break;
    }
  }
  assert.ok(first !== null, 'someone should have acquired first');
  const victim = first as NodeId;

  // Settle so the winner's Confirm reaches its quorum (token durable) before it
  // dies. No one else can acquire while it holds.
  while (sim.step()) {
    /* drain */
  }
  assert.strictEqual(sim.drainAcquired().length, 0);

  sim.crash(victim);

  const acquirers = new Set<NodeId>([victim]);
  for (let round = 0; round < 100; round++) {
    while (sim.step()) {
      /* settle */
    }
    let progressed = false;
    for (const a of sim.drainAcquired()) {
      acquirers.add(a.node);
      tokens.push(a.fence);
      sim.release(a.node, 'A');
      progressed = true;
    }
    if (acquirers.size === 5) {
      break;
    }
    if (!progressed) {
      sim.advance(LEASE * 2);
    }
  }

  assert.strictEqual(acquirers.size, 5, `all 5 nodes should have held the lock; got ${[...acquirers]}`);
  for (let i = 1; i < tokens.length; i++) {
    assert.ok(tokens[i] > tokens[i - 1], `fence tokens must strictly increase across failover: ${tokens}`);
  }
}

survivorTakesOverAfterHolderCrash();
console.log('  ok  survivor_takes_over_after_holder_crash');
contendedFailoverAllSurvivorsAcquire();
console.log('  ok  contended_failover_all_survivors_acquire');
console.log('failover: ALL PASS');
