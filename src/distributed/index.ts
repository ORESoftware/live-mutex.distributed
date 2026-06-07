'use strict';

// Public surface of the distributed (quorum/vote) consensus engine — the
// TypeScript backport of the Rust `live-mutex-mills` crate.

export {LMXConsensusNode} from './node';
export {LMXDistributedNode} from './transport';
export {Sim} from './sim';
export {Composite, canonicalKeys, MAX_COMPOSITE_KEYS} from './composite';
export type {CompositeError, CanonicalResult, Progress} from './composite';
export {
  ConsensusMsgType,
  LEASE,
  RENEW_INTERVAL,
} from './messages';
export type {ConsensusMessage, Outgoing, Acquired} from './messages';
export type {
  NodeId,
  LockId,
  Lamport,
  Fence,
  Instant,
  RequestId,
} from './request-id';
export {reqKey, reqEq, reqCmp, reqLt} from './request-id';
