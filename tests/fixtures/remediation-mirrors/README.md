# Remediation-plan mirror fixtures

Frozen copies of `data/posts/<slug>/content.html` as they stood when the
health-claim remediation plans (`scripts/remediate-tea-tree-11-benefits-post.js`,
`scripts/remediate-ingredient-benefit-headings.js`) were written and applied.

The plan tests used to read the live mirrors. Those files track the LIVE article,
and both articles were later rewritten, so the plans' byte-pinned BEFORE/AFTER
strings could never match again (2026-11-01). The plan-logic tests now run
against these fixtures. The live-safety property, that no claim a plan removed
has come back, is asserted against the real mirrors in
`tests/lib/content-reconcile.test.js`.

Do not update these files to match the site. They are the input the plans were
written for.
