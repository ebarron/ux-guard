# Use-case review

`ux-guard review` opens a local app for deciding which user workflows the
repository's use-case catalog should cover. The app helps people review an
assessment; it does not approve, adopt, check in, or enforce anything.

```sh
npx ux-guard review
```

Or ask your agent:

> Help me discover and review the important use cases in this repository. Open
> ux-guard’s local review experience, explain the proposals in plain language,
> and do not activate policy without my explicit approval.

Other prompts the bundled skill understands:

> Continue my ux-guard use-case review.

> Open the ux-guard review app for this repository.

> Help me resolve the remaining unmapped workflows and exclusions. Do not
> approve or activate anything.

## Workflow

1. **Assess.** An agent or a person writes an assessment draft to
   `ux-guard/use-case-draft.json`: the navigation surfaces and workflows
   found in the repository, proposed use cases grouped by user outcome, and a
   proposed mapping or exclusion for each surface and workflow. ux-guard does
   not guess these.
2. **Prepare.** `ux-guard review prepare` validates the draft and writes an
   unapproved candidate to `ux-guard/use-case-candidate.json`, stamped with the
   repository's root commits, the current commit, and a SHA-256 of every
   assessed file. Navigation surfaces found in source but missing from the
   draft are listed and later appear as unresolved.
3. **Review.** `ux-guard review` starts the local app. In it, people:
   - approve, revise, reject, merge, or split each proposal, and add missed
     use cases;
   - map each surface and workflow to use cases, or exclude it with a
     rationale;
   - edit persona, tier, effect, success outcome, rationale, and starts;
   - see unresolved decisions, validation problems, and coverage totals;
   - preview the exact catalog diff.
4. **Save.** Saving writes the decisions to `ux-guard/use-case-review.json` and
   the generated catalog to `ux-guard/use-case-catalog.preview.yml`. Both are
   unapproved. Saving can be repeated; reopening the app resumes from the saved
   decisions.
5. **Adopt, separately.** Only after explicit owner approval, the owner runs
   `ux-guard review adopt` in a terminal. The app shows the command but never
   runs it.
6. **Check in and enforce, separately.** Adoption writes only the catalog.
   Checking it in, changing inventory or enforcement, and adopting baselines
   or waivers remain separate decisions.

## Commands

| Command | Writes |
| --- | --- |
| `ux-guard review` | Nothing until **Save review**; then the review and preview only |
| `ux-guard review --format json` | Nothing; reports status without starting the app |
| `ux-guard review prepare` | The candidate only, never overwriting |
| `ux-guard review adopt` | The active catalog only, after every check passes |

Options:

- `--candidate`, `--review`, `--preview`, and `--draft` select other
  repository-relative paths. They cannot name active configuration, the
  catalog, navigation sources, baselines, journey policy, or visual policy.
- `--port <number>` selects the loopback port; the default is any free port.
- `--no-open` prints the address without opening a browser. The browser is
  also not opened when `CI` is set.

Without a candidate, `ux-guard review` explains what is missing, prints the
agent prompt above, and writes nothing. An explicit `--candidate` path that
does not exist is an error.

### Adoption

```sh
npx ux-guard review adopt \
  --reviewer <owner> \
  --reviewed-at 2026-01-31T12:00:00Z \
  --rationale "Reviewed with design and engineering." \
  --replace-catalog-sha256 <current catalog sha256>
```

Adoption refuses unless:

- the review is saved, and the saved preview exactly matches what the saved
  decisions generate;
- the candidate is not stale;
- no blocking issues remain;
- the reviewer, a UTC review time, and a rationale are recorded;
- an existing catalog is replaced only with `--replace-catalog-sha256` equal to
  its current hash. The app and `review --format json` show the exact command,
  including the hash.

The catalog path comes from `.uxguard.json`. Before configuration exists, pass
`--catalog <path>`. Adoption keeps the existing catalog's `inventory` value, or
uses `partial` for a new catalog, so enforcement does not change. Unresolved
items are reported as unresolved, never as covered. The printed adoption
record names the approval; keep it with the change for review.

## Draft format

The draft is JSON. Unknown fields are rejected, so mistakes are reported
instead of ignored.

```json
{
  "kind": "ux-guard-use-case-draft",
  "version": 1,
  "approval": { "status": "unapproved", "activatesCatalog": false },
  "source": { "catalog": "ux/use-cases.yml", "navigation": ["src/nav.tsx"] },
  "outcomes": [{ "id": "manage-records", "title": "Manage records" }],
  "proposals": [
    {
      "id": "export-records",
      "outcome": "manage-records",
      "title": "Export records",
      "persona": "Analyst",
      "tier": "tertiary",
      "effect": "read",
      "owner": "product-owner",
      "goal": "Export the record list.",
      "success": "A file with the visible records downloads.",
      "rationale": "Export is offered from the record list.",
      "starts": [{ "nav_id": "records", "route": "/records/export" }],
      "capability": "present"
    }
  ],
  "surfaces": [
    {
      "id": "records",
      "label": "Records",
      "route": "/records",
      "sources": ["src/nav.tsx"],
      "classification": {
        "disposition": "proposed-use-case",
        "useCaseIds": ["export-records"],
        "rationale": "Top-level destination."
      }
    }
  ],
  "workflows": [
    {
      "id": "debug-panel",
      "title": "Developer debug panel",
      "sources": ["src/Debug.tsx"],
      "capability": "not-applicable",
      "classification": { "disposition": "excluded", "rationale": "Developer-only diagnostics." }
    }
  ],
  "questions": [{ "id": "export-scope", "question": "Is export in scope?", "impact": "Changes the tier list." }]
}
```

