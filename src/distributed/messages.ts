'use strict';

import {Fence, Instant, LockId, NodeId, RequestId} from './request-id';

/**
 * How long a granted vote stays valid without a renewal. If a holder stops
 * renewing (crash/partition) its votes are reclaimed after this long.
 */
export const LEASE: Instant = 10_000;
/**
 * How often a requester renews the votes it currently holds. Must be
 * comfortably smaller than {@link LEASE} so a few lost renewals are survivable.
 */
export const RENEW_INTERVAL: Instant = 2_000;

/**
 * Wire-protocol message tags. Mirrors the Rust `Message` enum; string values
 * are stable so cross-runtime ports interoperate (cf. `protocol.ts`).
 */
export enum ConsensusMsgType {
  /** Requester → all arbiters: "please vote for me." */
  Request = 'C_REQUEST',
  /** Arbiter → requester: "you have my vote" (+ the arbiter's highest fence). */
  Grant = 'C_GRANT',
  /** Arbiter → current votee: "someone older wants this; will you yield?" */
  Inquire = 'C_INQUIRE',
  /** Requester → arbiter: "taking my vote back" (only if not yet locked). */
  Yield = 'C_YIELD',
  /** Requester → quorum: record the chosen fence token durably. */
  Confirm = 'C_CONFIRM',
  /** Requester → arbiters: "done, free your vote" (+ token to record first). */
  Release = 'C_RELEASE',
  /** Requester → arbiters: "still alive, extend my vote's lease." */
  Renew = 'C_RENEW',
  /** Arbiter → requester: "your lease lapsed; I gave the vote away." */
  Revoked = 'C_REVOKED',
}

export type ConsensusMessage =
  | {readonly type: ConsensusMsgType.Request; readonly lock: LockId; readonly req: RequestId}
  | {readonly type: ConsensusMsgType.Grant; readonly lock: LockId; readonly req: RequestId; readonly fence: Fence}
  | {readonly type: ConsensusMsgType.Inquire; readonly lock: LockId; readonly req: RequestId}
  | {readonly type: ConsensusMsgType.Yield; readonly lock: LockId; readonly req: RequestId}
  | {readonly type: ConsensusMsgType.Confirm; readonly lock: LockId; readonly req: RequestId; readonly fence: Fence}
  | {readonly type: ConsensusMsgType.Release; readonly lock: LockId; readonly req: RequestId; readonly fence: Fence}
  | {readonly type: ConsensusMsgType.Renew; readonly lock: LockId; readonly req: RequestId}
  | {readonly type: ConsensusMsgType.Revoked; readonly lock: LockId; readonly req: RequestId};

/** An outgoing message addressed to a node. The transport decides delivery. */
export interface Outgoing {
  readonly to: NodeId;
  readonly msg: ConsensusMessage;
}

/** A lock newly entered, with the fence token to present to the resource. */
export interface Acquired {
  readonly lock: LockId;
  readonly fence: Fence;
}

function isRecord(x: unknown): x is {[k: string]: unknown} {
  return typeof x === 'object' && x !== null;
}

function isWholeNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && Number.isInteger(x) && x >= 0;
}

function isRequestId(x: unknown): x is RequestId {
  return isRecord(x) && isWholeNumber(x.ts) && isWholeNumber(x.node);
}

function hasBaseShape(x: unknown): x is {type: ConsensusMsgType; lock: LockId; req: RequestId; fence?: Fence} {
  return isRecord(x) && typeof x.type === 'string' && typeof x.lock === 'string' && isRequestId(x.req);
}

/** Runtime guard for untrusted transport payloads. */
export function isConsensusMessage(x: unknown): x is ConsensusMessage {
  if (!hasBaseShape(x)) {
    return false;
  }
  switch (x.type) {
    case ConsensusMsgType.Request:
    case ConsensusMsgType.Inquire:
    case ConsensusMsgType.Yield:
    case ConsensusMsgType.Renew:
    case ConsensusMsgType.Revoked:
      return x.fence === undefined;
    case ConsensusMsgType.Grant:
    case ConsensusMsgType.Confirm:
    case ConsensusMsgType.Release:
      return isWholeNumber(x.fence);
    default:
      return false;
  }
}
