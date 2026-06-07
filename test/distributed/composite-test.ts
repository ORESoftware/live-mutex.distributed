'use strict';

// Multi-key / composite locking over the real engine (driven through the
// simulator), ported from the Rust crate's tests/composite.rs. Verifies across
// randomized FIFO interleavings: overlap conflict (composites sharing a key are
// never both held), deadlock-free progress under a cyclic key-sharing workload,
// parallelism for disjoint composites, monotonic per-key fencing, and the 3-key
// cap.
// Run after compiling: `node dist/test/distributed/composite-test.js`

import * as assert from 'assert';
import {Sim} from '../../src/distributed/sim';
import {Composite, canonicalKeys, MAX_COMPOSITE_KEYS} from '../../src/distributed/composite';
import {Fence, NodeId} from '../../src/distributed/request-id';

const HOLD = 4;

/** One composite job per node. Returns the max composites held simultaneously. */
function run(n: number, seed: number, spec: Array<[NodeId, string[]]>): number {
  const sim = new Sim(n, seed);

  const jobs = new Map<NodeId, Composite>();
  for (const [node, keys] of spec) {
    const c = Composite.create(keys);
    sim.request(node, c.pending()!);
    jobs.set(node, c);
  }

  const keyOwner = new Map<string, NodeId>();
  const holdLeft = new Map<NodeId, number>();
  const completed = new Set<NodeId>();
  const fences = new Map<string, Fence[]>();
  let maxConcurrent = 0;

  const total = spec.length;
  let steps = 0;

  for (;;) {
    // 1. Feed acquisitions into the owning composite.
    for (const {node, lock, fence} of sim.drainAcquired()) {
      let seq = fences.get(lock);
      if (!seq) {
        seq = [];
        fences.set(lock, seq);
      }
      seq.push(fence);

      const job = jobs.get(node)!;
      const prog = job.onAcquired(lock, fence);
      if (prog.kind === 'next') {
        sim.request(node, prog.key);
      } else if (prog.kind === 'held') {
        for (const k of job.keys) {
          assert.ok(
            !keyOwner.has(k),
            `COMPOSITE OVERLAP on ${k}: node ${keyOwner.get(k)} holds it while node ${node} holds its composite (seed ${seed})`,
          );
        }
        for (const k of job.keys) {
          keyOwner.set(k, node);
        }
        holdLeft.set(node, HOLD);
        maxConcurrent = Math.max(maxConcurrent, holdLeft.size);
      }
    }

    // 2. Tick down hold timers; release all keys when done.
    for (const node of [...holdLeft.keys()]) {
      const left = holdLeft.get(node)!;
      if (left === 0) {
        holdLeft.delete(node);
        const job = jobs.get(node)!;
        for (const k of job.keys) {
          keyOwner.delete(k);
          sim.release(node, k);
        }
        completed.add(node);
      } else {
        holdLeft.set(node, left - 1);
      }
    }

    // 3. Step, or finish.
    if (sim.step()) {
      steps += 1;
      assert.ok(steps < 5_000_000, `composite livelock (seed ${seed})`);
      continue;
    }
    if (holdLeft.size === 0 && completed.size === total) {
      break;
    }
    if (holdLeft.size === 0 && sim.drainAcquired().length === 0) {
      assert.strictEqual(completed.size, total, `composite progress stalled (seed ${seed})`);
      break;
    }
  }

  assert.strictEqual(completed.size, total, `all composites should complete (seed ${seed})`);
  for (const [key, seq] of fences) {
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] > seq[i - 1], `fence not monotonic on ${key}: ${seq} (seed ${seed})`);
    }
  }
  return maxConcurrent;
}

function cyclicOverlapIsDeadlockFreeAndExclusive(): void {
  const spec: Array<[NodeId, string[]]> = [
    [0, ['A', 'B']],
    [1, ['B', 'C']],
    [2, ['A', 'C']],
    [3, ['C', 'B', 'A']], // unsorted on purpose
    [4, ['A']],
  ];
  for (let seed = 1; seed < 120; seed++) {
    run(5, seed, spec);
  }
}

function disjointCompositesRunInParallel(): void {
  const spec: Array<[NodeId, string[]]> = [
    [0, ['A', 'B']],
    [1, ['C', 'D']],
    [2, ['E', 'F']],
  ];
  let everParallel = false;
  for (let seed = 1; seed < 120; seed++) {
    if (run(5, seed, spec) >= 2) {
      everParallel = true;
    }
  }
  assert.ok(everParallel, 'disjoint composites must be held simultaneously at least once');
}

function threeKeyCompositesUnderContention(): void {
  const spec: Array<[NodeId, string[]]> = [
    [0, ['k1', 'k2', 'k3']],
    [1, ['k2', 'k3', 'k4']],
    [2, ['k3', 'k4', 'k5']],
    [3, ['k1', 'k5']],
  ];
  for (let seed = 1; seed < 100; seed++) {
    run(5, seed, spec);
  }
}

function capIsThree(): void {
  assert.strictEqual(MAX_COMPOSITE_KEYS, 3);
  const four = canonicalKeys(['a', 'b', 'c', 'd']);
  assert.strictEqual(four.ok, false);
  assert.throws(() => Composite.create(['a', 'b', 'c', 'd']));
  // dedupe to 3 is fine; sort applied
  const ok = canonicalKeys(['C', 'A', 'B', 'A']);
  assert.deepStrictEqual(ok.ok && ok.keys, ['A', 'B', 'C']);
}

cyclicOverlapIsDeadlockFreeAndExclusive();
console.log('  ok  cyclic_overlap_is_deadlock_free_and_exclusive');
disjointCompositesRunInParallel();
console.log('  ok  disjoint_composites_run_in_parallel');
threeKeyCompositesUnderContention();
console.log('  ok  three_key_composites_under_contention');
capIsThree();
console.log('  ok  cap_is_three');
console.log('composite: ALL PASS');
