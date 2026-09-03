# Relay Room

Relay Room is an asymmetric human × AI escape-room game built around WebMCP. The human sees the room and operates its physical controls; the AI agent receives a private manual and controls remote systems through tools exposed by the page.

Live version: https://relay-room.firt.chatgpt.site

## Features

- Three-stage escape-room flow
- Eight WebMCP tools exposed through `document.modelContext`
- Separate setup instructions for ChatGPT Desktop and Chrome WebMCP clients
- Solo simulation mode for playing without a WebMCP client
- Generated Relay voice lines and responsive layouts
- Local progress and high-score persistence

## Requirements

- Node.js 22.13 or newer
- npm

## Run locally

```bash
npm ci
npm run dev
```

Then open the local URL shown by Vite.

## Validate and build

```bash
npm run lint
npm test
npm run build
```

The production build uses [vinext](https://github.com/cloudflare/vinext) and emits a Cloudflare Workers-compatible application in `dist/`.

## WebMCP support

The full game expects a compatible browser or client to expose `document.modelContext.registerTool`. Without it, use the built-in solo simulation from the setup screen.

The main game logic and WebMCP tool definitions live in `app/page.tsx`.

## Project structure

- `app/` — game UI, state and WebMCP tools
- `public/scenes/` — room artwork
- `public/voice/relay/` — Relay voice clips
- `tests/` — build and rendering checks
- `worker/` and `build/` — vinext/Cloudflare integration

The exported `.openai/hosting.json` intentionally contains no Site project ID. A fork should register its own deployment instead of targeting the original Relay Room site.