Fields:

- `source.catalog` is the catalog the assessment targets; `source.navigation`
  lists the navigation sources it read. The draft must not contain
  `repository`, `commit`, or `inputs`; `prepare` computes them.
- `outcomes` group proposals by the user outcome they serve.
- A proposal needs `id` (lowercase words separated by hyphens) and `title`.
  `persona`, `tier` (`primary`, `secondary`, `tertiary`), `effect` (`read`,
  `create`, `change`), `owner`, `goal`, `success`, and at least one `starts`
  entry are required before it can enter the catalog; missing fields stay
  visible as reasons. `starts` entries are `{ "nav_id", "route" }` or
  `{ "entry": "assistant", "prompt" }`. `requirements`, `gaps`, `rationale`,
  and `capability` (`present`, `partial`, `absent`, `deployment-dependent`,
  `not-applicable`, `unknown`) are optional.
- A surface needs `id`, `label`, and `classification`; `route`, `kind`
  (`destination`, `group`, `subtree`, `hidden`, `other`), and `sources` are
  optional. A workflow needs `id`, `title`, and `classification`; `entry`,
  `capability`, and `sources` are optional.
- `classification.disposition` is `existing-use-case`, `proposed-use-case`,
  `excluded`, or `unresolved`. Use `unresolved` when ownership or scope is
  unclear; ux-guard keeps it visible rather than counting it as covered.
- `sources` and `navigation` are repository-relative files. Each is hashed by
  `prepare` so later edits mark the candidate stale.

## What the app shows

- **Summary**: discovered, mapped, awaiting decision, excluded, and unresolved
  totals; proposal progress; every unresolved decision with a link to it;
  blocking issues and warnings; open questions from the assessment.
- **Use cases**: proposals grouped by outcome with search and decision
  filters, a decision form, editable catalog fields, merge and split controls,
  and the source surfaces and workflows beside the resulting catalog entry.
- **Surfaces and workflows**: each item with its route, sources, and the
  assessment's proposal; map it to use cases, exclude it with a required
  rationale, or leave it unresolved.
- **Catalog preview**: the exact unified diff against the active catalog, the
  full generated catalog, entries that cannot be included yet and why, and the
  adoption steps.

A mapped surface becomes a `starts` entry of its use cases, including use
cases already in the active catalog. A merged proposal contributes its starts,
requirements, and gaps to its target. Rejecting or splitting a proposal leaves
anything mapped to it unresolved until it is remapped. An exclusion without a
rationale counts as unresolved.

## Safety model

- **Distinct artifacts.** The candidate, the review decisions, the preview,
  and the active catalog are separate files. Only `review adopt` writes the
  active catalog. The candidate and review always record
  `"status": "unapproved"`, and a file claiming approval is rejected.
- **Stale detection.** The review records the candidate's SHA-256, so a review
  saved against another candidate is refused rather than reapplied. If an
  assessed file changes, disappears, or the repository's root commits differ,
  the candidate is stale: the app keeps working, but adoption is blocked until
  a fresh candidate is prepared. New commits that leave every assessed file
  unchanged are reported but do not block.
- **Writes.** All paths are repository-relative and refuse traversal, symbolic
  links, and policy destinations. New files are created atomically without
  overwriting. A save replaces the review only when its revision and hash
  still match, so a concurrent save is reported instead of lost; a preview
  that ux-guard did not generate is never overwritten.
- **Trusted policy.** The candidate can propose catalog entries only. It
  cannot change configuration, inventory, baselines, targets, waivers, or
  enforcement, and generated entries pass the same catalog validation as
  `ux-guard check`. Comments in an existing catalog are not preserved by
  adoption; the diff shows every removed line.
- **Local only.** The server binds to `127.0.0.1` on an ephemeral port and
  serves only its bundled page, script, and stylesheet. Every API request
  needs the per-session token from the printed link, a loopback `Host`
  header, and a same-origin JSON request. Responses forbid framing, caching,
  sniffing, and external resources. There is no telemetry and no external
  asset. Choose **Close review** or press Ctrl+C to stop the server.

Design decisions, schema boundaries, and accepted limits are recorded in
[use-case review design](use-case-review-design.md).

## Accessibility

The app uses native controls with visible labels, a skip link, landmark
regions, the tab pattern with arrow, Home, and End keys, arrow-key navigation
in lists, visible focus, a polite status region for every change and save, an
alert region for errors, and text labels on every status color. It follows the
system dark-mode and reduced-motion preferences. Ctrl+S or Cmd+S saves.
