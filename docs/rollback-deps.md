# Dependency Rollback Recipe

This document describes how to safely roll back a dependency change if CI or runtime tests fail after merging.

---

## When to roll back

- `npm ci` fails in CI after the merge.
- Unit tests that previously passed now fail in a way that can be traced to a dependency pin.
- A runtime regression is observed in a smoke/integration test.

---

## Step 1 — Identify the offending commit

```bash
git log --oneline --all | head -20
# Find the commit that changed package.json / package-lock.json
```

---

## Step 2 — Revert the PR/commit

If the change was merged as a single commit:

```bash
git revert <commit-sha> --no-edit
git push origin main
```

If the change spanned multiple commits:

```bash
# Revert the range (newest first)
git revert <newest-sha>..<oldest-sha> --no-edit
git push origin main
```

---

## Step 3 — Remove the offending override or resolution

After the revert lands, if you want to apply a partial fix (keep most changes but remove a specific override):

1. Open `package.json`.
2. Remove the offending entry from `"overrides"`.
3. Optionally downgrade the direct dependency if needed.

```bash
# Re-run the install
npm install
# Verify the lockfile is correct
npm ci
# Run the audit
npm audit --audit-level=high
# Run the tests
npm test
```

4. Commit both `package.json` and `package-lock.json` together.

---

## Step 4 — Open a follow-up issue

Use the **"Remove temporary dependency override"** issue template (`.github/ISSUE_TEMPLATE/remove-dependency-override.md`) to track the upstream fix and schedule a clean removal later.

---

## Validation steps (always run before re-applying a fix)

```bash
# 1. Clean install from lockfile — must succeed
npm ci

# 2. No lockfile drift
git status --porcelain  # should be empty

# 3. No new high/critical vulnerabilities
npm audit --audit-level=high

# 4. All tests pass
npm test
```

---

## References

- [npm overrides documentation](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides)
- [Conflict report](../reports/dependency-conflicts.md)
- [Audit report](../reports/npm-audit-before-after.md)
