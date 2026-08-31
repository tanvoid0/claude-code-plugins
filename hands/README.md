# hands

Start, stop and look at the app in front of you.

`governor` decides what a session may spend. `crew` decides who does the work.
`hands` does the part that is not thinking: run the project, free the port, take
the screenshot.

## Why

The token cost of running a project is not the command. It is re-deriving the
command. Four repos in four stacks means reading `package.json`, `Cargo.toml`
and `pyproject.toml` again at the start of every session to work out how the
thing starts, and again to work out what to kill when it will not restart.

`hands` derives it once and writes the answer to `.claude/launch.json` — which
is the harness's own launch format, so `preview_start` reads the same file. One
file, two readers, no new config.

## Commands

| command | does |
|---|---|
| `/up [app]` | detect the stack, start in the background, wait for the port to answer |
| `/down [port\|--all]` | kill the listener and its children — cached port if none given |
| `/restart [app]` | down, wait for the socket to clear, up |
| `/logs` | tail the dev server started by `/up` |
| `/shot` | screenshot the running app: browser pane for web, desktop capture for native |
| `/procs` | every dev server and container port on this machine, with its pid |

## Detection

First rule that matches wins.

| marker | stack | command | port |
|---|---|---|---|
| `src-tauri/tauri.conf.json` | tauri | `<pm> run tauri dev` | from `build.devUrl`, else 1420 |
| `next.config.*` | nextjs | `<pm> run dev` | 3000 |
| `vite.config.*` | vite | `<pm> run dev` | 5173 |
| `manage.py` | django | `<py> python manage.py runserver` | 8000 |
| a `FastAPI()` app | fastapi | `<py> uvicorn <mod>:<var> --reload` | 8000 |
| `scripts.dev` | node | `<pm> run dev` | — |
| `Cargo.toml` | rust | `cargo run` | — |
| `go.mod` | go | `go run .` | — |
| a compose file | compose | `docker compose up` | — |

`<pm>` comes from the lockfile: bun, pnpm, yarn, else npm. `<py>` is `uv run` on
a `uv.lock`, `poetry run` on a `poetry.lock`, nothing otherwise — a bare
`uvicorn` in a managed project resolves to the wrong interpreter.

Tauri outranks the Next config it contains — `npm run dev` there starts half the
application. A compose file ranks last for the mirror reason: a repo with both a
compose file and a dev server usually wants the dev server.

FastAPI is found by walking, not by a filename list. Any `.py` within four
levels that *assigns* `FastAPI(...)` counts — `from fastapi import FastAPI` and
`def build() -> FastAPI(...)` do not — and the app's real variable name is kept,
so `api = FastAPI()` yields `…:api`. Virtualenvs, `site-packages`, `tests`,
build output and dotdirs are skipped: FastAPI's own source lives in
`site-packages`, and matching it would point uvicorn at the library.

Two apps in one repo are ranked, not raced: shallower wins, then `main.py` >
`app.py` > `server.py` > anything else. A sub-router that builds its own
`FastAPI()` therefore loses to the real entrypoint.

If the guess is still wrong, edit `.claude/launch.json` — a cached config is
never overwritten unless you pass `--fresh`.

## Ports

A stack's default port is a guess, and it is wrong for any repo that moved off
it. Four sources, most explicit first:

1. a `--port` / `-p` flag in the dev script — someone typed that on purpose
2. the framework's own config (`server.port` in `vite.config.*`)
3. `PORT` / `APP_PORT` / `SERVER_PORT` in an env file, resolved in the order the
   tooling resolves them: `.env.development.local`, `.env.local`,
   `.env.development`, `.env`
4. the stack default

Which of 2 and 3 applies depends on what the framework actually reads. Next
reads `PORT` itself, so an env file is a genuine override there. Vite does not,
so its own config outranks the env file. Neither `uvicorn` nor `runserver`
reads `PORT` at all — so when an env file names one, `hands` puts it on the
command line (`uvicorn main:app --reload --port 8080`) rather than reporting a
port the server was never told about.

## Schemes

`http://localhost:<port>` is the right URL until it isn't. A dev server on TLS
answers on the same port but rejects `http://`, so the scheme travels with the
port as a `url` — which is a field of the harness's own launch.json schema, so
`preview_start` opens it correctly too, not just `/shot`.

Two sources: a Tauri `build.devUrl` is already a URL, so it is taken whole; a
Vite config with `server.https` set to anything but `false` yields
`https://localhost:<port>`. Everything else gets the plain http form.

## Monorepos

`.claude/launch.json` lives at the repo root — the git root, not the cwd — so
one file holds every app in the workspace. Each is named for its path, so two
Next apps do not collide on `nextjs`.

The root is tried first and wins when it detects: a turborepo with its own
`turbo run dev` script wants that, not one of its apps. Only when the root is
not runnable does `hands` look in `apps/`, `packages/`, `services/`, `crates/`
and `examples/`. One app found there is used; more than one exits 2 with the
list, and `/up` asks rather than picking. `ops.js scan` prints the list at any
time.

## Starting

Spawning is not starting. A dev server that dies on a syntax error still spawns
happily, so `/up` follows the launch with `ops.js wait <port>`, which polls the
socket until it answers or the timeout runs out. "Started" means the port
answered.

`/restart` exists because the reverse is also true: a kill returns before the
socket is released, and a dev server that finds its port taken picks the next
one silently — so the app comes up somewhere nobody is looking.

## Killing

`/down` kills the listening process **and its children**. That is the point: a
Tauri run has cargo holding the app binary as a child, and killing the listener
alone leaves the webview running to fight the next `/up`.

Ports below 1024 are refused unless `--force` is passed, and pids 0 and 4 are
never touched — killing pid 4 on Windows bluescreens the machine.

`/down --all` kills every port cached for the workspace, deduplicated. It only
knows apps that have been detected at least once, so `/procs` remains the check
for anything started outside `hands`.

## Check

```bash
node ops.js selftest
```

Asserts the detection table, the port precedence rules, TLS scheme handling,
the monorepo scan and naming, the launch.json round-trip, the Docker port parse,
and that a port is read off the end of an address — so `:3000` never matches
`:13000` and an IPv6 address, which is nothing but colons, still resolves.
