'use strict';

// Property tests for the distributed consensus engine (ported from the Rust
// crate's tests/mutual_exclusion.rs): across many randomized FIFO interleavings
// — never two holders, everyone eventually acquires, fence tokens strictly
// increase. Run after compiling: `node dist/test/distributed/mutual-exclusion-test.js`.

import * as assert from 'assert';
import {Sim} from '../../src/distributed/sim';
import {Fence, NodeId} from '../../src/distributed/request-id';

/** Deliveries a lock is held across before release — long enough to overlap. */
const HOLD = 4;

/** Drive a workload of (node, lock) requests to completion, asserting per-lock
 *  exclusion, full progress, and strictly increasing fence tokens. */
function run(n: number, seed: number, reqs: Array<[NodeId, string]>): void {
  const sim = new Sim(n, seed);
  for (const [node, lock] of reqs) {
    sim.request(node, lock);
  }

  const holder = new Map<string, NodeId>();
  const holdLeft = new Map<string, number>();
  const acquired = new Map<string, number>();
  const tokens = new Map<string, Fence[]>();

  const total = reqs.length;
  let steps = 0;

  for (;;) {
    // 1. Observe new acquisitions; assert exclusion.
    for (const {node, lock, fence} of sim.drainAcquired()) {
      assert.ok(
        !holder.has(lock),
        `MUTUAL EXCLUSION VIOLATED on ${lock}: node ${holder.get(lock)} holds it while ${node} acquires (seed ${seed})`,
      );
      holder.set(lock, node);
      holdLeft.set(lock, HOLD);
      acquired.set(lock, (acquired.get(lock) ?? 0) + 1);
      let seq = tokens.get(lock);
      if (!seq) {
        seq = [];
        tokens.set(lock, seq);
      }
      seq.push(fence);
    }

    // 2. Advance held critical sections; release when time is up.
    for (const lock of [...holder.keys()]) {
      const left = holdLeft.get(lock)!;
      if (left === 0) {
        const h = holder.get(lock)!;
        holder.delete(lock);
        holdLeft.delete(lock);
        sim.release(h, lock);
      } else {
        holdLeft.set(lock, left - 1);
      }
    }

    // 3. Deliver one message.
    if (sim.step()) {
      steps++;
      assert.ok(steps < 5_000_000, `livelock: no termination (seed ${seed})`);
      continue;
    }

    // Network idle: release lingering holders to force progress, else done.
    if (holder.size === 0) {
      break;
    }
    for (const lock of [...holder.keys()]) {
      const h = holder.get(lock)!;
      holder.delete(lock);
      holdLeft.delete(lock);
      sim.release(h, lock);
    }
  }

  let totalAcquired = 0;
  for (const c of acquired.values()) {
    totalAcquired += c;
  }
  assert.strictEqual(totalAcquired, total, `progress: only ${totalAcquired} of ${total} acquired (seed ${seed})`);
  for (const [lock, seq] of tokens) {
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] > seq[i - 1], `fence tokens not strictly increasing on ${lock}: ${seq} (seed ${seed})`);
    }
  }
}

function singleLock9NodesManySeeds(): void {
  const reqs: Array<[NodeId, string]> = [];
  for (let i = 0; i < 9; i++) {
    reqs.push([i, 'A']);
  }
  for (let seed = 1; seed < 200; seed++) {
    run(9, seed, reqs);
  }
}

function clusterSizes(): void {
  for (const n of [3, 4, 5, 6, 7, 8, 10, 11]) {
    const reqs: Array<[NodeId, string]> = [];
    for (let i = 0; i < n; i++) {
      reqs.push([i, 'A']);
    }
    for (let seed = 1; seed < 60; seed++) {
      run(n, seed, reqs);
    }
  }
}

function independentLocksRunInParallel(): void {
  const reqs: Array<[NodeId, string]> = [];
  for (let i = 0; i < 9; i++) {
    reqs.push([i, i % 2 === 0 ? 'A' : 'B']);
  }
  for (let seed = 1; seed < 150; seed++) {
    run(9, seed, reqs);
  }
}

function manyNodesContendForManyLocks(): void {
  const reqs: Array<[NodeId, string]> = [];
  for (let i = 0; i < 7; i++) {
    for (const l of ['X', 'Y', 'Z']) {
      reqs.push([i, l]);
    }
  }
  for (let seed = 1; seed < 80; seed++) {
    run(7, seed, reqs);
  }
}

singleLock9NodesManySeeds();
console.log('  ok  single_lock_9_nodes_many_seeds');
clusterSizes();
console.log('  ok  cluster_sizes (odd + even)');
independentLocksRunInParallel();
console.log('  ok  independent_locks_run_in_parallel');
manyNodesContendForManyLocks();
console.log('  ok  many_nodes_contend_for_many_locks');
console.log('mutual-exclusion: ALL PASS');
