'use strict';

// Tests for the √n grid (true Maekawa) quorum policy — the TS port of the Rust
// crate's tests/quorum_grid.rs. Two halves:
//   1. the safety-critical structural property: any two grid quorums intersect;
//   2. the full mutual-exclusion / progress / fence-monotonicity property test
//      driven under the 'grid' policy.
// Run after compiling: `node dist/test/distributed/quorum-grid-test.js`.

import * as assert from 'assert';
import {Sim} from '../../src/distributed/sim';
import {gridQuorum} from '../../src/distributed/node';
import {Fence, NodeId} from '../../src/distributed/request-id';

// ---- 1. intersection -------------------------------------------------------

function assertPairwiseIntersection(n: number): void {
  const members: NodeId[] = [];
  for (let i = 0; i < n; i++) {
    members.push(i);
  }
  const quorums = members.map((id) => new Set(gridQuorum(id, members)));
  for (let i = 0; i < n; i++) {
    assert.ok(quorums[i].has(i), `n=${n}: ${i} not in its own quorum`);
    for (let j = 0; j < n; j++) {
      let shared = false;
      for (const x of quorums[i]) {
        if (quorums[j].has(x)) {
          shared = true;
          break;
        }
      }
      assert.ok(shared, `n=${n}: Q_${i} and Q_${j} do not intersect — safety would break`);
    }
  }
}

function gridIntersectionSquaresAndNonSquares(): void {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 17, 24, 25, 26, 31, 36]) {
    assertPairwiseIntersection(n);
  }
}

function gridQuorumSizeForSquares(): void {
  for (let s = 2; s <= 8; s++) {
    const n = s * s;
    const members: NodeId[] = [];
    for (let i = 0; i < n; i++) {
      members.push(i);
    }
    const q = gridQuorum(0, members);
    assert.strictEqual(q.length, 2 * s - 1, `n=${n}: |Q| should be 2*${s}-1`);
    assert.ok(q.length <= Math.floor(n / 2) + 1, `n=${n}: grid quorum not <= majority`);
  }
}

// ---- 2. mutual exclusion under grid policy ---------------------------------

const HOLD = 4;

function runGrid(n: number, seed: number, reqs: Array<[NodeId, string]>): void {
  const sim = new Sim(n, seed, 'grid');
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
    for (const {node, lock, fence} of sim.drainAcquired()) {
      assert.ok(
        !holder.has(lock),
        `MUTUAL EXCLUSION VIOLATED on ${lock}: node ${holder.get(lock)} holds it while ${node} acquires (grid, seed ${seed})`,
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

    if (sim.step()) {
      steps++;
      assert.ok(steps < 5_000_000, `livelock: no termination (grid, seed ${seed})`);
      continue;
    }
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
  assert.strictEqual(totalAcquired, total, `progress: only ${totalAcquired} of ${total} acquired (grid, seed ${seed})`);
  for (const [lock, seq] of tokens) {
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] > seq[i - 1], `fence tokens not strictly increasing on ${lock}: ${seq} (grid, seed ${seed})`);
    }
  }
}

function gridSingleLockManySizes(): void {
  for (const n of [4, 5, 9, 10, 16, 17]) {
    const reqs: Array<[NodeId, string]> = [];
    for (let i = 0; i < n; i++) {
      reqs.push([i, 'hot']);
    }
    for (let seed = 1; seed < 40; seed++) {
      runGrid(n, seed * 2654435761 + n, reqs);
    }
  }
}

function gridIndependentLocks(): void {
  const reqs: Array<[NodeId, string]> = [];
  for (let i = 0; i < 9; i++) {
    reqs.push([i, ['a', 'b', 'c'][i % 3]]);
  }
  for (let seed = 1; seed < 30; seed++) {
    runGrid(9, seed * 16777619 + 0xabcd, reqs);
  }
}

gridIntersectionSquaresAndNonSquares();
console.log('  ok  grid_quorums_pairwise_intersect (squares + non-squares)');
gridQuorumSizeForSquares();
console.log('  ok  grid_quorum_size_is_2sqrt_n_for_squares');
gridSingleLockManySizes();
console.log('  ok  grid_single_lock_all_nodes_contend (n in {4,5,9,10,16,17})');
gridIndependentLocks();
console.log('  ok  grid_independent_locks_run_in_parallel');
console.log('quorum-grid: ALL PASS');
