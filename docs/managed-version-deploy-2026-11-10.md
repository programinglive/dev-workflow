# Deploying the version-carrying managed protocol

Date: **10 November 2026**.

## What was deployed, in order

| Step | Where | Result |
|---|---|---|
| `protocol.cjs` with semver validation | bw-tools `/opt/devwf-managed` | installed, sha `24949f05` |
| `release-server.cjs` | bw-tools | unchanged — it already forwards whatever `validateManifest` returns |
| Publish one release | this device, then uploaded | `current.json` gained `version: "1.28.0"` |
| `release_version`, `release_revision` columns | monitor database | added with `IF NOT EXISTS`, defaults `''` |
| `session-upsert.cjs`, `sessions-query.cjs` | bw-tools `/opt/devwf-monitor` | deployed; SQL now `$1..$27` |
| `launcher.cjs` and `protocol.cjs` | device bootstrap | installed, exports `DEVWF_RELEASE_VERSION` |

Backups taken before every replacement:

```
/opt/devwf-managed/protocol.cjs.bak-20261110-010233
/opt/devwf-managed/release-server.cjs.bak-20261110-010233
/var/lib/devwf-releases/current.json.bak-20261110-010338
/opt/devwf-monitor/session-upsert.cjs.bak-20261110-010752
/opt/devwf-monitor/sessions-query.cjs.bak-20261110-010752
%LOCALAPPDATA%\...\bootstrap\launcher.cjs.bak-20261110-080523
%LOCALAPPDATA%\...\bootstrap\protocol.cjs.bak-20261110-080609
```

## Proof the chain works

Every hop was verified, not assumed:

```
central manifest   {"revision":"ef1c952…","sha256":"7bf1deb…","size":4175840,"version":"1.28.0"}
launcher resolve   {"revision":"ef1c952…","version":"1.28.0","offline":false}
last-good.json     {… ,"version":"1.28.0"}
POST /api/session  HTTP 200
database row       release_version = "1.28.0", release_revision = "ef1c952f7150"
GET /api/sessions  release_version = "1.28.0"
```

The probe row was deleted afterwards. Existing rows still show `''` because the
MCP server process running right now was started before the launcher changed;
its next start will carry the version.

## Two mistakes worth recording

**The archive guard was wrong, not the archive.** My first rotation check was
`tar -tzf … | grep -qx 'index.js'`. It failed, I nearly concluded the publish
was broken. Extracting and testing `index.js` directly showed 532 files
including it — the guard's exact-line assumption was the fault. The corrected
guard extracts the archive and checks the two files the launcher actually needs.

**The device had two stale copies of the protocol.** `launcher.cjs` was updated
but `protocol.cjs` next to it was not, so `validateManifest` kept stripping
`version` and the launcher reported `version: null` against a manifest that had
one. Both files must be deployed together; shipping one alone produces a silent
regression rather than an error.

## Backward compatibility, verified

Before publish, with the new `protocol.cjs` already live, `/v1/current` still
served the old three-field manifest unchanged. A versionless manifest is valid,
so a device or publisher that has not been updated keeps working.

## Rollback

```bash
sudo cp -a /opt/devwf-managed/protocol.cjs.bak-20261110-010233 /opt/devwf-managed/protocol.cjs
sudo systemctl restart devwf-managed
sudo cp -a /var/lib/devwf-releases/current.json.bak-20261110-010338 /var/lib/devwf-releases/current.json
sudo cp -a /opt/devwf-monitor/session-upsert.cjs.bak-20261110-010752 /opt/devwf-monitor/session-upsert.cjs
sudo cp -a /opt/devwf-monitor/sessions-query.cjs.bak-20261110-010752 /opt/devwf-monitor/sessions-query.cjs
sudo systemctl restart devwf-monitor
```

The two new columns are additive and safe to leave in place.

## Not done

The dashboard does not yet render the version. `/opt/devwf-monitor/dashboard.cjs`
is 108 KB and is not this repository's 53 KB copy, so changing it needs its own
reconciliation pass. The data is available at `/api/sessions` per row under
`release_version`; only the display is missing.
