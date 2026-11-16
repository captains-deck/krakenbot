# Local model deployment

Kraken deploys a pinned model release onto an execution host. Relay carries the
question and the answer. The inference runtime serves the model. Captain’s Deck
is the signed-in page. This document is the V0 contract for that split.

The implemented path is **hybrid**: Captain’s Deck is the hosted portal, and
Sentient Potato runs on the Captain’s own computer. Fully self-hosted operation
of the same components is possible on loopback, but there is no packaged
self-host installer. Cloud hosting and managed provider models are specified
below and are not built.

## Boundaries

| System            | Owns                                                                                           | Does not do                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| model-manifest    | Immutable release: id, version, artifact checksum, licence, system prompt, generation settings | Start a process or store a Captain’s deployment                                             |
| Kraken            | Desired spec, resolved record, process lifecycle, runner enrollment                            | Accept chat traffic or give the model a shell                                               |
| Relay             | Versioned request and response envelopes, runner credentials, deadlines                        | Run the model                                                                               |
| llama.cpp         | Loopback token generation                                                                      | Apply the AI Captain system prompt by itself                                                |
| Local runner      | Poll Relay, apply the release profile, call loopback `/v1/chat/completions`                    | Spawn processes or call a development agent                                                 |
| Captain’s Deck    | Authenticated page and server-side account/environment resolution                              | Choose a deployment id from the browser                                                     |
| Development agent | Future scoped build job                                                                        | Not used by chat. The remote adapter validates a job and returns `REMOTE_AGENT_UNAVAILABLE` |

The chat runner has no `child_process` import. A question cannot become a shell
command.

## Request path

```text
Signed-in Deck page /model-poc
  → Deck worker, session cookie, account service /api/environments
  → Relay POST /v1/inference/requests
  → enrolled runner poll
  → llama-server on 127.0.0.1
  → Relay result
  → Deck GET /api/model-poc/questions/:id
  → page text
```

Deck ignores any account, environment or deployment id in the question body. The
selected environment is the one the account service already stored for that
session.

## Volt records

`volt.json` stays a WormVolt schemaVersion 1 document. Deployment fields are not
added to it. Kraken may append an existing integration entry
`{ "id", "kind": "model-deployment", "status": "declared" }` to `kraken.json`
when that file already has schema 1 or 2 and an `integrations` array. That entry
declares the deployment. It does not copy the release.

| Record             | Path                                                | Owner          | Export                                                       |
| ------------------ | --------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| Desired deployment | `models/deployments/<id>.desired.json`              | Captain        | Yes                                                          |
| Resolved record    | `models/deployments/<id>.record.json`               | Kraken         | Yes                                                          |
| Machine binding    | `models/local/binding.json`                         | This computer  | No                                                           |
| Runtime state      | `models/local/state.json`                           | Kraken         | No                                                           |
| History            | `models/local/history.jsonl`                        | Kraken         | No                                                           |
| Logs               | `models/local/*.log`                                | Runtime        | No. They can contain prompts.                                |
| Runner token       | `~/.config/aicaptain/kraken-runners/<id>` mode 0600 | Kraken         | No. The volt stores `secret://aicaptain/kraken-runners/<id>` |
| Weights            | model-manifest `.cache/models/blobs/<sha256>.gguf`  | model-manifest | No                                                           |

The resolved record stores the release path, artifact checksum, profile
checksum, licence name, runtime requirements, ownership, hosting mode,
management responsibility, Relay contract, limits and secret references. It does
not store the system prompt. The prompt remains in
`releases/<model>/<version>/release.json`. The profile checksum is SHA-256 of
the canonical JSON `{ system, generation }` with generation keys `temperature`,
`top_p`, `top_k`, `max_tokens`, `enable_thinking`.

`models/local/` is git-ignored. `kraken model export` copies `volt.json`,
`kraken.json`, `models/README.md` and `models/deployments/*.json`. It refuses to
write the directory if those files contain the runner token, a bearer token, or
`RELAY_SERVICE_TOKEN=`.

WormVolt write permission is required to deploy. Share permission is required to
export. Group names inside `volt.json` do not authenticate the operator; the
host principal is `kraken-operator` in `owner`.

The working example is `examples/sentient-potato-volt`.

## Commands

From `KrakenBot`, with Node 24. Set the Relay values in the environment. Do not
pass the service token as a flag.

