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

import RealAnthropic from '@anthropic-ai/sdk';
import { logUsage } from './llm-usage.js';

export default class Anthropic extends RealAnthropic {
  constructor(opts) {
    super(opts);
    const messages = this.messages;
    if (messages && typeof messages.create === 'function') {
      const orig = messages.create.bind(messages);
      messages.create = (params, options) => {
        // Return the SDK's APIPromise itself — do NOT wrap this in an async function.
        // An async wrapper resolves it into a plain Promise and drops APIPromise's own
        // methods, and messages.stream() calls create(...).withResponse() internally,
        // so wrapping breaks all streaming with "withResponse is not a function".
        // Metering therefore rides a detached subscriber instead of the return value.
        const promise = orig(params, options);
        promise
          .then((res) => logUsage({ model: params?.model, usage: res?.usage }))
          .catch(() => { /* metering must never break an agent */ });
        return promise;
      };
    }
    if (messages && typeof messages.stream === 'function') {
      const origStream = messages.stream.bind(messages);
      messages.stream = (params, options) => {
        const stream = origStream(params, options);
        // Meter off finalMessage() rather than the returned object: usage totals are
        // only complete once the stream ends. Swallow the rejection here — the caller
        // still awaits the same promise and sees the real error.
        Promise.resolve()
          .then(() => stream.finalMessage())
          .then((msg) => logUsage({ model: params?.model, usage: msg?.usage }))
          .catch(() => { /* metering must never break an agent */ });
        return stream;
      };
    }
  }
}

export { Anthropic };
