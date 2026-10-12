# dsh-ops-guard

Turns "downloads must go through aria2" from **advice in a skill** into **runtime enforcement**.

## Why

The `aria2-download` skill states the rule in its prompt, and **a prompt is only advice**. What actually happened:

| | aria2 channel | Bypass channel |
|---|---|---|
| Engine | aria2-next (Motrix Next) | single-connection node https |
| Measured speed | **11.78 MB/s** | **0.13 MB/s** |
| Visible in Motrix | ✅ | ❌ |
| Resumable | ✅ | partial |

The same 4.76 GB Windows 11 image, roughly **90x apart**. And an agent holding a `download.cjs` will use it, because **at the shell level `node download.cjs` and `aria2-dl.js` look identical** — nothing distinguishes them.

This plugin moves the rule into the runtime: **intercept the tool call, deny it, and hand back the correct aria2 command**.

## How it works

It listens on cordis' `tools/pre-execute` hook (waterfall mode) and rules **before the tool body ever runs**:

```
model requests pwsh("curl -o x.iso https://...")
    ↓
tools/pre-execute fires
    ↓
recognised as a download → { kind: 'deny', reason: '<ready-to-run aria2 command>' }
    ↓
the call is refused and the reason is shown to the model (the body never ran)
```

## The search guard

The same argument applies to file search: the `everything-cli` skill states the rule in prose, and an agent holding a built-in `glob` tool has **no reason** to reach for es.exe. The rule has to live in the runtime.

Everything keeps a resident full-disk index (measured: **2.5M files**); `es.exe` answers in milliseconds, while the built-in `glob` makes ripgrep walk the tree on every call.

### Only glob is redirected, never grep

The built-in search surface is **two** tools, and they are **not** equally replaceable:

| Tool | Finds by | Replaced | Basis |
|---|---|---|---|
| `glob` | **filename / path** | ✅ yes | that is exactly what Everything does |
| `grep` | **file content** | ❌ no | see below |

**Why grep is left alone**: Everything's content search requires the user to opt into content indexing, which was **measured as off** on this machine:

```
es.exe "content:dsh-ops-guard"        → no output
es.exe -get-result-count "content:..." → no output
```

Denying grep in that state would replace *slow* content search with *no* content search — far worse than the problem it prevents. The guard's own rule applies: **prefer a missed optimisation over a blocked workflow.** The refusal text says explicitly that grep is unaffected, so the model does not route around it.

### glob → es.exe mapping

The pattern language needs almost no translation (`**` is recursive in both); only the argument name differs:

| built-in glob | es.exe |
|---|---|
| `pattern: "**/*.ts"` | `es.exe "**/*.ts"` |
| `path: "D:\proj"` | `-path "D:\proj"` |
| no `path` (= workspace) | `-path <session workspace>` |

Two details confirmed by measurement:

- **`**` must be preserved**: `src/**/*.ts` matches `src/__deep/probe.ts`, while `src\*.ts` does **not** recurse. The pattern's shape is passed through, never flattened.
- **Globs must be quoted**: an unquoted `*.ts` is expanded by the shell before es.exe ever sees it.

### Why es.exe is probed once, at load

`tools/pre-execute` runs in front of **every** tool call, so probing for es.exe (a dozen directory stats) inside the hook would be waste. It is resolved once at mount instead.

The probe deliberately does **not** check whether Everything is running: es.exe talks to it over IPC and fails at call time if the service is down. Spawning a process from a pre-execute hook is the wrong place for that — the model sees the real error when it runs the command, which beats a guard guessing.

### Why not the approval hook

The `approval/request` waterfall is **dead under an approval policy of `never`** — `ApprovalService.decide()` returns before it is ever dispatched:

```js
if (this.effectivePolicy(session) === "never") return "rejected";  // returns here
const answer = ... this.ctx.waterfall(..., "approval/request", ...)   // never reached
```

`tools/pre-execute` is a **separate waterfall with no such short-circuit**, so it works under every policy.

## What is blocked

The criterion comes from the skill itself: **whether bytes are being written to disk** — not what the URL looks like or how large the file is.