```sh
export RELAY_INFERENCE_URL=http://127.0.0.1:8788
export RELAY_SERVICE_TOKEN='the token from the Relay server environment'
pnpm exec kraken model validate examples/sentient-potato-volt
pnpm exec kraken model deploy examples/sentient-potato-volt --account <account-id> --environment <environment-id>
pnpm exec kraken model status examples/sentient-potato-volt
pnpm exec kraken model stop examples/sentient-potato-volt
pnpm exec kraken model restart examples/sentient-potato-volt
pnpm exec kraken model export examples/sentient-potato-volt --output ./exports/sentient-potato
```

Optional flags: `--spec`, `--release-root`, `--cache`, `--llama-server`,
`--deployment`.

Deploy validates the specification, checks RAM against the release suggestion,
resolves `sentient-potato:0.1.0-rc.1` through the model-manifest client,
verifies the GGUF checksum, starts `llama-server` on `127.0.0.1:18080`, waits
until it is ready, enrolls the runner, and only then marks the route serving. A
second deploy leaves a healthy process in place. Restart stops it first, so two
servers are not left bound. A failed start revokes a half-created enrollment and
records `failed` in `models/local/state.json`.

The account and environment must be the ones Captain’s Deck resolves for the
signed-in Captain. Login to Deck does not grant access to a deployment enrolled
for someone else. Restart without scope flags keeps the recorded scope. To change
scope, provide both `--account` and `--environment`; Kraken validates the Volt
write policy and any pinned desired ownership before stopping the runtime.

## Recovery

| State                                       | What to do                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed` after start                        | Read `models/local/state.json` `lastError` and `models/local/llama.log`. Fix the cause, then `deploy` again.                                         |
| Port already used by another program        | Stop that program or change `runtime.port` in the desired spec. Kraken does not signal a process it did not record.                                  |
| Recorded pid now belongs to another program | Stop refuses with `REFUSED_KILL`. Change the port or remove the stale `models/local/state.json` after you have confirmed the pid is not the runtime. |
| Lock left behind by a crash                 | Remove `models/local/lock` if no Kraken deploy is running, then retry.                                                                               |
| Runner credential lost                      | `restart` enrolls a new token and revokes the old one.                                                                                               |
| Relay was unreachable during stop           | Local processes are stopped. The next deploy enrolls again. Status says the route could not be updated.                                              |
| Question expires after the laptop sleeps    | Relay will not run it on reconnect. Ask again.                                                                                                       |

## Another model

1. Stage and verify the release in model-manifest. Keep its system prompt and
   generation settings in that release file.
2. Copy `models/deployments/sentient-potato.desired.json`.
3. Change `deploymentId`, `modelId`, `releaseVersion`, `artifactSha256`,
   `releaseRef.path`, `runtime.port` and the runner secret reference so the
   reference matches the new id.
4. Leave `hostingMode` as `local-execution`, `management` as `captain-managed`,
   and `relay.contract` as `relay-inference/1`.
5. Run `kraken model validate`.
6. Deploy with the same account and environment, or stop the current deployment
   first. One environment has one enrolled deployment in this version.

Do not copy the system prompt into the volt. The runner reads the release file
Kraken pinned and sends that checksum to Relay. A mismatch is rejected and the
model is not called.

## Another execution host

V0 runs on this Mac (`executionHost.kind` `local-machine`). A later host uses
`remote-agent`. Kraken would hand it a versioned job:

```json
{
  "schemaVersion": 1,
  "jobId": "uuid",
  "deploymentId": "sentient-potato-local",
  "executionHostId": "host-id",
  "operation": "verify-artifact",
  "releaseRef": {
    "modelId": "sentient-potato",
    "releaseVersion": "0.1.0-rc.1",
    "artifactSha256": "64 hex characters"
  }
}
```

Allowed operations are `verify-artifact`, `start-runtime` and `stop-runtime`.
There is no shell string. The agent would report progress
`{ schemaVersion, jobId, status, message }`, return artifact checksums rather
than weights, and record a terminal result. `submitRemoteJob` currently
validates that shape and returns `REMOTE_AGENT_UNAVAILABLE` without a network
call. The chat path does not call it.

The remote host, once built, should poll Relay for inference with its own runner
credential. Build jobs and chat requests stay on different channels.

## Product modes

Hosting location and management responsibility are separate fields:
`hostingMode` and `management`.

| Mode                                    | Hosting                                                                          | Management                                                                                             | V0                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Hybrid, this POC                        | `local-execution` on the Captain’s computer. Portal is AI Captain’s hosted Deck. | `captain-managed` for the model. AI Captain operates the portal.                                       | Implemented                                                                                               |
| 1. Fully self-hosted                    | Customer runs portal, Kraken, Relay, storage and inference                       | Customer                                                                                               | The same processes can run on loopback. No installer, account replacement, or support bundle is provided. |
| 2. Self-managed AI Captain Cloud Models | `aicaptain-cloud`: the Captain’s deployment runs on AI Captain infrastructure    | `captain-managed`: the Captain chooses release, profile and lifetime; AI Captain operates the machines | Not implemented. This is the intended meaning of option 2.                                                |
| 3A. Managed business models             | `provider-cloud` or `aicaptain-cloud`                                            | `aicaptain-managed` for a customer-specific configuration                                              | Not implemented                                                                                           |
| 3B. Generic on-demand models            | Provider or AI Captain cloud                                                     | `provider-managed` shared models                                                                       | Not implemented                                                                                           |

Deck’s question API stays `{ text }` in and
`{ requestId, traceId, status, output }` out for every mode. Billing, automatic
provider fallback and a plugin framework are out of scope.

`arrangement: "hybrid"` is the label for the hosted portal plus local inference.
`self-hosted` is accepted by the local runner and means the same local process
with a customer-operated portal. Cloud arrangements are rejected at deploy with
`MODE_UNAVAILABLE`.

## Verification limits

Automated tests cover Relay authorisation, expiry, idempotency, profile
mismatch, WormVolt denial, process reuse and export redaction. A local smoke
test started the pinned GGUF through `kraken model`, asked a question through
the Deck page and Relay, and received a completion whose profile checksum
matched `sentient-potato:0.1.0-rc.1`. Stopping revoked the runner and the page
showed the model as stopped. Restart left one `llama-server` and the page became
ready again.

That smoke used account `local-captain` and environment `local-harbour` against
Relay on `127.0.0.1`. It is not the hosted journey.

## Hosted verification — 15 November 2026

The signed-in hosted journey completed at 22:48 UTC through
`https://captains-deck.aiaicaptain.co.uk/model-poc` →
`https://relay-inference.aiaicaptain.workers.dev` → the outbound Mac runner →
`127.0.0.1:18080`. The response was generated by the pinned local GGUF.

