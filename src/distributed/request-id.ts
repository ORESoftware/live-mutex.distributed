'use strict';

// Core scalar types for the distributed (quorum/vote) consensus engine.
// This is the TypeScript backport of the Rust `live-mutex-mills` crate.

export type NodeId = number;
export type LockId = string;
export type Lamport = number;
export type Fence = number;
/** A point in physical time, in milliseconds. Only ever supplied by callers;
 *  the engine never reads a clock itself, and time matters only for lease
 *  expiry on the failure path. */
export type Instant = number;

/**
 * A globally unique, totally ordered request identifier: `(ts, node)`.
 * Smaller Lamport timestamp wins; the node id breaks ties. This total order is
 * what makes the preemption protocol deadlock- and starvation-free.
 */
export interface RequestId {
  readonly ts: Lamport;
  readonly node: NodeId;
}

/** Stable string key for use in `Map`/`Set`. */
export const reqKey = (r: RequestId): string => `${r.ts}.${r.node}`;

export const reqEq = (a: RequestId, b: RequestId): boolean =>
  a.ts === b.ts && a.node === b.node;

/** `< 0` if `a` precedes `b`, `0` if equal, `> 0` otherwise. */
export const reqCmp = (a: RequestId, b: RequestId): number =>
  a.ts !== b.ts ? a.ts - b.ts : a.node - b.node;

export const reqLt = (a: RequestId, b: RequestId): boolean => reqCmp(a, b) < 0;
