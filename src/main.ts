'use strict';

import * as lmUtils from './utils';
import {routineEnter} from './routine';

export {lmUtils};
export {RWLockClient, RWLockReadPrefClient} from './rw-client';
export {RWLockWritePrefClient} from './rw-write-preferred-client';
export {Client, LMXClient, LvMtxClient} from './client';
// The legacy single-broker (`broker.ts`) was removed in live-mutex.distributed;
// the `Broker` public name is now an alias for the newer, fencing-aware
// `Broker1`, so existing imports keep working against the better implementation.
export {
    Broker1,
    Broker1 as Broker,
    LMXBroker, LvMtxBroker,
    LMXBroker as LMXBroker1,
    LvMtxBroker as LvMtxBroker1,
} from './broker-1';
export {LMXHttpServer} from './http-server';
export {InProcessBridge, VirtualSocket} from './in-process-bridge';
export {routineEnter, initOtel, shutdownOtel, setOtelEnabled, isOtelEnabled} from './routine';
export {getLogLevel, setLogLevel, isLogLevelEnabled, LMX_LOG_LEVELS} from './log-level';
export type {LMXLogLevel} from './log-level';

export {LMXLockRequestError, LMXUnlockRequestError} from "./shared-internal";
export {LMXClientException, LMXClientLockException, LMXClientUnlockException} from "./exceptions";

// LMX wire-protocol enum + discriminated union. Cross-runtime ports
// of this protocol (Rust, Go, Dart, Gleam) all expose a request enum
// as their public type contract; this is the Node analogue. The
// string values match the legacy wire format byte-for-byte, so older
// brokers/clients keep interoperating.
export {
    LMXRequestType,
    LMXResponseType,
    LMXKnownRequestTypes,
    isLMXRequestType,
    assertExhaustive,
} from './protocol';
export type {
    LMXRequest,
    LockReq, UnlockReq, AcquireManyReq, ReleaseManyReq,
    LsReq, VersionReq, VersionMismatchConfirmedReq,
    SimulateVersionMismatchReq,
    EndConnectionFromBrokerForTestingReq,
    DestroyConnectionFromBrokerForTestingReq,
    IncrementReadersReq, DecrementReadersReq,
    RegisterWriteFlagCheckReq, RegisterWriteFlagCheckQueuedReq,
    RegisterWriteFlagAndReadersCheckReq,
    SetWriteFlagFalseAndBroadcastReq,
    LockReceivedReq, LockClientTimeoutReq, LockClientErrorReq,
    LockReceivedRejectedReq,
    LockInfoRequestReq, PingReq, SystemStatsRequestReq,
} from './protocol';

// Distributed (quorum/vote) consensus engine — the leaderless, fault-tolerant
// locking core (a TypeScript backport of the Rust `live-mutex-mills` crate).
// This is the new "live-mutex.distributed" capability; the single-broker
// exports above are unchanged.
export {LMXConsensusNode, ConsensusMsgType} from './distributed';
export {Sim as LMXConsensusSim} from './distributed';
export {
    LEASE as LMX_CONSENSUS_LEASE,
    RENEW_INTERVAL as LMX_CONSENSUS_RENEW_INTERVAL,
} from './distributed';
export type {
    ConsensusMessage,
    Outgoing as ConsensusOutgoing,
    Acquired as ConsensusAcquired,
    NodeId as ConsensusNodeId,
    LockId as ConsensusLockId,
    Fence,
    Instant,
    RequestId as ConsensusRequestId,
} from './distributed';

export const r2gSmokeTest = function () {
  const routineId = 'ddl-routine-r2gSmokeTest-Wj6';
  routineEnter(routineId, 'r2gSmokeTest');
  return true;
};
