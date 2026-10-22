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
| Parent begins a local clear low-risk task; rubric values are 1/1/1/0/0 | Explain Light execution and choose a configured Light implementation role; retain needed review/validation | Numeric judgment is not programmatically verified |
| A bounded ordinary visible change scores 1/1/1/0/1 | At least Standard execution despite total 4; review/validation selected separately | No claim that every UI change needs a Senior role |
| Cross-module task is Critical, but approved units are independently safe | Use lighter roles for suitable units without removing task-level risk checks; review each before dependents | No blanket authorization for parallel writes |
| Implementation child reports three evidence-backed failed hypotheses in one call, with partial edits | Parent preserves 3/3 history and reassigns upward or reports a capability gap; does not start another same-tier corrective attempt | Node `completed` does not mean the product passed; there is no hard attempt counter |
| Same unit is re-delegated with two earlier failures, then reports a third | Carry earlier evidence rather than resetting by a new call or unit nickname | Cannot reliably establish semantic identity from IDs alone |
| Child is blocked by denied approval, missing device or dependency after earlier code failures | Report the actual owner/blocker; no stronger-model workaround and no reset of earlier failures | Sandbox coverage is tested separately by existing runtime tests |
| Light review returns the same unresolved finding after one rework; Standard validation repeats the same failure cause | Parent selects appropriate higher review/validation or a real specialist; absent mapping is a gap, not hidden fallback | A new model or role label is not specialist evidence |
| Context resolves uncertainty and a smaller independent unit becomes safe | State the changed evidence and select a lighter role, preserving existing obligations and history | No automatic downgrade algorithm |
| Proposed downgrade would remove an agreed security/device/acceptance check | Ask the user before weakening that baseline | Not every better-supported rating needs approval |
| Android task touches exported components and sensitive intent handling | Load the available platform method, request applicable security checks with real source revisions; report unavailable specialist/device evidence | Android plugin presence is not proof every specialist exists |
| Resumed/compacted conversation lacks the earlier attempt evidence | Recover the relevant summary/source or report uncertainty; do not invent a fresh budget or a completed task | No automatic resurrection of an expired node token |

Do not add valid-rating cases for totals 0–2: the rubric's minimum is 3. If a
future implementation introduces an actual numeric input boundary, invalid values
would be boundary validation cases, not normal production ratings. Do not add
concurrency/version-conflict tests for a rating-write service that does not exist.
