# Use-case review design

This records the design of `ux-guard review`: what it decides, what it
refuses to change, and the limits accepted for the first version. The user
workflow, draft fields, and commands are in
[use-case review](use-case-review.md).

## Goal

Give a person a local way to turn an assessment of a repository into a
reviewed use-case catalog. ux-guard validates the assessment, keeps unknowns
visible, and shows the exact catalog diff. It does not invent use cases, and
it does not treat a saved review as approval to change active policy.

Analysis stays deterministic. TypeScript parsing and the reviewed catalog
rules decide structure. No model is called. The optional agent explains the
proposals in plain language and stops before adoption, check-in, and
enforcement.

## Compatibility

This is an added command. `setup`, `check`, `report`, and the policy
lifecycle commands are unchanged. Catalog, baseline, target, waiver, and
configuration version numbers are unchanged. Catalog validation now treats
entry points as optional implementation bindings and `owner` as accepted
legacy metadata rather than definition validity. There is no new runtime
dependency. TypeScript remains the only one.

Files appear only when someone prepares a candidate, saves a review, or runs
`review adopt`. The active catalog changes only when `review adopt` is run
with the reviewer, a UTC time, a rationale, and, when a catalog already
exists, the current file hash.

The tool version stays `0.6.0` until a release. The change is listed under
Unreleased.

## Four artifacts

| Artifact | Default path | Who writes it | What it is |
| --- | --- | --- | --- |
| Draft | `ux-guard/use-case-draft.json` | A person or an agent | The assessment. It must not carry repository identity or hashes. |
| Candidate | `ux-guard/use-case-candidate.json` | `review prepare` | The validated draft plus identity computed by ux-guard. Always unapproved. Never overwritten. |
| Review | `ux-guard/use-case-review.json` | Save in the app | Decisions about proposals and mappings. Always unapproved. Revisioned. |
| Preview | `ux-guard/use-case-catalog.preview.yml` | Save in the app | The catalog that those decisions would produce, marked generated and unapproved. |

The active catalog stays a separate file. Only `review adopt` writes it.

A file that claims `approval.status` is `approved`, or that
`activatesCatalog` is true, is rejected. Approval of the catalog is the
`review adopt` command, not a field an agent can set.

## Two meanings of approve

In the app, **Approve as proposed** is a decision about one use case. Save
writes that decision into the review file. Reopening the app shows it again.
The review file itself remains `unapproved`, so saving does not activate the
catalog.

**Owner approval** is `ux-guard review adopt` in a terminal. That command
writes the catalog. Its receipt — reviewer, time, rationale, and catalog
hash — is printed to the terminal, and as JSON with `--format json`. It is
not written into the catalog or into its own file. Keep the output in the
commit message or pull request when a durable record is needed.

Adoption, check-in, and enforcement remain separate decisions. Adoption keeps
the existing catalog `inventory` value, or uses `partial` for a new catalog,
so enforcement does not change. Configuration, baselines, targets, and
waivers are not modified.

## Decision model

Proposals are grouped by the user outcome they serve. Each proposal can be
left undecided, approved as written, approved with field revisions, rejected,
merged into an accepted use case, or split into parts. Definition fields are
editable while the proposal stays undecided. Those edits are a draft revision:
they can be saved, reset, or explicitly approved later and never imply
acceptance by themselves. The reviewer can also add a use case the assessment
missed.

A surface or workflow is mapped to one or more use cases, excluded with its
own rationale, or left unresolved. An exclusion does not inherit the
assessment's reason for mapping that item. Without a rationale it stays
unresolved.

Rejecting or splitting a proposal leaves anything mapped to it unresolved
until it is remapped. A merge contributes the proposal's entry points,
requirements, and gaps to an accepted target. A mapped navigation surface
becomes a `starts` binding on its use cases, including use cases already in the
active catalog.

A use case enters the generated catalog when it has an id and title, persona,
goal, success outcome, tier, and effect. Tier and effect remain required
because existing generic policy uses them to classify reviewed scope. `starts`
is optional: missing entry points produce a nonblocking unknown implementation
coverage warning, never omission. `owner` is not required and is not shown in
the form. Legacy owner metadata is accepted and preserved in existing
catalogs and candidates so opening or adopting a review does not perform a
destructive migration. Approval provenance is recorded by `review adopt`.
Generated entries pass the same catalog validation as `ux-guard check`.

