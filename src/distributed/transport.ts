'use strict';

import * as net from 'net';
import {EventEmitter} from 'events';

import {ConsensusMessage, isConsensusMessage} from './messages';
import {LMXConsensusNode, QuorumPolicy} from './node';
import {Instant, LockId, NodeId} from './request-id';

/**
 * A TCP transport that runs an {@link LMXConsensusNode} across real sockets —
 * the TypeScript port of the Rust `transport.rs`.
 *
 * Each ordered pair of nodes communicates over a single TCP connection (the one
 * the *sender* dialed), giving the FIFO-per-link ordering the protocol requires:
 * dialed (outbound) connections are used for writing, accepted (inbound) ones
 * for reading. Node.js's single event loop already serializes all access to the
 * `LMXConsensusNode`, so there is no locking.
 *
 * Wall-clock time (ms since construction) is fed into the node, driving lease
 * renewal/expiry. The happy path is unaffected by the clock.
 *
 * Events: `acquired(lock, fence)`, `lost(lock)`, `info(msg)`.
 */
export class LMXDistributedNode extends EventEmitter {
  readonly id: NodeId;
  private readonly members: ReadonlyArray<NodeId>;
  private readonly addresses: ReadonlyArray<string>;
  private readonly tickMs: number;
  private readonly node: LMXConsensusNode;
  private readonly startTime = Date.now();

  private server: net.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Dialed (write-only) connection per peer. */
  private readonly writers = new Map<NodeId, net.Socket>();
  /** Messages buffered (in order) for a peer we haven't connected to yet. */
  private readonly pending = new Map<NodeId, ConsensusMessage[]>();

  constructor(
    id: NodeId,
    addresses: ReadonlyArray<string>,
    tickMs = 500,
    policy: QuorumPolicy = 'majority',
  ) {
    super();
    this.id = id;
    this.addresses = addresses.slice();
    this.members = addresses.map((_, i) => i);
    this.tickMs = tickMs;
    this.node = new LMXConsensusNode(id, this.members, policy);
  }

  /** Bind, dial peers, and start the lease timer. Resolves once listening. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const [host, port] = parseAddr(this.addresses[this.id]);
      const server = net.createServer((sock) => this.onAccept(sock));
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        this.server = server;
        for (let p = 0; p < this.members.length; p++) {
          if (p !== this.id) {
            this.dial(p);
          }
        }
        this.timer = setInterval(() => {
          this.node.tick(this.now());
          this.pump();
        }, this.tickMs);
        resolve();
      });
    });
  }

  /** Tear down sockets and timers. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const w of this.writers.values()) {
      w.destroy();
    }
    this.writers.clear();
  }

  /** Begin acquiring `lock`. Emits `acquired(lock, fence)` once held. */
  acquire(lock: LockId): void {
    this.node.request(this.now(), lock);
    this.pump();
  }

  /** Release a held lock. */
  release(lock: LockId): void {
    this.node.release(this.now(), lock);
    this.pump();
  }

  // ---- internals -------------------------------------------------------

  private now(): Instant {
    return Date.now() - this.startTime;
  }

  /**
   * Drive the node's outbox to empty, delivering self-addressed messages inline
   * (still FIFO for this node) and writing peer-addressed ones to sockets. Then
   * surface acquisitions and losses as events.
   */
  private pump(): void {
    let out = this.node.drainOutbox();
    while (out.length > 0) {
      for (const {to, msg} of out) {
        if (to === this.id) {
          this.node.handle(this.now(), this.id, msg);
        } else {
          this.sendToPeer(to, msg);
        }
      }
      out = this.node.drainOutbox();
    }
    for (const a of this.node.takeAcquired()) {
      this.emit('acquired', a.lock, a.fence);
    }
    for (const lock of this.node.takeLost()) {
      this.emit('lost', lock);
    }
  }

  private sendToPeer(to: NodeId, msg: ConsensusMessage): void {
    const w = this.writers.get(to);
    if (w && !w.destroyed) {
      w.write(JSON.stringify(msg) + '\n');
      return;
    }
    let buf = this.pending.get(to);
    if (!buf) {
      buf = [];
      this.pending.set(to, buf);
    }
    buf.push(msg);
  }

  /** Dial a peer (with retry). The dialed socket is used for writing only. */
  private dial(peer: NodeId): void {
    if (this.stopped) {
      return;
    }
    const [host, port] = parseAddr(this.addresses[peer]);
    const sock = net.connect({host, port}, () => {
      sock.write(JSON.stringify({hello: this.id}) + '\n');
      this.writers.set(peer, sock);
      const buf = this.pending.get(peer);
      if (buf) {
        for (const m of buf) {
          sock.write(JSON.stringify(m) + '\n');
        }
        this.pending.delete(peer);
      }
      this.emit('info', `connected to node ${peer}`);
    });
    sock.on('error', () => {
      /* 'close' follows; reconnect handled there */
    });
    sock.on('close', () => {
      if (this.writers.get(peer) === sock) {
        this.writers.delete(peer);
      }
      if (!this.stopped) {
        setTimeout(() => this.dial(peer), 150);
      }
    });
  }

  /** Accept an inbound (read-only) connection: `{hello:id}` then messages. */
  private onAccept(sock: net.Socket): void {
    let peer: NodeId | null = null;
    frameJsonLines(sock, (obj: any) => {
      if (peer === null) {
        if (typeof obj.hello === 'number') {
          peer = obj.hello;
        }
        return;
      }
      if (isConsensusMessage(obj)) {
        this.node.handle(this.now(), peer, obj);
        this.pump();
      }
    });
  }
}

/** Parse `host:port` (host may itself contain colons in theory; split last). */
function parseAddr(addr: string): [string, number] {
  const i = addr.lastIndexOf(':');
  return [addr.slice(0, i), Number(addr.slice(i + 1))];
}

/**
 * Read newline-delimited JSON objects off a socket, buffering partial lines.
 * (The Broker1 integration will instead reuse the project's `createParser`.)
 */
const MAX_JSON_FRAME = 1024 * 1024;

function frameJsonLines(sock: net.Socket, onObj: (obj: any) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_JSON_FRAME) {
      sock.destroy();
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length === 0) {
        continue;
      }
      if (line.length > MAX_JSON_FRAME) {
        sock.destroy();
        return;
      }
      try {
        onObj(JSON.parse(line));
      } catch {
        /* ignore malformed frame */
      }
    }
  });
  sock.on('error', () => {
    /* drop */
  });
}
