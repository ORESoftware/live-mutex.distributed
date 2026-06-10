# live-mutex.distributed — clients audit (2026-06-09)

Audited the client suite for correctness: offline protocol tests + end-to-end
smokes against a live legacy `Broker1` (TCP 127.0.0.1:7970; clients read
`LMX_HOST`/`LMX_PORT`). Broker started with:
`node -e "const {Broker1}=require('./dist/main.js'); new Broker1({port:7970,host:'127.0.0.1'}).ensure()..."`
(after `npm run compile` to build `dist/`).

## Result matrix

| Language | Offline protocol test | Live smoke (vs Broker1) | Notes |
|---|---|---|---|
| Go | (smoke only) | **PASS** (`go run ./cmd/smoke`) | |
| Python | (smoke only) | **PASS** (`python3 -m live_mutex_client.smoke`) | `PYTHONPATH=src` |
| C++ | **PASS** (`make test`) | **PASS** (`make run`) | header-only |
| Rust | (smoke only) | **PASS** (`cargo run --example smoke`) | |
| Gleam | **PASS** (`gleam test`) | **PASS** (`gleam test` w/ smoke env) | needed gleam ≥1.14 |
| Shell | (smoke only) | **PASS** (`smoke.sh`) | |
| Java | blocked | blocked | needs Maven (`mvn`) — not installed |
| Dart | blocked | blocked | no `dart` SDK |
| PowerShell | n/a | blocked | no `pwsh` |

**Every client with a locally-available toolchain passed. No client correctness
defects found.**

## Note

These clients target the **legacy single-broker** `Broker1`, not the new
distributed consensus engine (`src/distributed/`), which has no external client
API yet — see `deploy/AUDIT.md`. So the clients here exercise the single-node
protocol, not the cluster.