- Account from the signed-in account service: `fVVdr6L3gFbDpf495aVho9zWkncPMXSY`.
- Selected environment from `GET /api/environments` without a query:
  `aicaptain:fVVdr6L3gFbDpf495aVho9zWkncPMXSY` (AiCaptain).
- Request: `e52d5aa8-da77-4751-a96c-5bea7a528b4b`.
- Trace: `1b4419ec-47f1-439b-907b-08f861b93677`.
- Question: “In one short sentence, what is your name and what is 7 plus 5?”
- Answer: “My name is Potato, and 7 plus 5 equals 12.”
- Profile checksum:
  `e16697d86da2d7f4f728bd63437cff063c5bd194035b07f9fef2311fb711a454`.

The signed-in Deck response and public Relay response carried those request,
trace and checksum values. Relay logs recorded submission (201), runner lease
(200) and completed result (200). `models/local/runner.log` recorded the same
request and trace with `status: completed`, `http: 200`.

The restart left one llama-server and one runner. The server listens only on
`127.0.0.1:18080`; `kraken model status` reported `local ready; Relay available`.
The machine binding records the public Relay origin. The resolved deployment
record now contains the real scope above, not the synthetic local scope.

The service environment is stored outside the repository at
`~/.config/aicaptain/relay-inference/hosted.env` (mode 0600). To check or restart:

```sh
cd /Users/tom/Dev/AICaptain/captains-stack/KrakenBot
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
source ~/.config/aicaptain/relay-inference/hosted.env
pnpm exec kraken model status examples/sentient-potato-volt
pnpm exec kraken model restart examples/sentient-potato-volt
```

The runner token remains at
`~/.config/aicaptain/kraken-runners/sentient-potato-local` (mode 0600). A real
`kraken model export` and scans of the production assets, export, Volt records
and local logs found neither current service nor runner token. The browser
bundle also contains no `RELAY_SERVICE_TOKEN` identifier. No credentials are
recorded in this document.

Anonymous hosted HTML returned 302 to
`https://account.aiaicaptain.co.uk/?next=captains-deck`; anonymous question POST
returned 401; the live D1 request count stayed at one before and after the
anonymous probe. Public Relay returned 404 when the completed request was read
with another account or another environment. These live scope probes used the
service API; the successful browser question used the real signed-in session.
Automated Deck tests also cover server-side scope resolution, rejecting body
scope overrides and stopping anonymous requests before Relay.

Verification passed: 103 Deck tests, production TypeScript/Vite build, and 11
combined Relay/Kraken model tests. The hosted work required three focused fixes:
Workers-compatible redirect refusal in Deck, explicit paired scope changes on
Kraken restart, and Relay isolation when different scopes use the same deployment
id. No billing, hosted model runtime, provider fallback or remote agent was added.
