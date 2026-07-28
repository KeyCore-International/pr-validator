// AI gateway client.
//
// One concern: turn a (system, prompt) pair into a validated JSON object, or
// fail loudly. Models are asked for JSON in the prompt rather than through a
// structured-output API so that any gateway model works, including the cheap
// ones that lack native JSON mode.
//
// Retries cover BOTH transient transport errors and unusable output: cheap
// models occasionally emit a verdict cut mid-string, which is indistinguishable
// from a network failure as far as the caller is concerned.

/** Raised when the gateway could not produce a usable verdict. Maps to exit code 2. */
export class GatewayError extends Error {
  constructor(message, { attempts, lastError, rawText } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawText = rawText;
  }
}

/**
 * Pull a JSON object out of model output.
 *
 * Tolerant on purpose: models wrap JSON in fences, prepend "Here is the
 * verdict:", or append a closing remark. Returns null when nothing parses —
 * never throws, so the caller can treat it as a retryable attempt.
 */
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end < start) return null;

  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call the gateway until it yields a verdict `accept` is happy with.
 *
 * @param {object}   opts
 * @param {string}   opts.model     Gateway model id.
 * @param {string}   opts.system    System prompt.
 * @param {string}   opts.prompt    User prompt (includes the JSON shape request).
 * @param {number}   [opts.attempts=3]
 * @param {(parsed: object) => boolean} [opts.accept]
 *        Shape guard. Returning false consumes an attempt, exactly like a
 *        network failure — a verdict with the wrong shape is not a verdict.
 * @param {(info: {attempt: number, attempts: number, reason: string}) => void} [opts.onRetry]
 * @param {(args: object) => Promise<{text: string, usage?: object}>} [opts.generate]
 *        Injection seam for tests. Defaults to the `ai` package.
 * @param {number} [opts.backoffMs=1500] Base backoff. Tests pass 0.
 * @returns {Promise<{parsed: object, usage: object|undefined, text: string, attempt: number}>}
 * @throws {GatewayError}
 */
export async function callGateway({
  model,
  system,
  prompt,
  attempts = 3,
  accept = () => true,
  onRetry,
  generate,
  backoffMs = 1500,
}) {
  const call = generate ?? (await defaultGenerate());

  let lastError = '';
  let lastText;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let reason;

    try {
      const res = await call({ model, system, prompt });
      lastText = res.text;

      const parsed = extractJson(res.text);
      if (parsed && accept(parsed)) {
        return { parsed, usage: res.usage, text: res.text, attempt };
      }
      reason = parsed
        ? 'verdict JSON does not match the expected shape'
        : 'unparseable JSON verdict (possibly truncated output)';
    } catch (err) {
      reason = err?.message ?? String(err);
    }

    lastError = reason;
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, reason });
      // Linear backoff: gateway hiccups are short, and a check has a job-level
      // timeout to respect. Exponential would blow past it for no extra benefit.
      if (backoffMs > 0) await sleep(backoffMs * attempt);
    }
  }

  throw new GatewayError(
    `Gateway did not return a usable verdict after ${attempts} attempts (${model}): ${lastError}`,
    { attempts, lastError, rawText: lastText },
  );
}

// Imported lazily so tests can exercise the retry logic without pulling in the
// SDK, and so a missing dependency surfaces at call time rather than at import
// time of every module that transitively touches this one.
async function defaultGenerate() {
  const { generateText } = await import('ai');
  return async ({ model, system, prompt }) => {
    const res = await generateText({ model, system, prompt });
    return { text: res.text, usage: res.usage };
  };
}
