---
name: Remove temporary dependency override/resolution
about: Track removal of a temporary `overrides`/`resolutions` entry after the upstream fix lands
title: "chore(deps): remove override for <package-name> after upstream fix"
labels: dependencies, tech-debt
assignees: []
---

## Override to remove

**Package:** <!-- e.g. zod -->  
**Current overridden version:** <!-- e.g. ^4.0.0 -->  
**Reason it was added:** <!-- link to the PR or conflict report -->  
**Added in PR/commit:** <!-- link -->

## Upstream status

<!-- Describe the upstream issue or PR that will resolve the conflict. -->
<!-- Link to the upstream issue/PR if available. -->

- Upstream issue: 
- Upstream PR:
- Expected fix version:

## Steps to remove

1. Verify the upstream package has released the fix (`npm info <package> version`).
2. Remove the entry from `package.json#overrides` (or `resolutions`).
3. Update the direct dependency version in `package.json` if required.
4. Run `npm install` to regenerate `package-lock.json`.
5. Run `npm ci` to verify a clean install.
6. Run `npm audit --audit-level=high` — confirm 0 new findings.
7. Run `npm test` — confirm all tests pass.
8. Open a PR with the updated `package.json` + `package-lock.json` and link this issue.

## Acceptance criteria

- [ ] Override entry removed from `package.json`
- [ ] `npm ci` succeeds without `--legacy-peer-deps`
- [ ] `deps:validate` CI job passes
- [ ] Security audit passes
- [ ] All tests pass
