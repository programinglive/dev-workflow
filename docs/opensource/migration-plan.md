# Open-Source Cutover & Collaborator Migration Plan

**Document Version:** 1.0.0  
**Target Cutover:** In-Place Reinitialization of `programinglive/dev-workflow-mcp-server`  

---

## 1. Cutover Sequence (Post Human Approval)

When explicit authorization is granted by the repository owner:

```bash
# 1. Ensure private backup is safe
test -f "D:/code/dev-workflow-private-backup-20261112.bundle" || exit 1

# 2. Checkout the verified clean orphan branch
git checkout public-release-root

# 3. Force push clean root to main (OVERWRITES REMOTE ANCESTRY)
git push -f origin public-release-root:main

# 4. Delete remote historical branches
git push origin --delete chore/migrate-runner-mmch-to-bwtools docs/mmch-runner-removed feat/cli-first-architecture-support ...

# 5. Delete remote historical tags and push clean tag
git push origin --delete v1.0.0 v1.1.0 ... v1.30.0
git tag -a v1.0.0-oss -m "DevWorkflow Governance Runtime v1.0.0-oss (Initial Open-Source Release)"
git push origin v1.0.0-oss

# 6. Change GitHub repository visibility to Public in repository settings
```

---

## 2. Collaborator & Fleet Workstation Migration

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

## 3. Disaster Recovery & Rollback Execution

If the reinitialization must be reversed for any operational reason:
```bash
# Restore entire legacy repository from the verified private bundle:
git clone "D:/code/dev-workflow-private-backup-20261112.bundle" dev-workflow-restored
cd dev-workflow-restored

# Force-restore original history back to origin:
git push -f origin main --tags
```
Every single commit, branch, and tag is guaranteed recoverable from the verified bundle file.
