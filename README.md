# AirShare

AirShare is a small live file handoff app for browsers and terminals. It relays bytes through the server as a stream and does not write uploaded file contents to server storage.

## Features

- Browser UI for creating share links
- Receiver and sender pages for one-off transfers
- Terminal-friendly upload and download flow with `curl` or `wget`
- Server-relayed streaming instead of persistent file hosting
- Multiple waiting receivers for the same file

## Requirements

- [Bun](https://bun.sh/) 1.0 or newer

## Run Locally

```sh
bun install
bun run start
```

The app listens on `http://localhost:3070` by default. Set `PORT` to use a different port.

```sh
PORT=8080 bun run start
```

## Terminal Usage

Create a receive link and wait for a sender:

```sh
curl -s -J -O -L -D - http://localhost:3070/xfr
```

Create a send link for a file:

```sh
curl -T ./myfile.zip -s -L -D - http://localhost:3070/xfr
```

The server must stay running while transfers are active. Sender and receiver sessions generally need to overlap because files are streamed live rather than stored for later download.

## Deployment Notes

AirShare is designed for a long-running Bun or Node-compatible host. Platforms with short request limits or serverless-only execution are a poor fit for large or slow transfers.

Good targets include a VPS, Docker host, Fly.io, Render, Railway, or another service that supports long-lived HTTP streaming.

## Privacy Model

AirShare is not peer-to-peer. The server relays the traffic and can observe file contents unless you add client-side encryption before upload.

## License

MIT
