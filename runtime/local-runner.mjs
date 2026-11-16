import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { profileChecksum } from "../../Relay/cloudflare/relay-inference/contract.mjs";

export function assertLoopback(base) {
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Inference URL must be HTTP or HTTPS.");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("Inference is only allowed on loopback.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Inference URL cannot carry credentials or a query.");
  return url;
}

export function buildCompletionBody(release, text) {
  const generation = release.generation;
  return {
    model: `${release.id}:${release.version}`,
    messages: [
      { role: "system", content: release.system },
      { role: "user", content: text },
    ],
    temperature: generation.temperature,
    top_p: generation.top_p,
    top_k: generation.top_k,
    max_tokens: generation.max_tokens,
    chat_template_kwargs: { enable_thinking: generation.enable_thinking === true },
    stream: false,
  };
}

export function withinBudget(release, text) {
  const used = buildCompletionBody(release, text).messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).length, 0);
  return used <= release.runtime.context_character_budget;
}

export async function answerQuestion(release, llamaBase, text, timeoutMs, fetchImpl = globalThis.fetch) {
  assertLoopback(llamaBase);
  if (!withinBudget(release, text)) return { ok: false, error: { code: "input_budget", message: "The question exceeds this release's input budget." } };
  const endpoint = new URL("chat/completions", llamaBase.endsWith("/") ? llamaBase : `${llamaBase}/`);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildCompletionBody(release, text)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return { ok: false, error: { code: "runtime_error", message: `The local runtime returned HTTP ${response.status}.` } };
  const result = await response.json();
  const message = result?.choices?.[0]?.message;
  if (message?.tool_calls) return { ok: false, error: { code: "tools_disabled", message: "Tool execution is not enabled." } };
  if (typeof message?.content !== "string" || !message.content.trim()) return { ok: false, error: { code: "empty_completion", message: "The model returned no text." } };
  return { ok: true, text: message.content.trim() };
}

export async function handleJob(job, release, options) {
  const checksum = await profileChecksum(release);
  const now = options.now();
  if (job.profileChecksum !== checksum) {
    return { schemaVersion: 1, status: "failed", profileChecksum: checksum, error: { code: "profile_mismatch", message: "The enrolled profile does not match the local release." } };
  }
  const deadline = Date.parse(job.deadline);
  if (!Number.isFinite(deadline) || deadline - now < 1000) {
    return { schemaVersion: 1, status: "expired", profileChecksum: checksum, error: { code: "expired", message: "The request expired before the model ran." } };
  }
  try {
    const answer = await answerQuestion(release, options.llamaBase, job.input.text, deadline - now - 250, options.fetchImpl);
    if (!answer.ok) return { schemaVersion: 1, status: "failed", profileChecksum: checksum, error: answer.error };
    return { schemaVersion: 1, status: "completed", profileChecksum: checksum, output: { type: "text", text: answer.text } };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { schemaVersion: 1, status: "failed", profileChecksum: checksum, error: { code: timedOut ? "timeout" : "runtime_error", message: timedOut ? "The model did not answer before the deadline." : "The local runtime could not be reached." } };
  }
}

async function pollForever() {
  const release = JSON.parse(await readFile(process.env.RELEASE_FILE || "", "utf8"));
  const relay = process.env.RELAY_INFERENCE_URL || "";
  const token = process.env.RUNNER_TOKEN || "";
  const llamaBase = process.env.LLAMA_BASE_URL || "";
  assertLoopback(llamaBase);
  const relayUrl = new URL(relay);
  if (relayUrl.username || relayUrl.password) throw new Error("Relay URL cannot contain credentials.");
  for (;;) {
    try {
      const polled = await fetch(new URL("/v1/inference/poll", relayUrl), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (polled.status === 401) {
        console.error(JSON.stringify({ message: "runner_unauthorized" }));
        process.exit(1);
      }
      const body = await polled.json();
      if (body.request) {
        const result = await handleJob(body.request, release, { llamaBase, now: () => Date.now(), fetchImpl: fetch });
        const posted = await fetch(new URL(`/v1/inference/requests/${body.request.requestId}/result`, relayUrl), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(result),
          signal: AbortSignal.timeout(10000),
        });
        console.log(JSON.stringify({ message: "runner_result", requestId: body.request.requestId, traceId: body.request.traceId, status: result.status, http: posted.status, code: result.error?.code || "" }));
      }
    } catch {
      console.error(JSON.stringify({ message: "runner_poll_failed" }));
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) pollForever().catch((error) => {
  console.error(JSON.stringify({ message: "runner_failed", detail: error instanceof Error ? error.name : "error" }));
  process.exit(1);
});
