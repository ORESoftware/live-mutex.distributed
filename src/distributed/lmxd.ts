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

  const node = new LMXDistributedNode(id, addresses);
  node.on('acquired', (lock: string, fence: number) => console.log(`ACQUIRED ${lock} fence=${fence}`));
  node.on('lost', (lock: string) => console.log(`LOST ${lock}`));
  node.on('info', (msg: string) => console.log(`# ${msg}`));

  node.start().then(() => {
    console.log(`# node ${id} of ${addresses.length} started`);
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
