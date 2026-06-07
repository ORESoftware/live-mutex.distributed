'use strict';

// End-to-end smoke test of the real TCP transport (TS port of the Rust
// tests/tcp_smoke.rs). Three nodes run in one process, each on its own loopback
// port, talking over actual TCP sockets. All race for one lock; the test
// enforces one-at-a-time entry and strictly increasing fence tokens — i.e. the
// engine behaves over the wire, not just in the simulator.
//
// Run after compiling: `node dist/test/distributed/tcp-smoke-test.js`

import * as assert from 'assert';
import {LMXDistributedNode} from '../../src/distributed/transport';

const ADDRS = ['127.0.0.1:18211', '127.0.0.1:18212', '127.0.0.1:18213'];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const nodes = ADDRS.map((_, id) => new LMXDistributedNode(id, ADDRS));

  const fences: number[] = [];
  let held = 0;

  for (const node of nodes) {
    node.on('acquired', (lock: string, fence: number) => {
      held += 1;
      assert.strictEqual(held, 1, `two holders of ${lock} at once (fence ${fence})`);
      fences.push(fence);
      // Hold briefly, then release so the next contender proceeds.
      setTimeout(() => {
        held -= 1;
        node.release(lock);
      }, 50);
    });
  }

  await Promise.all(nodes.map((n) => n.start()));
  await sleep(600); // let the mesh connect

  for (const n of nodes) {
    n.acquire('A');
  }

  // Wait for all three acquisitions (with a hard timeout).
  const deadline = Date.now() + 15000;
  while (fences.length < 3 && Date.now() < deadline) {
    await sleep(25);
  }

  for (const n of nodes) {
    n.stop();
  }

  assert.strictEqual(fences.length, 3, `all three nodes should acquire over TCP; got ${fences}`);
  for (let i = 1; i < fences.length; i++) {
    assert.ok(fences[i] > fences[i - 1], `fence tokens must strictly increase over TCP: ${fences}`);
  }
  console.log('  ok  three_nodes_over_tcp_take_turns  fences=' + JSON.stringify(fences));
  console.log('tcp-smoke: ALL PASS');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
