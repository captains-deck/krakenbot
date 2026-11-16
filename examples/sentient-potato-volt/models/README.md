# Model deployment

Canonical release facts stay in model-manifest at `releases/sentient-potato/0.1.0-rc.1/release.json`. This folder does not copy the system prompt, the GGUF, or a credential.

| Path | Owner | Shared |
| --- | --- | --- |
| `deployments/*.desired.json` | Captain, edited before deploy | Yes. References only. |
| `deployments/*.record.json` | Kraken, written at deploy | Yes. Resolved checksums and ownership. No weights or tokens. |
| `local/` | This machine | No. Process state, logs and the loopback binding. Git-ignored. |

The runner credential is `secret://aicaptain/kraken-runners/sentient-potato-local`. The file itself lives outside the volt, mode 0600. Relay’s service token stays in `RELAY_SERVICE_TOKEN`.
