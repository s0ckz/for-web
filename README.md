<div align="center">
<h1>
  Stoat Frontend
  
  [![Stars](https://img.shields.io/github/stars/stoatchat/for-web?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-web/stargazers)
  [![Forks](https://img.shields.io/github/forks/stoatchat/for-web?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-web/network/members)
  [![Pull Requests](https://img.shields.io/github/issues-pr/stoatchat/for-web?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-web/pulls)
  [![Issues](https://img.shields.io/github/issues/stoatchat/for-web?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-web/issues)
  [![Contributors](https://img.shields.io/github/contributors/stoatchat/for-web?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-web/graphs/contributors)
  [![License](https://img.shields.io/github/license/stoatchat/for-web?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-web/blob/main/LICENSE)
</h1>
The official web client powering https://stoat.chat/app, built with <a href="https://www.solidjs.com/">Solid.js</a> 💖. <br/>
Track the project roadmap on <a href="https://op.stoatinternal.com/projects/revolt-for-web/roadmap">OpenProject</a>.
</div>
<br/>

## Development Guide

Before contributing, make yourself familiar with [our contribution guidelines](https://developers.stoat.chat/developing/contrib/), the [code style guidelines](./GUIDELINES.md), and the [technical documentation for this project](https://stoatchat.github.io/for-web/).

Before getting started, you'll want to install:

- [Git](https://git-scm.com/install/)
- [mise-en-place](https://mise.jdx.dev/getting-started.html)

Then proceed to setup:

```bash
# clone the repository
git clone --recursive https://github.com/stoatchat/for-web client
cd client

# update submodules if you pull new changes
# git submodule init && git submodule update

# install all packages
mise install:frozen

# build deps:
mise build:deps

# or build a specific dep (e.g. stoat.js updates):
# pnpm --filter stoat.js run build

# customise the .env
cp packages/client/.env.example packages/client/.env

# run dev server
mise dev

# run all CI checks locally
mise check
```

Finally, navigate to http://local.revolt.chat:5173.

### Using the official backend

By default, the client connects to a backend running on the same host (localhost).

If you want the client to connect to the official hosted backend instead, open the .env file at /packages/client/.env and comment out the local URL varaibles like this:

```env
# connect to local Stoat instance
#VITE_API_URL=http://localhost:14702
```

When these variables are not set, the client automatically falls back to the official backend. (See https://github.com/stoatchat/for-web/blob/main/packages/client/components/common/lib/env.ts)

## Deployment Guide

### Build the app

```bash
# install packages
mise install:frozen

# build dependencies
mise build:deps

# build for web
mise build

# ... when building for Stoat production
mise build:prod
```

You can now deploy the directory `packages/client/dist`.

### Routing Information

The app currently needs the following routes:

- `/login`
- `/pwa`
- `/dev`
- `/discover`
- `/settings`
- `/invite`
- `/bot`
- `/friends`
- `/server`
- `/channel`

This corresponds to [Content.tsx#L33](packages/client/src/index.tsx).

## Screen share sender diagnostics

Every active screen share samples its sender approximately every 10 seconds,
independently of the on-screen stats panel. `[rtc] screen share sender` console
messages contain encoded/sent/source FPS where available, interval bitrate,
mean encoding time, encoder implementation, codec, resolution, sender limits,
link capacity, RTT, and interval CPU/bandwidth limitation durations. The desktop
shell forwards these messages into its local `app-audio.log`.

The first sample establishes a baseline; missing measurements are `null`, not
zero. A new RTP stream, sender replacement, counter reset, or stats failure
cannot inherit a previous stream's rates. Sampling stops on unpublish, share
end, or disconnect, including in-flight requests. Logs omit media content,
participant identities, ICE addresses, and credentials. Sampling changes no
stream quality, encoder parameters, or publication behavior.

Run the diagnostic unit tests with the project's Node runtime:

```sh
node --test packages/client/components/rtc/screenShareDiagnostics.test.mjs
```