Completeness is computed from those same definition requirements for every
decision surface. An incomplete source cannot be approved as proposed. Revised
approval requires at least one changed field and a complete effective
definition. The server rejects stale clients or hand-authored review payloads
that attempt either invalid action. Editing an already accepted revision
returns it to undecided so a new edit cannot inherit an earlier approval.
Approving the original after drafting requires an explicit discard choice.

Merge selection is intentionally two-phase. Opening merge changes no decision.
A searchable picker shows existing entries and complete proposals, but only
accepted targets can complete the merge. Self, rejected, merged, split, and
incomplete targets are excluded. The preview states which surface/workflow
mappings, manual and derived entry points, requirements, and gaps move, which
duplicates collapse, and whether navigation bindings conflict. The engine's
one-hop resolution and broken-target checks remain authoritative.

Coverage totals count discovered, mapped, awaiting decision, excluded, and
unresolved items. Unresolved items and exclusions without a rationale are
never reported as covered. Open questions from the assessment stay visible.

## Identity and staleness

`review prepare` stamps the candidate with the repository's root commits, the
current commit, and a SHA-256 of every navigation file and source the
assessment named. An agent cannot supply those values. A draft that contains
them is rejected.

The review stores the candidate's SHA-256. Decisions saved against a
different candidate are refused rather than applied to a new assessment.

If an assessed file changes, disappears, or the repository's root commits
differ, the candidate is stale. The app still opens and can save, and
adoption is blocked until a fresh candidate is prepared. New commits that
leave every assessed file unchanged are reported and do not block. Without
Git history, identity is unverified; assessed file hashes are still checked.

Navigation surfaces found in source but missing from the draft are listed at
prepare time and appear as unresolved subjects.

## Adoption guards

`review adopt` writes the catalog only when all of these hold:

- the review has been saved;
- the saved preview matches the catalog the saved decisions generate;
- the candidate is not stale;
- no blocking issue remains;
- reviewer, UTC time, and rationale are single-line values;
- an existing catalog is replaced only when `--replace-catalog-sha256` equals
  the hash of the file about to be replaced.

The catalog path comes from `.uxguard.json`. Before configuration exists,
`--catalog` chooses the path. That path cannot be the configuration file, the
candidate, the review, or the preview.

Writes stay inside the repository. Paths cannot traverse out, follow a
symbolic link, or name active configuration, navigation sources, baselines,
journey policy, or visual policy. New files are created atomically and are
not overwritten. Replacing the review or the catalog succeeds only when the
expected hash is still current, so a concurrent save is reported instead of
lost. A preview that ux-guard did not generate is not overwritten.

## Local app

The server binds to `127.0.0.1` on a free port and serves only its bundled
page, script, and stylesheet. The session token is in the printed URL
fragment. The page stores it for the tab and removes it from the address
bar. API requests must carry that token, a loopback `Host` header, and a
same-origin JSON body within the size limit. Responses set a restrictive
content security policy and forbid framing, caching, and content sniffing.
There is no telemetry and no external asset.

The page is a view. Decision rules, validation, coverage totals, and the diff
run in the ux-guard process. Evaluation writes nothing. Save writes the
review and the preview. Dirty state is prominent, browser unload and Close
warn before discarding edits, and a successful save shows the revision, UTC
timestamp, path, and unapproved status while briefly changing the button to
`Saved ✓`. Close, or Ctrl+C, stops the server. The browser is not opened when
`--no-open` is set or `CI` is set.

Without a candidate, `review` explains what is missing, prints the agent
prompt, and writes nothing. An explicit `--candidate` path that does not
exist is an error.

The app uses native controls, a skip link, landmarks, the tab keyboard
pattern, arrow keys in lists, visible focus, a polite status region, and an
alert region. Status is also written in text, not only in color. It follows
the system dark-mode and reduced-motion preferences.

## Accepted limits

- **Catalog rewrite.** Adoption emits the whole catalog. Comments are not
  kept, and quoting or wrapping can change. The preview diff shows every
  changed line, and the app warns that comments are dropped.
- **Existing entries.** A use case already in the catalog can gain `starts`
  from a mapped surface. Its other fields, including legacy `owner` metadata,
  are preserved and are not edited in the app.
- **Approval receipt.** The adopt receipt is printed, not stored as a file.
- **Working files.** The draft, candidate, review, and preview are ordinary
  repository files. They are written only by prepare or save. Leaving them
  untracked is safe. The catalog is the file adoption changes.
- **Diff details.** A line-ending-only change is not shown. The exact-hash
  replacement has a small window between the hash check and the write.
- **Browser checks in CI.** The package tests keyboard and labelling behavior
  with a small in-process document. A real browser pass is run locally and is
  not a package dependency.
