import { strict as assert } from 'node:assert';
import { summarizeIngestStatus, isTerminalStatus } from '../../lib/ads-conversions.js';

// The Data Manager ingest endpoint is ASYNCHRONOUS. Its response body is only
// { requestId, fieldWarnings? } — it carries no per-event acceptance at all. The first
// version of this agent computed `accepted = events.length - errors.length`, which meant
// an empty response was reported to Sean as "2/2 accepted" while Google had in fact
// recorded nothing. Real status comes from requestStatus:retrieve, later.

{
  assert.equal(isTerminalStatus('PROCESSING'), false);
  assert.equal(isTerminalStatus('SUCCESS'), true);
  assert.equal(isTerminalStatus('FAILED'), true);
  assert.equal(isTerminalStatus('PARTIAL_SUCCESS'), true);
  // An unknown future state must count as terminal, not spin forever.
  assert.equal(isTerminalStatus('SOMETHING_NEW'), true);
  assert.equal(isTerminalStatus(undefined), false);
}

// Still processing => not yet confirmed, and must never be reported as success.
{
  const s = summarizeIngestStatus({ requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] });
  assert.equal(s.terminal, false);
  assert.equal(s.confirmed, false);
  assert.equal(s.status, 'PROCESSING');
}

{
  const s = summarizeIngestStatus({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] });
  assert.equal(s.terminal, true);
  assert.equal(s.confirmed, true);
}

// Any non-success terminal state is a failure, however Google words it.
{
  const s = summarizeIngestStatus({ requestStatusPerDestination: [{ requestStatus: 'FAILED' }] });
  assert.equal(s.terminal, true);
  assert.equal(s.confirmed, false);
}

// Multiple destinations: confirmed only if every one succeeded.
{
  const s = summarizeIngestStatus({ requestStatusPerDestination: [
    { requestStatus: 'SUCCESS' }, { requestStatus: 'FAILED' }] });
  assert.equal(s.confirmed, false);
}

// An empty/absent body must NOT read as success — that is the original bug.
{
  const s = summarizeIngestStatus({});
  assert.equal(s.confirmed, false);
  assert.equal(s.terminal, false);
  assert.equal(s.status, 'UNKNOWN');
}

console.log('ads-ingest-status: all assertions passed');
