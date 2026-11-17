# Option scoring and confidence

This is a reasoning method for the parent and the `solution` node, not a runtime
scorer, a success predictor, or an approval mechanism. It judges whether a candidate
option is justified by the current evidence, within the authorized goal. No parser
reads these scores; no free-text semantic check enforces them.

## What T means

`T = N + D + C + E`, each dimension anchored 0–4 (or explicit `U`, below). The sum
is a decision-support index and confidence aid: it makes the comparison and its
gaps reviewable and its arithmetic reproducible. It is **not** a probability of
success, **not** objective certainty, and **not** statistically calibrated. Do not
present a score as objectively certain or statistically calibrated confidence. A
high total does not prove the option works, and a low total is not a measured
failure rate.

## Dimensions

Score the option actually proposed, not a preferred implementation. A dimension
value needs its own basis; the total cannot repair an unsupported dimension.

### N — necessity of this option

Is this specific option needed to meet the stated goal within the authorization?

| Score | Anchor |
| --- | --- |
| 0 | Not needed or contrary: the goal can be met without it, or it adds scope the user did not ask for. |
| 1 | Weakly supported: a simpler existing or standard alternative plausibly meets the goal; no evidence this option is required. |
| 2 | Comparably replaceable: it contributes to the goal, but another option would serve as well; necessity is not established. |
| 3 | Needed for a stated part: evidence ties it to a concrete behaviour or constraint; alternatives were checked but not fully eliminated. |
| 4 | Exclusively needed: within the authorization boundary, evidence eliminates the alternatives. This needs exclusivity evidence, not preference. |

A technical necessity claim cannot outrun its evidence: keep `N <= E + 1`. A user
request for "a plan" or "some solution" is evidence of the goal, not evidence that
any particular technical option is the only one; it does not by itself justify
`N = 4`. The option this round happens to choose is not `N = 4` merely because it
was chosen.

### D — goal-direction consistency

Does the option advance the user's original goal inside the authorized boundary?

| Score | Anchor |
| --- | --- |
| 0 | Wrong direction or unrequested: contradicts the goal, changes the agreed target, or crosses an authorization boundary. |
| 1 | Mostly off-target or unauthorized: only tangential to the asked outcome, or advances a goal the user did not authorize; a user decision is needed. |
| 2 | Partially aligned: helps an adjacent part, or the link to the stated goal is unclear; not enough to recommend. |
| 3 | Directly aligned: advances the stated goal within the authorization boundary without changing it. |
| 4 | Directly and completely aligned: addresses the stated goal within authorization, without widening or replacing it. |

The user's own words are direct evidence of the goal and the authorization
boundary. `D` is not lowered merely because tests have not run yet; it is lowered
when the option needs authority the user has not given. A technically strong option
that crosses that boundary is still `D <= 1`.

### C — complexity fit

Is the change proportional to the problem, and no larger than the authorization
requires?

| Score | Anchor |
| --- | --- |
| 0 | Disproportionate or inappropriate: needs new architecture, permission, or runtime beyond the problem, or is far too small to meet it; not a candidate. |
| 1 | Mismatched: materially larger or smaller than needed; simplify, split, or show with evidence that this size is unavoidable. |
| 2 | Roughly proportionate, with avoidable surface: acceptable only after trimming; not yet a recommended shape. |
| 3 | Proportionate: the smallest available surface for the goal, reusing existing conventions, with no avoidable new mechanism. |
| 4 | Minimal and clearly proportionate: no avoidable new surface; the change is as small as the goal permits and stays reviewable. |

`C <= 1` must be simplified/split, or kept only with evidence that the size is
unavoidable — and the total still does not auto-pass it. `C = U` is not
implementable.

### E — evidence sufficiency

How well is the decisive claim about N, D and C supported by claim-relevant
evidence?

| Score | Anchor |
| --- | --- |
| 0 | None or irrelevant: only assertion, preference, or this round's own plan rationale. |
| 1 | Weak or uncovered: indirect, anecdotal, or model opinion; the key claims are unsupported and the missing evidence dominates. |
| 2 | Partial: some claims are tied to a cited source, test, or observation, but a material gap remains. |
| 3 | Sufficient: each decisive claim is tied to a cited source/test/observation with relevant coverage; remaining gaps are named and not decisive. |
| 4 | Strong and independent: repeated or independent checks, a counterexample search, and prior failure/success evidence agree; no material gap. |

Source and test presence are examples, not a checklist. `E` judges relevance to the
claim and coverage of it: having source is not automatically high evidence, and not
every option must run tests before it can be scored. "This should work" is not
evidence. A test that does not exercise the claim does not raise `E`.

