---
name: ux-guard
description: Uses ux-guard when users ask to set up ux-guard, audit UX, explain ux-guard results, detect UX regression from main, recommend UX improvements, or prepare a reviewed policy or baseline.
---

# ux-guard

Use the repository's installed `ux-guard` CLI as the source of truth. The skill
interprets deterministic evidence and proposes reviewable next steps; it does
not turn observations into approval.

## Find or install the local package

1. Inspect the repository's package manifest and local dependencies for
   `@edjbarron/ux-guard`.
2. Resolve and invoke the repository-local `ux-guard` executable directly.
   Keep package-runner mechanics out of the user-facing explanation.
3. When the user asks to set up ux-guard and it is absent, install
   `@edjbarron/ux-guard` as a development dependency with the repository's
   package manager.
4. For an audit-only request, do not silently install or fetch a missing
   package. Report that executable evidence is unavailable and ask before
   changing dependencies.

Never use a global installation when a local version is declared. Never claim
that ux-guard ran when the local executable could not be found or executed.

## Set up a repository

1. Run the local `setup` command in JSON mode from the repository root.
2. Explain what source and signals were inspected.
3. Group the output as:
   - good observations;
   - items needing attention;
   - unknown or missing evidence.
4. Present ordered, plain-English next steps generated from those findings:
   - include use-case catalog work only when catalog evidence is missing;
   - include pattern review only when pattern findings exist;
   - include initial-baseline work only when baseline evidence is missing;
   - include directly usable Agent Skill prompts for use-case and pattern work.
5. Mention the setup supporting file only in the policy-and-baseline review
   step. Explain that it records observed source roots, component and icon
   usage, pattern counts, and unresolved policy choices and is not approval.
6. End by stating that no policy, baseline, waiver, or enforcement was
   activated.

Setup must not create active policy, approve observed defects, adopt a baseline,
add a waiver, or enable enforcement. If supporting review work already exists,
preserve it and report the no-overwrite failure.

## Guide initial adoption

Good results require repository-owned use cases and reviewed UI conventions.
Discovery can show what exists, but it cannot decide what matters or what is
good. Keep these decisions with the human product or design owner.

When the user continues after setup:

1. Define and review the use-case catalog. Inspect product documentation,
   navigation, and existing tests, then propose the important workflows with a
   persona, goal, success outcome, starting point, priority tier, effect, and
   owner. Keep the catalog partial or unapproved until an owner confirms its
   coverage.
2. Review observed controls and patterns. Use setup findings and the supporting
   review file to show controls, props, components, icons, styling, and pattern
   debt. Ask the owner to classify each item as an approved convention,
   tolerated existing debt to record in the baseline, or a non-approved pattern
   to fix. Never infer approval from frequency.
3. Prepare comparison evidence. Use only evidence produced by the repository's
   real browser harness and configured journeys or visuals. Prepare unapproved
   pattern, journey, or visual baseline review work as applicable, explain what
   each baseline would tolerate, and stop before promotion. If evidence cannot
   execute, leave it unknown; never fabricate a replacement.
4. After explicit approval names the exact review artifacts and resulting
   files, activate only that one-time approval. Run `check` and, when journey
   reporting is configured, `report`. Explain good, needs-attention, and unknown
   results while separating enforceable policy findings from advisory findings.

Offer these directly usable onboarding prompts:

- `Help me define and review ux-guard use cases for this repo. Identify the important user workflows, personas, goals, success outcomes, starting points, priority tiers, and owners. Prepare the use-case catalog for review, but do not approve or activate it.`
- `Inspect ux-guard's setup findings and ux-guard/setup-proposal.json. Show me the observed controls, control props, components, icons, and styling patterns. Help me classify each as an approved convention, tolerated existing debt to record in the baseline, or a non-approved pattern to fix. Do not change policy or baselines.`
- `Prepare ux-guard's baseline review work for the approved use cases and UI conventions. Use only real repository evidence: the setup proposal for static patterns and the existing browser harness for configured journeys or visuals. Show what each proposed baseline would tolerate, keep every artifact unapproved, and stop before promotion.`
- `These exact ux-guard review artifacts and resulting files are approved: [list paths]. Activate only those approvals. Run ux-guard check and, if journey reporting is configured, ux-guard report. Explain the first result as good, needs attention, and unknown. Separate enforceable policy findings from advisory UX findings. Do not add waivers or change policy or baselines.`

