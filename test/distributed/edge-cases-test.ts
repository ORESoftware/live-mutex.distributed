'use strict';

import * as assert from 'assert';
import {LEASE} from '../../src/distributed/messages';
import {LMXConsensusNode} from '../../src/distributed/node';
import {RequestId} from '../../src/distributed/request-id';
import {ConsensusMsgType} from '../../src/distributed/messages';

function membershipIsValidated(): void {
  assert.throws(() => new LMXConsensusNode(0, []), /members must not be empty/);
  assert.throws(() => new LMXConsensusNode(0, [1, 2, 3]), /members must include the local node id/);
  assert.throws(() => new LMXConsensusNode(0, [0, 1, 1]), /members must be unique/);
  assert.throws(() => new LMXConsensusNode(0.5, [0, 1, 2]), /node id must be a non-negative integer/);
  assert.throws(() => new LMXConsensusNode(0, [0, -1, 2]), /members must be non-negative integers/);
}

function duplicateAcquireIsIdempotent(): void {
  const n = new LMXConsensusNode(0, [0, 1, 2]);
  n.request(0, 'A');
  assert.strictEqual(n.drainOutbox().length, 3);

  n.request(1, 'A');
  assert.deepStrictEqual(n.drainOutbox(), []);
}

function invalidSenderIsIgnored(): void {
  const n = new LMXConsensusNode(0, [0, 1, 2]);
  const req: RequestId = {ts: 1, node: 1};

  n.handle(0, 2, {type: ConsensusMsgType.Request, lock: 'A', req});
  assert.deepStrictEqual(n.drainOutbox(), []);

  n.handle(0, 99, {type: ConsensusMsgType.Request, lock: 'A', req: {ts: 1, node: 99}});
  assert.deepStrictEqual(n.drainOutbox(), []);
}

function malformedMessagesAreIgnored(): void {
  const n = new LMXConsensusNode(0, [0, 1, 2]);
  const bad: unknown[] = [
    null,
    {},
    {type: ConsensusMsgType.Request, lock: 'A'},
    {type: ConsensusMsgType.Request, lock: 1, req: {ts: 1, node: 1}},
    {type: ConsensusMsgType.Request, lock: 'A', req: {ts: 1.5, node: 1}},
    {type: ConsensusMsgType.Grant, lock: 'A', req: {ts: 1, node: 0}},
    {type: ConsensusMsgType.Renew, lock: 'A', req: {ts: 1, node: 1}, fence: 1},
    {type: 'C_NOPE', lock: 'A', req: {ts: 1, node: 1}},
  ];
  for (const msg of bad) {
    assert.doesNotThrow(() => n.handle(0, 1, msg as any));
  }
  assert.deepStrictEqual(n.drainOutbox(), []);
}

function leaseExpiryRevokesOldVoteeAndGrantsNext(): void {
  const arbiter = new LMXConsensusNode(0, [0, 1, 2]);
  const first: RequestId = {ts: 1, node: 1};
  const next: RequestId = {ts: 2, node: 2};

  arbiter.handle(0, 1, {type: ConsensusMsgType.Request, lock: 'A', req: first});
  assert.deepStrictEqual(arbiter.drainOutbox().map((o) => o.msg.type), [ConsensusMsgType.Grant]);

  arbiter.handle(1, 2, {type: ConsensusMsgType.Request, lock: 'A', req: next});
  assert.deepStrictEqual(arbiter.drainOutbox(), []);

  arbiter.tick(LEASE + 1);
  const out = arbiter.drainOutbox();
  assert.ok(out.some((o) => o.to === 1 && o.msg.type === ConsensusMsgType.Revoked));
  assert.ok(out.some((o) => o.to === 2 && o.msg.type === ConsensusMsgType.Grant));
}

function lostQuorumReportsLostAndReleasesRemainingVotes(): void {
  const n = new LMXConsensusNode(0, [0, 1, 2]);
  n.request(0, 'A');
  const request = n.drainOutbox()[0].msg;
  assert.strictEqual(request.type, ConsensusMsgType.Request);
  const req = request.req;

  n.handle(0, 0, {type: ConsensusMsgType.Grant, lock: 'A', req, fence: 0});
  n.handle(0, 1, {type: ConsensusMsgType.Grant, lock: 'A', req, fence: 0});
  assert.deepStrictEqual(n.takeAcquired(), [{lock: 'A', fence: 1}]);
  n.drainOutbox(); // Confirm messages.

  n.handle(0, 1, {type: ConsensusMsgType.Revoked, lock: 'A', req});
  assert.deepStrictEqual(n.takeLost(), ['A']);
  const releases = n.drainOutbox().filter((o) => o.msg.type === ConsensusMsgType.Release);
  assert.strictEqual(releases.length, 3);

  n.request(1, 'A');
  assert.strictEqual(n.drainOutbox().filter((o) => o.msg.type === ConsensusMsgType.Request).length, 3);
}

membershipIsValidated();
console.log('  ok  membership_is_validated');
duplicateAcquireIsIdempotent();
console.log('  ok  duplicate_acquire_is_idempotent');
invalidSenderIsIgnored();
console.log('  ok  invalid_sender_is_ignored');
malformedMessagesAreIgnored();
console.log('  ok  malformed_messages_are_ignored');
leaseExpiryRevokesOldVoteeAndGrantsNext();
console.log('  ok  lease_expiry_revokes_old_votee_and_grants_next');
lostQuorumReportsLostAndReleasesRemainingVotes();
console.log('  ok  lost_quorum_reports_lost_and_releases_remaining_votes');
console.log('edge-cases: ALL PASS');
