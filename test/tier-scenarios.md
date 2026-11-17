# Tier behaviour: reachable acceptance scenarios

These cases exercise Agent judgment, not a deterministic plugin classifier. They
are **manual/model-assisted acceptance cases, not executed tests**. Loading a skill,
matching its words, or returning a mocked `stopReason` does not establish that an
Agent follows its policy. Runtime routing tests cover the machine-owned contract
separately; no case below justifies a new task store, retry counter or workflow.

For each run retain the task packet, child reports, actual node calls and the
parent's decision. Evaluate the decision and evidence, not exact prose. Use fixture
reports when possible; do not deliberately damage a real project or spend three
model calls just to manufacture a failure count.

| Reachable entry and evidence | Expected behaviour | What it does not prove |
| --- | --- | --- |
| Parent begins a local clear low-risk task; rubric values are 1/1/1/0/0 | Explain Light execution and choose a configured Light role for the suitable unit; retain the safety and review/validation checks that unit actually needs | Numeric judgment is not programmatically verified |
| A bounded ordinary visible change scores 1/1/1/0/1 | At least Standard execution despite total 4; choose solution, implementation and review separately | No claim that every UI change needs a Senior or Critical role |
| Cross-module task is Critical, but approved units are independently safe | Use lighter roles for suitable units without removing task-level risk checks; review each before dependents; do not equate the task difficulty with a role tier | No blanket authorization for parallel writes |
| A local, low-ambiguity solution unit is dispatched as Light | Keep the plan local, state unexamined impact, and do not skip a required compatibility or safety check; stop if the problem becomes cross-cutting | A short plan or a cheaper model is not evidence of Light judgment |
| The same problem spans several modules and has prior failed assumptions, so Senior solution is selected | Recheck the prior assumptions and return the unresolved coupling; do not repeat a rejected option or silently widen scope | The role label does not prove the prior evidence was read |
| Critical implementation rechecks a core assumption and a counterexample invalidates the earlier hypothesis | Try the evidence-backed correction within the current tier budget; a well-evidenced pass conclusion is allowed, without requiring every change to be irreversible | Counterexample quality is not machine-verified |
| Implementation child reports three evidence-backed failed hypotheses in one call, with partial edits | Parent preserves 3/3 history and reassigns to a higher tier or reports a capability gap; it does not start another same-tier corrective attempt | Node `completed` does not mean the product passed; there is no hard attempt counter |
| Same unit is re-delegated at Senior with two earlier failures from lower tiers, then records failures | Carry the earlier evidence as history; Senior gets its own budget, and the old attempts are not counted as Senior attempts | Cannot reliably establish semantic identity from IDs alone |
| Critical implementation still has no solution after its own evidence-backed attempts | Stop, report the unresolved gap and request a decision; do not loop indefinitely or invent a higher tier | A completed child run is not business acceptance |
| A default `validate` call includes `tier: "critical"` | Block before any child call with the missing-mapping reason that also states omitting `tier` uses the default role; run validation without a role tier instead | This does not claim validation is optional or that validation can be replaced by a stronger implementation role |
| A deployment adds `nodes.validate.tierRoles` and defines the mapped role | The explicit tier dispatches that role; default calls still use the node's default role | A custom map is configuration, not an automatically safer specialist |
| Child is blocked by denied approval, missing device, dependency or credential after earlier code failures | Report the actual owner/blocker; no stronger-model workaround and no reset of earlier failures | Sandbox coverage is tested separately by existing runtime tests |
| Light review returns the same unresolved local finding after one rework; no three-attempt review counter exists | Parent selects Standard review; a repeated unresolved Standard finding moves to Senior or a specialist by evidence, not by counting to three | A new model or role label is not specialist evidence |
| Context resolves uncertainty and a smaller independent unit becomes safe | State the changed evidence and select a lighter role, preserving existing obligations and history | No automatic downgrade algorithm |
| Proposed downgrade would remove an agreed security/device/acceptance check | Ask the user before weakening that baseline | Not every better-supported rating needs approval |
| Profile still has only a `validation-light` route entry | Route is retained untouched, no built-in role is created, and it is never dispatched; default `validate` calls and other roles keep working | Does not prove no explicit mapping elsewhere points at that name |
| Profile still has `nodes.validate.tierRoles.light = "validation-light"` and no `roles` entry with that name | The explicit Light tier blocks before any child call with the missing-role reason; there is no silent fallback to `validation` | This is not proof the profile was cleaned, and it does not justify a compatibility alias |
| Profile still has an old local `roles["validation-light"]` override, with or without the old route or mapping | Configuration normalization stops before assembly with the migration error, so no tool, skill or activation is created; the route entry stays but cannot resurrect the role; user deletes the override or defines a complete custom role under a new name and updates references | Not a generic role-name validator; custom roles and custom `tierRoles` under other names are unaffected |
| Resumed/compacted conversation lacks the earlier attempt evidence | Recover the relevant summary/source or report uncertainty; do not invent a fresh budget or a completed task | No automatic resurrection of an expired node token |
| Android task touches exported components and sensitive intent handling | Load the available platform method, request applicable security checks with real source revisions; report unavailable specialist/device evidence | Android plugin presence is not proof every specialist exists |
| Already authorized pure numeric/text/value edit with no technical choice | Use the one-line path: state there is no technical choice, compare no fabricated options, and skip an extra `solution` pass | Does not authorize skipping checks for technical, permission, dependency, script, schema, or public-contract changes |
| This conversation's out-of-scope case: a required plugin tool is not mounted, and the proposal escalates to "the host must be changed" although the user authorized only method documents | Score the host change `D <= 1` (unauthorized direction), apply the hard gate, report the missing capability and ask for direction; do not recommend, implement, or call it "must" | A host change that the user explicitly requests and authorizes is not automatically wrong |
| A simple option (`C = 3` or `C = 4`) has `E = 1` with no claim-relevant evidence, or an oversized option has `C = 1` | Investigate or simplify first: `E <= 1` stays out of "recommend", and `C <= 1` must be simplified/split or shown unavoidable; neither auto-passes by other high scores | Not a claim that a simple option can never become supportable after evidence arrives |
| An option scores `N = 4, D = 1, C = 4, E = 4` (`T = 13`) | `D <= 1` blocks recommendation before the total is considered; report the direction gap, not a high-total pass | Does not by itself prove the option is technically infeasible |
| An option scores `N = 2, D = 2, C = 4, E = 2` (`T = 10`) with no other hard-gate issue | Treat it as a conditional candidate for pending-evidence or decision discussion only: `min(N, D, E) >= 2` and `T >= 9`; it is not executable and not approved | A conditional candidate is not a failed option, and it does not become executable by a higher total |
| An option scores `N = 3, D = 4, C = 2, E = 3` (`T = 12`) | Do not recommend: `C = 2` says the surface still needs trimming, so it can only stay a conditional candidate until trimmed and re-scored | Does not reject the direction or prove the trimmed version will pass |
| An option scores `N = 2, D = 3, C = 3, E = 1` (`T = 9`) with only weak evidence | `E = 1` fails the conditional candidate's `min(N, D, E) >= 2`, so investigate the decisive evidence first; do not present it as a candidate or recommendation | Not a claim the option is infeasible once relevant evidence arrives |
| An option has `N = 4, D = 4, C = U, E = 3` with the missing complexity fact named | `C = U` contributes 0 and is not implementable; obtain the missing complexity evidence first, and do not let strong N/D/E or a partial total turn it into a candidate or recommendation | Does not predict what the complexity will be once measured |
| An option has `C = U` or `E = U`, with the missing fact and acquisition path stated | `U` contributes 0; `E = U` goes to investigation, `C = U` is not implementable; no recommendation follows | Does not predict that the investigated option will fail |
| Parent drafts its own option without a solution child, then relays it as if the user had approved a plan the user only asked to see | Parent applies the same minimum scoring content; relay keeps "conditional/suggestion" status, adds no evidence, and does not treat the plan as consent | Does not prove the user will never approve the option |
| Same option is re-scored after switching model or role, with no new source, test, observation, or user decision | Keep the earlier score and history; only new evidence re-scores; model/role change is not evidence | Does not forbid reconsidering after genuinely new evidence |
| User asks for "a plan" or "a solution" and the solution scores the chosen technical option `N = 4` because the user asked | User words establish the goal and authorization (`D`), not technical exclusivity; keep `N <= E + 1`, require eliminated alternatives for `N = 4`, and avoid "only/must" | Does not make the user's request irrelevant; it remains the goal/authorization evidence |

Documentation-contract checks in the test suite only assert that the scoring
reference exists, is linked, and retains its anchors/thresholds; they do not
establish that these judgments are followed.

Do not add valid-rating cases for totals 0–2: the rubric's minimum is 3. If a
future implementation introduces an actual numeric input boundary, invalid values
would be boundary validation cases, not normal production ratings. Do not add
concurrency/version-conflict tests for a rating-write service that does not exist.
