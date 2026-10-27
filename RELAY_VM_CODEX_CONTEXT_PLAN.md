# Relay VM Codex session contract

## Goal

Every new Relay PWA conversation should begin with enough durable context for
Codex to work well on a private VM from a phone, without adding a long setup
message to every user prompt.

## What happened in `portfolio v2`

The last completed chat correctly described a local Next.js preview, but ended
with `http://127.0.0.1:3000`. That address names the VM itself, not the phone.
At the moment Relay checked the port, nothing was listening on VM loopback, so
Relay refused to create a Tailnet link rather than exposing a broken or public
service.

## V0: persistent instructions for each new Relay chat

Relay will send a concise **developer instruction** when it starts a Codex
thread. It is separate from the user's message and persists with that thread.
It tells Codex that:

1. The selected directory is a workspace on a private Relay VM.
2. A development server must bind only to `127.0.0.1` or `::1`, never
   `0.0.0.0`.
3. Before reporting a preview, Codex must verify both the listener and a local
   HTTP response.
4. Its final answer must report the local address as `http://localhost:<port>`.
   Relay detects that address, waits briefly for the listener when necessary,
   and creates the Tailnet-only phone link.
5. Before declaring work done, Codex must inspect the resulting change set and
   run the relevant available checks. Its final answer should state changed
   files, verification, and any unresolved limitation.

This is the narrowest reliable contract. It does not place an `AGENTS.md` file
inside a user's project, so Relay does not silently modify their repository.

## Existing conversations

Codex app-server supports `developerInstructions` when a thread starts. It
does not expose a safe equivalent for rewriting an existing thread's durable
developer context. Existing Relay chats keep their current context; new chats
receive this contract. A later migration may offer an explicit “start a Relay
VM chat” action rather than mutating a user's old conversation.

## Tokens and VM setup

Starting a process, installing a package, running tests, and reading command
output consume VM compute/time. They do **not** independently consume model
tokens. The instructions and any command output Codex reads do use model
context. Keeping the contract short, thread-level, and stable lets the Codex
harness reuse that context rather than repeating a long setup prompt in every
user message. It cannot make the instruction cost literally zero.

## Review and preview sequence

```text
User prompt
  -> Codex works in selected VM workspace
  -> starts loopback-only service, if needed
  -> verifies listener + local HTTP response
  -> runs relevant tests and inspects diff/status
  -> reports http://localhost:<port> and review evidence
  -> Relay validates loopback listener
  -> Tailscale Serve creates private phone URL
```

## Next increment after V0

The current automatic preview check is a point-in-time check. Relay should
retry that private-loopback validation for a short bounded window after Codex
reports a port, because some development servers announce their URL slightly
before they accept connections. It must continue to reject non-loopback
listeners and must never use Tailscale Funnel.

## Markdown rendering

The PWA is plain browser JavaScript, not React. Instead of adding React and
`react-markdown`, Relay should render a safe Markdown subset directly into DOM
nodes: paragraphs, headings, lists, code, quotes, tables, emphasis, and
HTTP(S) links. Raw HTML stays text, so Codex output cannot inject executable
markup into the private controller.
