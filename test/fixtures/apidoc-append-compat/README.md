# Self-contained apiDoc append-CLI fixture

`apidoc_append_compat.py` is a small synthetic Python CLI written for
`test/skill-scripts.test.mjs`. It is **not** a copy of the Axon apiDoc parser or
of any external project source. It only reproduces the CLI contract the
regression needs:

- `argparse` with repeated (`action="append"`) `--group`, `--method`, and
  `--path-prefix` values kept in arrival order;
- local file input via `--source` and JSON on stdout;
- real filtering over apiDoc-shaped articles.

The test vendors this file into a temporary skill directory with no manifest,
then runs it through the registered `satellite_skill_script_run` tool path with
the real `python3` interpreter. Input data is local and synthetic; no network
access is involved.
