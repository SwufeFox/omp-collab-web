# @oh-my-pi/collab-web

Standalone browser guest client and local relay tools for **omp collab** live sessions. Paste a `/collab` link into the browser to follow the live transcript, inspect tool runs, browse subagent transcripts, and prompt (or stop) the host agent.

## Quick start

```sh
bun install

# One-command offline demo: starts the dev server + scripted mock host and prints a direct browser link
bun run demo
```

Or run the servers individually:

```sh
# Dev server (Bun HTML dev server with HMR) — http://localhost:3000
bun run dev

# Offline mock host + local relay on ws://localhost:7466
bun run mock-host

# Standalone content-blind WebSocket relay on ws://localhost:7466
bun run relay
```

## Build, test & typecheck

```sh
bun test             # Run unit tests
bun run check:types  # TypeScript check
bun run build        # Build static bundle into dist/
```

`dist/` is a fully static SPA that can be hosted anywhere:

- **Secure context**: room keys are unwrapped with WebCrypto (`crypto.subtle`), which browsers expose on `https://` or `localhost`.
- **End-to-end encrypted**: the room key stays in the URL fragment (`#...`) and is never sent to the relay or stored in `localStorage`.
- **Default relay**: bare `<roomId>.<key>` links connect to `wss://my.omp.sh`, while `ws://localhost:...` links connect directly to a local relay.