## Audit and explain

Run `check` in JSON mode for reviewed code-policy alignment. Run `report` in
JSON mode when journey reporting is configured and the user wants UX verdicts
or recommendations.

Report:

- every audited source scope, or grouped paths without dropping any;
- policy findings separately from advisory UX findings;
- good observations, items needing attention, and unknown evidence;
- journey completion states, including failed, skipped, unexecutable, and
  infrastructure-error evidence without collapsing them;
- target attainment, regression, and numerical scores as separate meanings;
- concrete recommendations tied to evidence.

An exit code of `0` can still contain advisory UX findings. Exit `1` means an
enforceable catalog or pattern finding. Exit `2` means configuration, evidence,
or execution failed and must never be described as clean.

Never describe baseline equality or `unchanged` as good UX. It means only that
the measured state matches reviewed comparison evidence.

Offer these directly usable prompts when users want to explore those results:

- `Check my current work with ux-guard. Run the installed local check and, when configured, report. Summarize good, needs attention, and unknown evidence. Do not change policy, baselines, waivers, or enforcement.`
- `Compare this change with origin/main using ux-guard's trusted-base mode. Explain every policy finding and advisory backslide signal, including missing evidence. Do not change policy or baselines.`
- `Explain the ux-guard findings in this branch, then fix the actionable UI issues without weakening policy, adding waivers, or updating baselines just to make the result green. Explain the intended user outcome before editing production UI, and rerun the same ux-guard checks afterward.`
- `Show me where ux-guard scoring comes from and explain every score`
- `Compare this branch with origin/main and explain every backslide signal; do not change policy or baselines`

## Compare with a trusted base

For regression-from-main requests:

1. Verify that the requested base resolves to a local commit.
2. Run `check` and, when configured, `report` with that explicit trusted base.
3. State which commit supplied policy and reviewed baselines.
4. Keep missing, malformed, incompatible, shallow-clone, or unexecutable
   evidence visible as unknown or unavailable.

Do not substitute working-tree policy, targets, or baselines when a trusted
base was requested. Do not report “no regression” when comparison evidence was
unavailable.

## Prepare review work

The agent may prepare unapproved setup support, policy, journey-baseline, or
visual-baseline review work when asked. It may inspect and diff that work, but
it must stop before adoption or promotion and request explicit human approval.

Approval must name the exact review artifact and resulting files. It is one-time and
does not authorize:

- future promotions;
- waivers or exclusions;
- baseline growth;
- lowering severity or completeness;
- enabling enforcement.

Never add a waiver or baseline entry merely to make results green. Never treat
current defects as acceptable because they appear in a proposed baseline.

## Recommend or repair

Prefer recommendations that improve the user's workflow, accessibility,
consistency, feedback, and recovery. Do not alter production UI merely to pass
ux-guard. If the user asks for implementation, explain the evidence and the
intended UX outcome before changing production code, then run relevant product
tests and rerun the same ux-guard audit.

Do not weaken policy, remove evidence, skip journeys, hide findings, or replace
real workflow evidence with fabricated data.

## Final summary

Summarize:

- installed local version and audited scope;
- good, needs-attention, and unknown results;
- policy findings versus advisory findings;
- trusted base and whether comparison evidence executed;
- supporting review paths and their unapproved status;
- recommendations in priority order;
- exact validations that ran and any missing or unexecutable evidence;
- approvals still required before policy, promotion, waivers, baselines, or
  enforcement can change.