| Blocked | Allowed |
|---|---|
| `curl -o F` / `curl -O` / `curl --output F` | `curl https://api.x/status` (stdout only) |
| `wget <url>` (writes a file by default) | `wget -O - <url>` (explicit stdout) |
| `Invoke-WebRequest ... -OutFile F` | `Invoke-WebRequest https://api.x/status` |
| `Invoke-RestMethod ... -OutFile F` | `Invoke-RestMethod https://api.x/data` |
| `Start-BitsTransfer ...` | — |

**Deliberately not blocked** (by design):

- `pip install` / `npm install` and other package managers — out of scope for this plugin
- `git clone` — git owns its own transport
- commented-out commands (a shell never runs them)
- non-shell tools (even when their arguments contain `curl -o`)
- **merely mentioning a filename** (e.g. printing `download.cjs` in a log) — a former filename-matching rule was removed after it produced false positives

Detection is **biased toward false negatives**: blocking an ordinary command is a visible regression, while missing a download is merely the status quo.

## What the model sees when blocked

```
BLOCKED by dsh-ops-guard: this command downloads a file to disk
(matched: curl-output), and downloads must go through the local aria2 engine
(Motrix Next) so they are multithreaded, resumable and visible in the download manager.

Use instead:
  node "$env:USERPROFILE\.dsh\skills\aria2-download\scripts\aria2-dl.js" "<URL>" --out=<filename>

Options: --dir=<dir> for the destination, --header="K: V" for headers,
--no-wait to enqueue and return immediately (then query with --status <gid>).
A blocked command is never partially executed.

Blocked command: curl -o Win11.iso https://.../y.iso
```

The **URL is extracted and substituted into the suggested command** — whoever was refused does not have to guess how to comply.

## The bundled forwarder

This package **ships** the aria2 forwarder:

```
scripts/aria2-dl.cjs
```

The path in a denial message is the **absolute path of this bundled copy**,
resolved at runtime from `import.meta.url`.

> **Why it must be bundled**: an earlier version pointed at
> `~/.dsh/skills/aria2-download/scripts/aria2-dl.js` — a machine-private path.
> On a machine without that skill the guard would refuse a download and then
> name a file that does **not exist**. That is worse than not blocking: it
> breaks the workflow and offers no way out.

The script talks **JSON-RPC only** (no `aria2c.exe` needed) and requires a
running **aria2-next** engine (bundled with Motrix Next). A missing engine is
reported explicitly rather than failing silently.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `ARIA2_RPC_PORT` | `16800` | Engine RPC port |
| `ARIA2_RPC_TIMEOUT_MS` | `15000` | RPC timeout |
| `ARIA2_DOWNLOAD_DIR` | the user's `Downloads` folder | Default destination (no hardcoded drive) |

### Direct use

```bash
node scripts/aria2-dl.cjs <url> --out=<name> [--dir=<dir>] [--no-wait]
node scripts/aria2-dl.cjs --status <gid>
node scripts/aria2-dl.cjs --list
```

## Install

```bash
cd ~/.dsh && dsh plugin --profile <your-profile> add "dsh-ops-guard@github:BeiWay1145/dsh-ops-guard"
```

**Restart DSH** afterwards.

## Known limits

- **Cannot catch a download that happens INSIDE a command**: a `python script.py` using `urllib` looks like `python script.py` from here. Fully closing that needs a proxy layer, which is out of scope.
- **Cannot catch downloads outside DSH**: a `curl -o` in an unrelated terminal is unaffected.
- Requires the host's `tools/pre-execute` hook (verified on the DSH 0.1.5-rc series).

## Development

```bash
npm install
npm test          # build + detector unit tests + real-ToolRuntime runtime test
npm run typecheck
```

Two test layers:

- `tests/detect.test.mjs` — the pure detection rules (38 checks, heavy on must-stay-allowed near-misses)
- `tests/guard.runtime.mjs` — loads the **built artifact** into a real cordis + ToolRuntime and proves a deny really stops the tool body

The runtime test locates an installed DSH tree itself and **skips rather than fails** when none is present, so a bare checkout still passes.

## License

MIT
