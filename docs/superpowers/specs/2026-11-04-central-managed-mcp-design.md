# Central managed MCP deployment

Owner request: one server-side update must reach HELLOWORLD, MMCH and Mac without manually updating three checkouts. Active work must show an actual task and project; an idle connection is not a task.

## Architecture

Use n8n-instance (Node 22, low load, approximately 1.5 GiB available RAM) for an authenticated, Tailscale-only release service on port 3101. Store immutable source archives and an atomic current manifest. Keep the existing monitor and state replicas on db-host.example.

Each MCP client retains a small stable managed launcher. At process startup it fetches the approved manifest, verifies the archive SHA256, installs the release into a platform/Node-ABI-specific cache, and starts its local executor. All workflow code comes from that central release, not a device's development checkout. Git, filesystem access, tests, and existing credentials remain on the originating device. This is centrally managed distribution with local execution, not execution of local Git commands on a remote server.

No running task is hot-swapped. Existing processes pin their release until reconnect; new connections automatically use the promoted release. On network failure an already verified cached release may run with an explicit stderr warning. Authentication failure, invalid manifests, corrupt downloads, unsafe archives and failed installs must fail closed, without promoting a cache.

## Session presentation

Keep connection heartbeats for device last-seen data. Active-task queries require a nonempty task or a real session title, exclude closed/done/cancelled records, and expire empty idle records. Real titled sessions may show their session title; anonymous connections never create '(tanpa task)' cards. Start the implementation task with its actual description, DoD and plan; do not invent titles for unrelated sessions.

## Deployment and constraints

- Service has a dedicated OS user, bounded memory, private environment file and no public firewall changes.
- Reuse existing monitor authentication in memory; never print tokens or store them in release archives.
- Only explicitly published source archives are served. No arbitrary filesystem endpoint or remote shell endpoint.
- Preserve each device's machine label, agent label, working directory, state location and Factory credential loader.
- Back up client configuration before changing only its dev-workflow command.
- Preserve dirty shared checkout changes, dashboard layout and all unrelated services.
- Verify authenticated startup and task metadata from each reachable device. Report any reconnect requirement truthfully.

## Acceptance

One promotion on n8n-instance is consumed by managed launchers on all three devices. The runtime reports its source release. CPU/RAM/disk of unrelated services stay within their existing operating range. Active cards have meaningful task/title and machine identity; empty connections only contribute device liveness.
