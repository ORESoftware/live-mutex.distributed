'use strict';

// Multi-key / composite locking: acquire up to MAX_COMPOSITE_KEYS keys as one
// all-or-nothing unit, built on the single-key consensus engine.
//
// - Conflict on overlap: a composite holds *every* component single-key lock,
//   so composites sharing any key are mutually exclusive.
// - Deadlock-free: components are acquired in canonical (sorted) order, so the
//   global waits-for relation only points from smaller keys to larger ones and
//   can never cycle.

import {Fence, LockId} from './request-id';

/** Maximum number of distinct keys in one composite lock. */
export const MAX_COMPOSITE_KEYS = 3;

export type CompositeError =
  | {readonly kind: 'empty'}
  | {readonly kind: 'too-many'; readonly count: number}
  | {readonly kind: 'empty-key'};

export type CanonicalResult =
  | {readonly ok: true; readonly keys: LockId[]}
  | {readonly ok: false; readonly error: CompositeError};

/** De-duplicate, sort, and enforce the 1..=MAX_COMPOSITE_KEYS bound. */
export function canonicalKeys(keys: LockId[]): CanonicalResult {
  if (keys.some((k) => k.length === 0)) {
    return {ok: false, error: {kind: 'empty-key'}};
  }
  const set = Array.from(new Set(keys)).sort();
  if (set.length === 0) {
    return {ok: false, error: {kind: 'empty'}};
  }
  if (set.length > MAX_COMPOSITE_KEYS) {
    return {ok: false, error: {kind: 'too-many', count: set.length}};
  }
  return {ok: true, keys: set};
}

export type Progress =
  | {readonly kind: 'ignored'}
  | {readonly kind: 'next'; readonly key: LockId}
  | {readonly kind: 'held'};

/** An ordered, all-or-nothing acquire of up to MAX_COMPOSITE_KEYS keys. */
export class Composite {
  private readonly _keys: LockId[];
  private next = 0;
  private readonly fences = new Map<LockId, Fence>();
  private _held = false;

  private constructor(keys: LockId[]) {
    this._keys = keys;
  }

  /** Build from an arbitrary key list (canonicalized); throws if invalid. */
  static create(keys: LockId[]): Composite {
    const r = canonicalKeys(keys);
    if (r.ok === false) {
      throw new Error(`invalid composite key set: ${JSON.stringify(r.error)}`);
    }
    return new Composite(r.keys);
  }

  /** The canonical (sorted, de-duped) component keys. */
  get keys(): ReadonlyArray<LockId> {
    return this._keys;
  }

  /** The key to request now — the next un-acquired component — or undefined. */
  pending(): LockId | undefined {
    return this._held ? undefined : this._keys[this.next];
  }

  isHeld(): boolean {
    return this._held;
  }

  fence(key: LockId): Fence | undefined {
    return this.fences.get(key);
  }

  /** Feed a single-key acquisition; advances only on the expected next key. */
  onAcquired(key: LockId, fence: Fence): Progress {
    if (this._held || this._keys[this.next] !== key) {
      return {kind: 'ignored'};
    }
    this.fences.set(key, fence);
    this.next += 1;
    if (this.next === this._keys.length) {
      this._held = true;
      return {kind: 'held'};
    }
    return {kind: 'next', key: this._keys[this.next]};
  }
}
