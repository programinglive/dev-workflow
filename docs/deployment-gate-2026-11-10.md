# Deployment gate: production only through CI/CD

Date: 2026-11-10

## What went wrong

A voucher fix was copied straight onto `timelessbintaro` with
`gcloud compute scp` and a shell script. Production then ran files that no tag
contains. The MCP had no record of it, because `released` only ever meant "a
release command ran" — it says nothing about what is live.

The guard already existed: `infra-knowledge`'s `ssh_vm` refuses `cp`, `mv`,
`sed -i`, `patch`, `tee` and redirection into `/var/www`, `/releases/` and
`/current/`. It was bypassed by using `gcloud compute scp` outside the MCP.

## The rule

1. Code reaches production only through a protected stable tag (`vX.Y.Z`).
2. The tag is created by the release script (`npm run release:patch`) and pushed
   with `git push --follow-tags`.
3. GitLab CI runs `clinic_tag_release`: staging, then quality, then production,
   with a health receipt per site.
4. The tag that actually shipped is recorded with `record_deployment`.
5. A task on a Clinic repository cannot be closed until that record exists, or
   `skip_release` is used with a written reason.

## What the MCP now enforces

### `record_deployment` (dev-workflow)

Input: `tag`, `pipelineId`, `sites`, `evidence`, optional `projectDir`.

It refuses when:

- the tag is not a stable `vX.Y.Z`;
- the tag does not exist in the repository;
- HEAD is not an ancestor of the tag — meaning this session's work is not in the
  release.

On success it stores `deployment = { tag, tagSha, headSha, pipelineId, sites,
evidence, recordedAt }` in the workflow state.

### `complete_task` deployment gate (dev-workflow)

For a project that has `scripts/ops/clinic-gitlab-release.cjs`, `complete_task`
refuses while `deployment` is empty. The message names the correct sequence and
says the task is still open. `skip_release` with a reason is the only escape
hatch, and it is recorded.

The gate is scoped to the Clinic release runner on purpose. A generic `release`
script is not enough: the MCP's own repository has one, and gating on that would
block unrelated projects.

### `release_drift` (infra-knowledge)

Read-only. Given a `domain` and an optional `tag`, it reads the live release on
`bw-app` and reports:

- the release directory and deployed version;
- whether the version matches the tag;
- files under `app/`, `resources/` and `database/migrations/` that are newer than
  the release directory itself — those were copied after the release, not by the
  pipeline.

`clean` is false when either the version differs or any file is newer.

## Parallel sessions

Two AI sessions can work the same Clinic repository. A tag cut from `master`
includes every commit on `master`, so work that is pushed is not lost. The risk
is a tag cut from a branch that does not contain those commits, or a re-deploy of
an older tag. `record_deployment` catches the first case: it refuses a tag that
does not contain HEAD.

## Rollback

The MCP changes are additive: a new tool, a new state field, and a gate that only
applies to the Clinic release runner. Reverting the commit restores the previous
behaviour; no data migration is involved.
