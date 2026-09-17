// Bridge protocol v1 corpus (desktop/protocol/bridge-v1.json) shape checks — integrator S0.
// Plain node:test + node:assert, no dependencies. The pydantic side (tests/bridge) proves every
// example parses and every invalid entry is rejected; this file keeps the corpus itself honest
// for the hand-written JS validator (desktop/main/protocol.js, Stage 2) that is held to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'protocol', 'bridge-v1.json');

// docs/desktop-contract.md §1 — hard-coded on purpose so the corpus cannot drift silently.
const CLIENT_TYPES = ['hello', 'capture', 'analyst', 'health', 'accepted', 'rejected', 'result', 'pong'];
const SERVER_TYPES = ['hello_ack', 'request', 'cancel', 'ping'];
const ALL_TYPES = [...CLIENT_TYPES, ...SERVER_TYPES];
const REJECT_CODES = ['view_busy', 'logged_out', 'challenge', 'blocked', 'analyst_not_chosen', 'unknown_site', 'view_crashed'];
const RESULT_CODES = ['composer_not_found', 'send_not_found', 'not_submitted', 'reply_not_found', 'timeout', 'cancelled', 'adapter_gone', 'site_error', 'navigation', 'view_crashed'];

const sorted = (xs) => [...xs].sort();
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function load() {
  return JSON.parse(readFileSync(FILE, 'utf8'));
}

test('bridge-v1.json parses and declares protocol 1', () => {
  const doc = load();
  assert.equal(doc.protocol, 1);
  assert.ok(isPlainObject(doc.frames));
  assert.deepEqual(Object.keys(doc), ['protocol', 'frames']);
});

test('every frame type has a client or server direction', () => {
  const { frames } = load();
  for (const [type, spec] of Object.entries(frames)) {
    assert.ok(spec.direction === 'client' || spec.direction === 'server', `${type}: direction=${spec.direction}`);
    assert.deepEqual(sorted(Object.keys(spec)), ['direction', 'examples', 'invalid'], type);
  }
});

test('the set of frame types equals the documented set, split by direction', () => {
  const { frames } = load();
  assert.deepEqual(sorted(Object.keys(frames)), sorted(ALL_TYPES));
  const byDirection = (d) => Object.entries(frames).filter(([, s]) => s.direction === d).map(([t]) => t);
  assert.deepEqual(sorted(byDirection('client')), sorted(CLIENT_TYPES));
  assert.deepEqual(sorted(byDirection('server')), sorted(SERVER_TYPES));
});

test('every example is an object whose "type" equals its key', () => {
  const { frames } = load();
  for (const [type, spec] of Object.entries(frames)) {
    assert.ok(Array.isArray(spec.examples), type);
    for (const example of spec.examples) {
      assert.ok(isPlainObject(example), `${type}: example is not an object`);
      assert.equal(example.type, type);
    }
    assert.ok(Array.isArray(spec.invalid), type);
    for (const bad of spec.invalid) assert.ok(isPlainObject(bad), `${type}: invalid entry is not an object`);
  }
});

test('each type has at least two examples and at least one invalid entry', () => {
  const { frames } = load();
  for (const [type, spec] of Object.entries(frames)) {
    assert.ok(spec.examples.length >= 2, `${type}: ${spec.examples.length} examples`);
    assert.ok(spec.invalid.length >= 1, `${type}: ${spec.invalid.length} invalid`);
  }
});

test('the corpus spells out every rejected code, every result code and all three result shapes', () => {
  const { frames } = load();
  assert.deepEqual(sorted(new Set(frames.rejected.examples.map((e) => e.code))), sorted(REJECT_CODES));
  const results = frames.result.examples;
  assert.deepEqual(sorted(new Set(results.filter((e) => e.ok === false).map((e) => e.code))), sorted(RESULT_CODES));
  assert.ok(results.some((e) => e.ok === true && e.captured === true && typeof e.text === 'string'));
  assert.ok(results.some((e) => e.ok === true && e.captured === false && !('text' in e)));
  assert.ok(results.some((e) => e.ok === false && typeof e.message === 'string'));
});

test('hello examples cover analyst null and analyst {slot}; request examples cover both views and fresh true/false', () => {
  const { frames } = load();
  assert.ok(frames.hello.examples.some((e) => e.analyst === null));
  assert.ok(frames.hello.examples.some((e) => isPlainObject(e.analyst) && typeof e.analyst.slot === 'string'));
  const reqs = frames.request.examples;
  assert.ok(reqs.some((r) => r.view === 'pane' && r.fresh === false));
  assert.ok(reqs.some((r) => r.view === 'analyst' && r.fresh === true));
  assert.ok(reqs.some((r) => r.view === 'analyst' && r.fresh === false));
});
