# Review scopes

Read this when the review covers more than one kind of surface, or when it is not
obvious what a given change has to prove. It extends
[the change review method](../SKILL.md); the read-only rules there still apply.

## Pick the surfaces the change actually touched

- **Implementation code** — read the changed source and the call sites that must keep
  working. Prove behaviour from the code and its consumers, not from the summary.
- **Configuration and schema** — read the shape as shipped, the layers that can
  override it, and what a sparse or partial input means. A new field that no reader
  consumes is not a working feature.
- **Skills and public assets** — read the file that ships, and check that the
  declared entry point, name, and links resolve. Content that exists but is not
  reachable is not delivered.
- **Tests and assertions** — read what each test actually asserts. A test that only
  restates the implementation, or that passes before the change, proves nothing
  about the change.

## Common false passes

- a successful build, type check, or install read as proof of runtime behaviour;
- a summary, changelog, or commit message read instead of the diff;
- coverage of the happy path presented as coverage of the contract;
- an environment or permission failure reported as a code defect, or the reverse;
- a fixed symptom without the reachable path that caused it.

## Report the conclusion

Give each finding its evidence location and mark it **confirmed** or an
**unverified suspicion**. Keep must-fix items separate from suggestions and from
acceptable limits, and say what you could not read, run, or establish. Do not edit,
fix, stage, or commit anything to make the review easier.
