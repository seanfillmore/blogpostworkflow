// lib/anthropic.js
//
// Drop-in replacement for `@anthropic-ai/sdk`'s default export: a subclass whose
// messages.create() logs token usage + estimated cost (see lib/llm-usage.js).
// Agents only change their IMPORT path — every `new Anthropic(...)` and
// `client.messages.create(...)` call site works unchanged.
//
// messages.stream() is metered too. It has to be: the SDK REFUSES a non-streaming
// call whose max_tokens implies a >10-minute operation, so any request that needs a
// large budget is forced onto stream() — and if only create() were wrapped, exactly
// the most expensive calls in the fleet would be the ones missing from the cost report.

//
// TRANSPORT. When lib/claude-subscription.js resolves 'subscription' (a
// CLAUDE_CODE_OAUTH_TOKEN in .env, or LLM_TRANSPORT=subscription), create() and stream()
// run through the Claude Code CLI and bill the Claude subscription instead of the
// per-token API key. The decision is made per call, so an agent needs no restart and no
// change. A request shape the CLI cannot carry (tool use, a prefilled assistant turn)
// takes the API and says so on stderr; nothing today sends one. A subscription failure is
// NOT retried on the API unless LLM_API_FALLBACK=1 — a silent fallback would quietly
// restore the spend this exists to remove.

import RealAnthropic from '@anthropic-ai/sdk';
import { logUsage } from './llm-usage.js';
import {
  currentTransport,
  createViaSubscription,
  subscriptionStream,
  SubscriptionUnsupportedError,
  buildCliRequest,
  setting,
} from './claude-subscription.js';

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** Returns true when this request should take the subscription transport. */
function useSubscription(params) {
  if (currentTransport() !== 'subscription') return false;
  try {
    buildCliRequest(params);
    return true;
  } catch (err) {
    if (!(err instanceof SubscriptionUnsupportedError)) throw err;
    warnOnce(`unsupported:${err.message}`, `[llm] ${err.message} — this request takes the per-token API`);
    return false;
  }
}

const apiFallback = () => setting('LLM_API_FALLBACK') === '1';

export default class Anthropic extends RealAnthropic {
  constructor(opts) {
    super(opts);
    const messages = this.messages;
    if (messages && typeof messages.create === 'function') {
      const orig = messages.create.bind(messages);
      messages.create = (params, options) => {
        if (useSubscription(params)) {
          const run = createViaSubscription(params, options)
            .catch((err) => {
              if (!apiFallback() || !err.status || err.status === 408) throw err;
              warnOnce('fallback', `[llm] subscription call failed (${err.message}) — LLM_API_FALLBACK=1, retrying on the API`);
              return orig(params, options).then((res) => {
                logUsage({ model: params?.model, usage: res?.usage, transport: 'api' });
                return res;
              });
            });
          run
            .then((res) => { if (res?.id?.startsWith('msg_subscription_')) logUsage({ model: params?.model, usage: res?.usage, transport: 'subscription' }); })
            .catch(() => { /* metering must never break an agent */ });
          return run;
        }
        // Return the SDK's APIPromise itself — do NOT wrap this in an async function.
        // An async wrapper resolves it into a plain Promise and drops APIPromise's own
        // methods, and messages.stream() calls create(...).withResponse() internally,
        // so wrapping breaks all streaming with "withResponse is not a function".
        // Metering therefore rides a detached subscriber instead of the return value.
        const promise = orig(params, options);
        promise
          .then((res) => logUsage({ model: params?.model, usage: res?.usage, transport: 'api' }))
          .catch(() => { /* metering must never break an agent */ });
        return promise;
      };
    }
    if (messages && typeof messages.stream === 'function') {
      const origStream = messages.stream.bind(messages);
      messages.stream = (params, options) => {
        if (useSubscription(params)) {
          const sub = subscriptionStream(params, options);
          sub.finalMessage()
            .then((msg) => logUsage({ model: params?.model, usage: msg?.usage, transport: 'subscription' }))
            .catch(() => { /* metering must never break an agent */ });
          return sub;
        }
        const stream = origStream(params, options);
        // Meter off finalMessage() rather than the returned object: usage totals are
        // only complete once the stream ends. Swallow the rejection here — the caller
        // still awaits the same promise and sees the real error.
        Promise.resolve()
          .then(() => stream.finalMessage())
          .then((msg) => logUsage({ model: params?.model, usage: msg?.usage, transport: 'api' }))
          .catch(() => { /* metering must never break an agent */ });
        return stream;
      };
    }
  }
}

export { Anthropic };
