'use strict';

// lmxd — a live-mutex.distributed consensus node over TCP (TS port of the Rust
// `lmxd` binary).
//
// Usage:
//   node dist/src/distributed/lmxd.js <my_id> <addr_0> <addr_1> ... <addr_{n-1}>
//
// Then type on stdin:  acquire <lock> | release <lock> | quit

import * as readline from 'readline';
import {LMXDistributedNode} from './transport';
import {Composite} from './composite';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('usage: lmxd <my_id> <addr_0> <addr_1> ... <addr_{n-1}>');
    process.exit(2);
  }
  const id = Number(argv[0]);
  const addresses = argv.slice(1);
  if (!(id >= 0 && id < addresses.length)) {
    console.error('my_id out of range');
    process.exit(2);
  }

  // Quorum policy: LMX_QUORUM_POLICY=grid selects √n Maekawa (row∪column);
  // anything else (default) keeps majority. Mirrors the Rust lmxd flag.
  const policyRaw = (process.env.LMX_QUORUM_POLICY || 'majority').trim().toLowerCase();
  const policy: 'majority' | 'grid' = policyRaw === 'grid' ? 'grid' : 'majority';
  const node = new LMXDistributedNode(id, addresses, 500, policy);

  // Optional self-test workload (LMX_DEMO=1): every node repeatedly acquires the
  // SAME composite (multi-key) lock under contention, so logs show exclusive
  // handoff across peers with strictly-increasing per-key fences.
  const demoEnabled = !!process.env.LMX_DEMO && process.env.LMX_DEMO !== '0';
  const demoKeys = (process.env.LMX_DEMO_KEYS || 'cap,mid,zed')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let current: Composite | null = null;
  let onHeld: (() => void) | null = null;

  node.on('acquired', (lock: string, fence: number) => {
    console.log(`ACQUIRED ${lock} fence=${fence}`);
    if (!current) {
      return;
    }
    const p = current.onAcquired(lock, fence);
    if (p.kind === 'next') {
      node.acquire(p.key);
    } else if (p.kind === 'held') {
      const parts = current.keys.map((k) => `${k}=${current!.fence(k)}`).join(', ');
      console.log(`DEMO COMPOSITE HELD [${parts}]`);
      onHeld?.();
    }
  });
  node.on('lost', (lock: string) => console.log(`LOST ${lock}`));
  node.on('info', (msg: string) => console.log(`# ${msg}`));

  async function demoLoop(): Promise<void> {
    for (;;) {
      const c = Composite.create(demoKeys);
      current = c;
      const held = new Promise<void>((res) => {
        onHeld = res;
      });
      node.acquire(c.pending()!);
      await held;
      onHeld = null;
      await sleep(800);
      for (const k of c.keys) {
        node.release(k);
      }
      current = null;
      await sleep(400);
    }
  }

  node.start().then(() => {
    console.log(`# node ${id} of ${addresses.length} started`);
    if (demoEnabled) {
      void demoLoop();
    }
    const rl = readline.createInterface({input: process.stdin});
    rl.on('line', (line: string) => {
      const [cmd, lock] = line.trim().split(/\s+/);
      if (cmd === 'acquire' && lock) {
        node.acquire(lock);
      } else if (cmd === 'release' && lock) {
        node.release(lock);
      } else if (cmd === 'quit' || cmd === 'exit') {
        node.stop();
        rl.close();
        process.exit(0);
      } else if (cmd) {
        console.error('commands: acquire <lock> | release <lock> | quit');
      }
    });
  }).catch((e: unknown) => {
    console.error('node error:', e);
    process.exit(1);
  });
}

main();
