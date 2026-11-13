# Open-Source Cutover & Collaborator Migration Plan

**Document Version:** 2.0.0 (Consolidated S3B/S3C/S4)  
**Target Cutover:** In-Place Reinitialization of `programinglive/dev-workflow-mcp-server`  
**Open-Source Baseline Tag:** `v1.31.0-oss.0`

---

## 1. Safety Guardrails & Principles

> [!CAUTION]
> **Zero Public Historical Refs:** NEVER create a `main-private-archive` or other legacy branches on the public GitHub repository. All historical refs and bundles must remain strictly OFFLINE on private workstations.
>
> **GitHub Object Pruning Reality:** Force-pushing a clean root or deleting branches does NOT instantly purge old commits from GitHub's internal object store. Objects remain cached until GitHub runs internal garbage collection or the repository is recreated.
>
> **No Automated Fleet Restarts:** Fleet workstations (`HELLOWORLD`, `Mac`, `MMCH`) must not be automatically bounced during cutover. Internal services continue running on the pinned bootstrap until explicitly migrated.

---

## 2. Cutover Sequence (Post Human Approval)

When explicit authorization is granted by the repository owner:

```bash
# 1. Verify offline durable backup bundle exists outside git tree
test -f "<PRIVATE_BACKUP_PATH>" || exit 1

# 2. Checkout the verified clean-history candidate (v1.31.0-oss.0)
git checkout clean-history-root

# 3. Force push clean root to main (OVERWRITES REMOTE ANCESTRY)
git push -f origin clean-history-root:main

# 4. Delete remote historical branches (DO NOT create public archive branches)
git push origin --delete chore/oss-cutover-s3b chore/oss-hardening-s2b feat/v131-client-convergence-validation ...

# 5. Delete remote historical tags and push clean open-source baseline tag
# (Harmonized with production v1.31.0 versioning, avoiding user confusion)
git push origin --delete v1.0.0 v1.1.0 ... v1.31.0
git tag -a v1.31.0-oss.0 -m "DevWorkflow Governance Runtime v1.31.0-oss.0 (Open-Source Baseline)"
git push origin v1.31.0-oss.0

# 6. Change GitHub repository visibility to Public in repository settings

# 7. Independent manual owner action: publish public npm package (if desired)
# npm publish --access public
```

---

## 3. Collaborator & Fleet Workstation Migration

Because the remote history was reinitialized with a new root commit, existing local clones on developer workstations (`HELLOWORLD`, `Mac`, `MMCH`) will experience `fatal: refusing to merge unrelated histories` on `git pull`.

### Migration Instruction for Collaborators:
```bash
# On each workstation:
cd /path/to/dev-workflow-mcp-server

# 1. Fetch the new remote state
git fetch origin

# 2. Reset the local main branch to match the clean remote root
git checkout main
git reset --hard origin/main

# 3. Prune old tracking branches
git remote prune origin
```

---

## 4. Disaster Recovery & Rollback Execution

If the reinitialization must be reversed for any operational reason:
```bash
# Restore entire legacy repository from the verified private bundle:
git clone "<PRIVATE_BACKUP_PATH>" dev-workflow-restored
cd dev-workflow-restored

# Force-restore original history back to origin:
git push -f origin main --tags
```
Every single commit, branch, and tag is guaranteed recoverable from the verified bundle file.
