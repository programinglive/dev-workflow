# Build host attribution

The monitor card must name the machine that actually executed the build, not the
machine that started the AI session.

## Resolution order

`run_tests` and `report_build_status` resolve the build host in this order:

1. `buildHost` argument (explicit, per call)
2. `DEVWF_BUILD_HOST` environment variable
3. the workflow session machine (`workflowState.state.machine`)
4. `os.hostname()`

Before this change the session machine was checked before `DEVWF_BUILD_HOST`, so
a CI job that ran on the build-host.example runner was labelled with the workstation that
started the session (for example `HELLOWORLD`).

## Fleet default

`managed/launcher.cjs` now sets `DEVWF_BUILD_HOST=build-host.example` when the variable is
absent, because the fleet standard is that every build, test suite and pipeline
runs on the universal self-hosted Linux runner (`bw-tools`, `127.0.0.1`). A device that genuinely builds
elsewhere can still override it, or pass `buildHost` on the call.

## Verifying

- `node --test tests/build-host-precedence.test.js`
- After a rollout, run a build and confirm the monitor card shows
  `Build host: build-host.example`.
