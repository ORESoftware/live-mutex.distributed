# live-mutex cross-runtime clients

Reference clients for the `live-mutex` broker in ten languages. Each client
speaks the same JSON-over-TCP wire protocol the JS broker exposes (NDJSON;
one frame per line). The broker also exposes an optional HTTP JSON API, so
runtimes without a native package can still acquire/release locks, semaphores,
RW locks, and acquire-many holds with ordinary HTTP calls.

The native TypeScript client is the library itself (`src/client.ts`), so the
list below plus TypeScript covers Dart, C++, Python, TypeScript, Go, Gleam,
Rust, Java, Shell and PowerShell.

| Language    | Path                | TCP acquire/release | Semaphore `max` | Fencing tokens | acquire-many | RW lock path | Smoke test |
|-------------|---------------------|:-------------------:|:---------------:|:--------------:|:------------:|:------------:|:----------:|
| Rust        | `clients/rust`      | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `cargo run --example smoke` |
| Python 3    | `clients/python`    | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `python -m live_mutex_client.smoke` |
| Go          | `clients/go`        | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `go run ./cmd/smoke` |
| Dart        | `clients/dart`      | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `dart run example/smoke.dart` |
| Java 17+    | `clients/java`      | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `mvn -q exec:java` |
| C++17       | `clients/cpp`       | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `make run` / `make test` |
| Gleam       | `clients/gleam`     | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `LIVE_MUTEX_SMOKE=1 gleam test` |
| Shell       | `clients/shell`     | ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `./clients/shell/smoke.sh` |
| PowerShell  | `clients/powershell`| ✅                  | ✅              | ✅              | ✅           | HTTP/raw TCP  | `pwsh ./clients/powershell/smoke.ps1` |
| TypeScript  | `src/client.ts`     | ✅                  | ✅              | ✅              | ✅           | ✅            | `npm test` |

All clients implement at minimum:

- A `connect(host, port)` that sends the version handshake (`{type:"version", value:"0.2.25"}`).
- An `acquire(key, opts)` that returns `{lockUuid, fencingToken}`; `opts.max`
  (or HTTP `cap` / `semaphore`) makes the key a semaphore.
- A `release(key, lockUuid, opts)` that returns when the broker confirms.
- An `acquireMany(keys, opts)` that returns `{lockUuid, fencingTokens}` for the union of `keys`.
- A `releaseMany(lockUuid)`.
- A correlation map keyed by request-uuid so a single connection can multiplex.

**Wire format crib sheet** (see also `clients/PROTOCOL.md` for the full
specification):

```
client → broker
  {type:"version", value:"0.2.25"}
  {type:"lock", uuid, key, ttl?, max?, pid?}
  {type:"unlock", uuid, _uuid:<lockUuid>, key, force?}
  {type:"acquire-many", uuid, keys:[…], ttl?}
  {type:"release-many", uuid, lockUuid}

broker → client
  {type:"lock", uuid, key, acquired:bool, fencingToken?, lockRequestCount, error?}
  {type:"unlock", uuid, key, unlocked:bool, lockRequestCount, error?}
  {type:"acquire-many", uuid, keys, acquired:bool, lockUuid?, fencingTokens?, contendedKey?, error?}
  {type:"release-many", uuid, lockUuid?, keys?, released:bool, error?}
```

The minimal TCP clients do not all ship a first-party RW helper. RW locks are
still supported for every language through the broker's HTTP endpoints
(`/v1/rw/read-lock`, `/v1/rw/write-lock`, and matching release routes) or by
issuing the raw RW TCP frames documented in `clients/PROTOCOL.md`.

Run the broker (the fencing-token-aware `Broker1`) before running any of the
smoke tests. The C++/Gleam smokes default to `127.0.0.1:7970`; override with
`LMX_HOST`/`LMX_PORT`. A quick way to start `Broker1`:

```sh
node -e "const {Broker1}=require('./dist/main.js'); \
  new Broker1({port:7970,host:'127.0.0.1'}).ensure().then(()=>console.log('up'))"
```
