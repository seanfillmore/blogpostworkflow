// lib/anthropic.js
//
// Drop-in replacement for `@anthropic-ai/sdk`'s default export: a subclass whose
// messages.create() logs token usage + estimated cost (see lib/llm-usage.js).
// Agents only change their IMPORT path — every `new Anthropic(...)` and
// `client.messages.create(...)` call site works unchanged.
//
// Streaming (messages.stream) is not metered yet; the fleet uses create().

import RealAnthropic from '@anthropic-ai/sdk';
import { logUsage } from './llm-usage.js';

export default class Anthropic extends RealAnthropic {
  constructor(opts) {
    super(opts);
    const messages = this.messages;
    if (messages && typeof messages.create === 'function') {
      const orig = messages.create.bind(messages);
      messages.create = async (params, options) => {
        const res = await orig(params, options);
        try { logUsage({ model: params?.model, usage: res?.usage }); } catch { /* never break the call */ }
        return res;
      };
    }
  }
}

export { Anthropic };
