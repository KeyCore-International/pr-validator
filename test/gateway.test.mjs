import { describe, expect, it } from 'vitest';
import { callGateway, extractJson, GatewayError, tokenUsage } from '../src/gateway.mjs';
import {
  RAW_FENCED,
  RAW_NO_JSON,
  RAW_PLAIN_JSON,
  RAW_TRUNCATED,
  RAW_WITH_PROSE,
  RAW_WRONG_SHAPE,
  scriptedGenerate,
} from './fixtures/gateway.mjs';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson(RAW_PLAIN_JSON).overall).toBe('PASS');
  });

  it('parses JSON wrapped in a code fence', () => {
    expect(extractJson(RAW_FENCED).overall).toBe('PASS');
  });

  it('parses JSON surrounded by prose', () => {
    expect(extractJson(RAW_WITH_PROSE).criteria).toHaveLength(1);
  });

  it('returns null for truncated JSON instead of throwing', () => {
    expect(extractJson(RAW_TRUNCATED)).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJson(RAW_NO_JSON)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson(undefined)).toBeNull();
  });
});

describe('callGateway', () => {
  // backoffMs: 0 — the retry policy is what's under test, not the wall clock.
  const base = { model: 'test/model', system: 's', prompt: 'p', attempts: 3, backoffMs: 0 };

  it('returns the parsed verdict on the first try', async () => {
    const generate = scriptedGenerate([RAW_PLAIN_JSON]);
    const result = await callGateway({ ...base, generate });

    expect(result.parsed.overall).toBe('PASS');
    expect(result.attempt).toBe(1);
    expect(generate.calls()).toBe(1);
  });

  it('retries truncated output and succeeds on a later attempt', async () => {
    const generate = scriptedGenerate([RAW_TRUNCATED, RAW_PLAIN_JSON]);
    const result = await callGateway({ ...base, generate });

    expect(result.attempt).toBe(2);
    expect(generate.calls()).toBe(2);
  });

  it('retries transport errors', async () => {
    const generate = scriptedGenerate([new Error('Gateway request failed'), RAW_PLAIN_JSON]);
    const result = await callGateway({ ...base, generate });

    expect(result.attempt).toBe(2);
  });

  it('treats a wrong-shaped verdict as a failed attempt', async () => {
    const generate = scriptedGenerate([RAW_WRONG_SHAPE, RAW_PLAIN_JSON]);
    const accept = (parsed) => Array.isArray(parsed?.criteria);

    const result = await callGateway({ ...base, generate, accept });

    expect(result.attempt).toBe(2);
  });

  it('throws GatewayError after exhausting every attempt', async () => {
    const generate = scriptedGenerate([RAW_NO_JSON]);

    await expect(callGateway({ ...base, generate })).rejects.toBeInstanceOf(GatewayError);
    expect(generate.calls()).toBe(3);
  });

  it('reports every retry through onRetry', async () => {
    const seen = [];
    const generate = scriptedGenerate([RAW_TRUNCATED, RAW_TRUNCATED, RAW_PLAIN_JSON]);

    await callGateway({ ...base, generate, onRetry: (info) => seen.push(info.attempt) });

    expect(seen).toEqual([1, 2]);
  });
});

// Cache and reasoning tokens were being discarded: the verdict kept only the
// total. That left two questions unanswerable from our own artifacts — whether
// prompt caching ever hits, and how much of the bill is reasoning — and both are
// what decide the next move on cost.
describe('tokenUsage', () => {
  it('keeps the cache and reasoning breakdown when the provider reports it', () => {
    const out = tokenUsage({
      totalTokens: 13000,
      inputTokens: 11500,
      outputTokens: 1500,
      inputTokenDetails: { cachedTokens: 9000, cacheWriteTokens: 2000 },
      outputTokenDetails: { reasoningTokens: 900 },
    });

    expect(out).toEqual({
      total: 13000,
      input: 11500,
      output: 1500,
      cacheRead: 9000,
      cacheWrite: 2000,
      reasoning: 900,
    });
  });

  // Providers name these differently and the gateway passes through whichever
  // the underlying one used.
  it('accepts the alternative field names', () => {
    const out = tokenUsage({
      inputTokenDetails: { cacheReadTokens: 10, cacheCreationTokens: 20 },
    });

    expect(out.cacheRead).toBe(10);
    expect(out.cacheWrite).toBe(20);
  });

  // A number nobody reported must not read as zero: "no cache hits" and "this
  // provider does not tell us" are different answers, and only one of them is
  // evidence that the reordering worked.
  it('omits what was not reported rather than defaulting it to zero', () => {
    const out = tokenUsage({ totalTokens: 100 });

    expect(out).toEqual({ total: 100 });
    expect('cacheRead' in out).toBe(false);
  });

  it.each([undefined, null, 'nope'])('survives a usage of %s', (usage) => {
    expect(tokenUsage(usage)).toEqual({});
  });
});

describe('callGateway provider options', () => {
  it('forwards them to the model call', async () => {
    const seen = [];
    const generate = async (args) => {
      seen.push(args.providerOptions);
      return { text: '{"ok":true}' };
    };

    await callGateway({
      model: 'openai/x',
      system: 's',
      prompt: 'p',
      generate,
      providerOptions: { openai: { promptCacheKey: 'k' } },
    });

    expect(seen[0]).toEqual({ openai: { promptCacheKey: 'k' } });
  });
});
