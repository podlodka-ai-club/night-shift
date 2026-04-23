## Description

<!-- Describe what this PR changes and why. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Dependency update
- [ ] CI / tooling change
- [ ] Documentation

---

## Dependency changes checklist

> Complete this section only for PRs that modify `package.json`, `package-lock.json`, or other manifests/lockfiles.

- [ ] **Conflict report attached** — `reports/dependency-conflicts.md` is up to date or linked below.
- [ ] **`npm ci` passes** — verified locally that `npm ci` completes without errors.
- [ ] **`deps:validate` CI job passes** — no lockfile drift detected.
- [ ] **Security audit passes** — `npm audit --audit-level=high` reports 0 new high/critical findings.
- [ ] **Lockfile committed** — `package-lock.json` updated atomically with any `overrides`/manifest change.
- [ ] **Override rationale** — each `overrides` entry has its rationale documented in the commit message or PR body (JSON does not support inline comments).
- [ ] **Tests pass** — unit test suite green on this branch.

---

## Checklist

- [ ] At least one reviewer assigned
- [ ] `deps:validate` job ✅
- [ ] Security audit job ✅
- [ ] Test suite ✅
