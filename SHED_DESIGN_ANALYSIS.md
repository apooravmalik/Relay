# Shed: mobile design and architecture analysis

Reviewed 3 November 2026 against [Shed source, commit 2e6a647](https://github.com/IAmUnbounded/shed/tree/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3). The visual review uses the repository's checked-in product demo screenshots; it is not a live test of the macOS host.

## Verified: product and mobile design

[Shed](https://shed-sigma.vercel.app/) is an MIT-licensed browser interface for coding agents running on a Mac. Its [phone home demo](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/video/public/product/p-home.png) presents live sessions in a two-column card grid. Each card combines an agent, project, plain-language state and task summary; color and illustrations reinforce whether action is needed. A compact composer stays at the bottom. The visual language is warm off-white, muted green and terracotta, with a serif heading and monospace metadata.

The [conversation demo](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/video/public/product/p-chat.png) uses a full-screen drawer, segmented Conversation/Terminal/Files navigation, sender and time labels, readable message cards, attachment chips and a bottom composer. Shed also has a Changes view, session search, project selection, files preview and notifications; see its [README](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/README.md).

These screenshots contain demo data. This review did not validate the host's performance, accessibility or interaction on a real phone.

## Verified: host, connection and sleep

Shed's Node server defaults to `127.0.0.1:4378`. A separate `cloudflared` process connects a Cloudflare tunnel to that local port; remote phones use the HTTPS address. The free Quick Tunnel address can change after restart. A password and device approval protect remote sign-in, and the Mac must stay awake and online. Closing a laptop lid does not, by itself, ensure its agents continue running. See the [README](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/README.md), [server](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/server/index.js) and [tunnel](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/server/tunnel.js).

Relay's existing model instead runs the agent on the VM and publishes its loopback controller privately through Tailscale Serve. The VM can therefore keep working while the Mac sleeps after handoff; it does not require adopting Shed's public tunnel.

## Verified: data and updates

Shed combines server-sent events with polling. `/api/events` pushes live status changes and session/exchange notifications. The client refreshes versioned session and task data after notifications and every five seconds as a fallback, and refreshes when the page becomes visible again. Open terminal content is periodically sampled. This is not evidence that all transcript text is token-streamed. See [client code](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/public/app.js) and [server code](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/server/index.js).

Shed caches its app shell with a service worker and shows last-seen lists while the initial bootstrap request completes; API responses are not cached by that service worker. It avoids rebuilding unchanged views and uses versioned responses and compression to reduce work and transfer. Push notifications use Web Push; see [service worker](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/public/sw.js) and README. Relay already streams Codex message deltas through its controller's SSE response.

## Verified: images and attachments

Shed stores files on the host filesystem, not in a separate image cloud. An upload is streamed to a randomly identified staging directory with a 100 MB limit; on send it is moved to `<project>/.shed/uploads/` and the agent receives its full path. Unsent staging directories are swept after a day. Shed tries to exclude `.shed/` via the local Git exclude file; its source notes that this can fail for worktrees. See [uploads.js](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/server/uploads.js).

For generated artifacts, Shed lists supported files inside the project and offers previews or downloads. It resolves real paths to prevent escaping the project through symlinks, excludes hidden and dependency directories, and serves files with private/no-store headers and byte-range support. See [files.js](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/server/files.js).

## Recommendations for Relay

1. Adapt the mobile information hierarchy: make project name, current task and truthful running/waiting/offline state prominent. Put the primary continuation action within easy reach.
2. Use a calm, readable conversation surface with distinct sender labels, an anchored composer and an accessible compact navigation between chat, changes and eventually files. Preserve readable contrast and safe-area and keyboard behavior on small devices.
3. Keep Relay's existing VM-based execution and private Tailscale access. Present a clear disconnected or stale state rather than implying a live connection.
4. Keep token streaming, and add reconnection and history reconciliation so a dropped phone connection cannot make a running turn appear lost. Preserve scroll position when new activity arrives.
5. Add attachments and artifact previews as a separate end-to-end feature: scoped uploads on the VM, size limits, retention and cleanup, safe names, path containment and explicit Git exclusion that also works with worktrees. Do not add attachment controls before they work.
6. If reusing substantial Shed code, retain its [MIT copyright and permission notice](https://github.com/IAmUnbounded/shed/blob/2e6a647a59a2c33e32add7fcde2c6cf21aaa9dc3/LICENSE). Prioritize usability testing on an actual phone before deploying changes.
