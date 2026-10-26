# Third-party sources for Android specialist skills

This directory contains condensed, modified derivatives of Apache-2.0 licensed
skills. The shared [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt) is the full
text from `android/skills` `LICENSE.txt` (SHA-256
`58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`); the
`chrisbanes/skills` `LICENSE` carries the same Apache-2.0 terms with only
leading/trailing whitespace differences. Every derived Markdown file also
carries its own source, full commit SHA and modification notice near the top so
it stays traceable without this table.

Both upstream repositories were fetched at the pinned commits below. Neither
repository root contains a `NOTICE` file; this project does not invent one.
The inspected upstream files do not carry per-file copyright headers, so
ownership is attributed from verified repository metadata rather than an
inferred notice.

## Pinned sources

| Source | Full commit SHA | License | Attribution verified from | Root NOTICE |
| --- | --- | --- | --- | --- |
| [android/skills](https://github.com/android/skills) | `4ebabf2b0fd6c04b7150023c8b612f80592a6226` | Apache-2.0 (`LICENSE.txt`) | `.claude-plugin/plugin.json` author `Google / Android`; README describes Google's official Android skills repository | None (root listing checked) |
| [chrisbanes/skills](https://github.com/chrisbanes/skills) | `6c30c500c36a1827c8fde75415dd7a31394bc02c` | Apache-2.0 (`LICENSE`) | Repository owner `chrisbanes` (Chris Banes); README and license declaration | None (root listing checked) |

## Derived skills and upstream paths

| Satellite skill | Upstream paths at the pinned SHA | Changes |
| --- | --- | --- |
| `android-compose-performance` | `jetpack-compose/jetpack-compose-performance/SKILL.md`; `jetpack-compose/jetpack-compose-performance/references/state-and-stability.md`; `jetpack-compose/jetpack-compose-performance/references/effects-and-threading.md`; `jetpack-compose/jetpack-compose-performance/references/lazy-layouts.md`; `jetpack-compose/jetpack-compose-performance/references/layouts.md`; `jetpack-compose/jetpack-compose-performance/references/graphics-performance.md`; `jetpack-compose/jetpack-compose-performance/references/animation.md`; `jetpack-compose/jetpack-compose-performance/references/android/develop/ui/compose/custom-modifiers.md` | Condensed and rewritten as an on-demand method; category checklist kept with measurable caveats; code patterns reduced to decisive examples; reference split reorganized; no upstream executable content. |
| `android-anr-diagnostics` | `performance/anr-audit-and-fix/SKILL.md`; `performance/anr-audit-and-fix/references/risk_analysis_guide.md`; `performance/anr-audit-and-fix/references/trace_analysis_guide.md`; `performance/anr-audit-and-fix/references/anr_trace_report_template.md` | Rewritten for static-risk versus trace-evidence separation; static findings explicitly remain candidates, not measured ANR proof; report template condensed. |
| `android-permissions-security` | `security/android-permissions-security/SKILL.md`; `security/android-permissions-security/references/android/guide/topics/manifest/permission-element.md`; `security/android-permissions-security/references/android/guide/topics/permissions/overview.md`; `security/android-permissions-security/references/android/training/permissions/requesting.md`; `security/android-permissions-security/references/android/privacy-and-security/risks/sender-of-pending-intents.md` | Condensed into audit, manifest/IPC, caller-verification and runtime-flow references; code samples trimmed; no signing-key or credential operations added. |
| `android-kotlin-concurrency` | `skills/kotlin-concurrency-and-flow/SKILL.md`; `skills/kotlin-concurrency-and-flow/references/structured-concurrency.md`; `skills/kotlin-concurrency-and-flow/references/flow-state-events.md` | Rewritten; upstream `gradle-run` route removed; cross-skill links changed to this project's actual relative paths; no build execution instructions. |
| `android-compose-state-effects` | `skills/compose-state-and-effects/SKILL.md`; `skills/compose-state-and-effects/references/local-state.md`; `skills/compose-state-and-effects/references/state-hoisting.md`; `skills/compose-state-and-effects/references/side-effects.md` | Rewritten; upstream `compose-performance` and `compose-focus-navigation` routes replaced with links that exist in this project or omitted; focus navigation is explicitly out of scope. |
| `android-compose-ui-testing` | `skills/compose-ui-testing-patterns/SKILL.md`; `skills/compose-ui-testing-patterns/references/interaction-state.md` | Rewritten; focus-navigation cross-link removed rather than left dangling; screenshot and determinism caveats retained; no test runner or Gradle invocation. |
| `android-performance-analysis` | `profilers/android-profiler/SKILL.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/perfetto_trace_analysis.md`; `profilers/android-profiler/analysis/workflows/perfetto-sql/perfetto_sql.md` (routing entry only); `profilers/android-profiler/references/perfetto/sql.md` (body of `references/perfetto-sql.md`); `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/triage.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/per_candidate_analysis.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/hints_cpu.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/hints_graphics.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/hints_memory.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/hints_io.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/hints_ipc.md`; `profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/hints_power.md` | Recording, orchestrator, environment setup, binary download and sub-agent fan-out removed. Only Perfetto analysis knowledge, SQL guidance, triage and evidence rules remain; the caller supplies the trace and query capability. |

A path marked *routing entry only* is an upstream workflow entry point that the
derived text follows; the rewritten body of the matching reference comes from the
adjacent body path, not from the routing file. All paths are read at the pinned
SHA above.

## License obligations

- Copyright remains with the respective upstream authors/owners. This project
  claims no ownership of the upstream text; the notices describe origin only.
- Recipients receive the full Apache-2.0 text in
  [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt).
- Each modified file carries a prominent notice that it was changed by
  Satellite DSH, with the upstream repository and full SHA.
- No upstream `NOTICE` existed at either pinned commit, so no third-party
  notice text is reproduced or fabricated.
- Upstream trademarks and project names remain the property of their owners;
  they are used only to describe origin.