## Explicit unknown (U)

Mark a dimension `U` only when a concrete missing fact prevents choosing an anchor.
Record the missing fact and how to obtain it; `U` is not a vague "low confidence".

`U` contributes `0` to `T`. Its consequences are conservative:

- `N = U` or `D = U` behaves as `<= 1`: the option cannot be recommended.
- `E = U` behaves as `0`: investigate the evidence before deciding.
- `C = U` is not implementable: simplify/split or obtain the missing complexity
  evidence first.

Do not replace `U` with a guessed number to make the total look better.

## Total and initial thresholds

Evaluate the hard gates/pauses **before** the total; the total never overrides them.

- **Authorization and goal**: an option that crosses the authorization boundary or
  changes the agreed goal stops for the user's decision. Never recommend it.
- **`D <= 1`**: cannot be recommended, whatever the total or technical quality.
- **`N <= 1`**: cannot be recommended.
- **Key unknown**: any `U` keeps the option out of "recommend"; handle it per the
  `U` rules.
- **`E <= 1`**: investigate first; not a recommendation.
- **`C <= 1` or `C = U`**: simplify/split, or show the size is unavoidable; never
  auto-pass by total. `C = U` is not implementable.
- **`N <= E + 1`** for technical necessity; a high `N` with thin evidence is not
  necessity.
- **`N = 4`** needs exclusivity evidence; a user request for a plan or for "a
  change" is not that evidence.

Only after those gates:

- **Recommend**: `N >= 3, D >= 3, C >= 3, E >= 3, and T >= 12` (and no gate above
  blocks it). This is a recommendation to the decision owner, not execution approval.
  `C = 2` never satisfies this gate: trim the avoidable surface and re-score before
  recommending.
- **Conditional candidate**: `min(N, D, E) >= 2` and `T >= 9` (and no gate above
  blocks it). It can be used only for pending-evidence or decision discussion; it is
  not executable and not approved. `C = 2` may appear only here or in a
  trim-then-re-score follow-up, never as a recommendation. `E = 1` fails this
  requirement and is investigated first, not carried as a candidate.
- **Otherwise**: not recommended, with the deciding gap. Do not dress a rejected
  option as "conditional".

These thresholds are the initial policy, not runtime constants. Changing them is a
decision for the owner; do not retune them mid-task to pass a preferred option.

## Required content for each evaluated option

For every option actually evaluated, report at minimum:

- what it changes and which consumers or existing checks it affects;
- `N`, `D`, `C`, `E` with a one-line anchor basis and the gap for each;
- `T` and any `U`, plus the verdict (recommend / conditional / reject /
  investigate / needs a decision);
- the counterexample check: if the option were unnecessary or wrong, what would be
  observable, and what was checked or not checked;
- the comparison set. Consider no change, the minimal satisfaction, and a larger
  change; an infeasible category gets one line, not an invented option. Do not
  fabricate options to fill the set.
- "only" or "must" only after the alternatives are eliminated; otherwise say
  "candidate" or "leaning".

Do not repeat the whole table in the report; give the deciding anchors and gaps.

## Parent proposals and relay

The parent applies this reference to its own proposals, not only to a `solution`
child. Pass the user's original goal and authorization boundary into the child
task; do not upgrade them into a design decision.

Relay without inflation: keep a conditional candidate conditional, a suggestion a
suggestion, and a recommendation a recommendation. A suggestion or a plan is not
the user's consent, and a score is not a user decision or host approval. Re-score
only when new evidence arrives — not by switching model, role, or wording. Keep
superseded and failed evidence.

When a decision is pending, stop with the existing `acceptance.required` fact and
resume with its token. Do not add a new mandatory extension, and do not claim that
these thresholds are program-enforced.

## Lightweight path

An already authorized, pure numeric/text/value edit with no technical choice can be
one line: state that there is no technical choice, so no options are compared and
no extra `solution` pass is needed. Do not invent options for it.

This path does not cover technical, permission, dependency, script, schema, or
public-contract changes; those still need the scoring content the decision actually
requires.

## Enforcement boundary

The repository's documentation-contract test checks that this reference exists, is
linked from the solution skill, and keeps its dimension/threshold structure. It does
not verify that an Agent applies the method correctly. No runtime scorer reads these
scores, and no parser turns free text into a fake semantic verdict. Acceptance cases
in `test/tier-scenarios.md` are manual/model-assisted judgment checks.

The out-of-scope case from this conversation — a missing plugin tool escalated to
"the host must be changed" though the user authorized only method documents — is
covered as a hard direction/authorization gate there, not as a repository event.
