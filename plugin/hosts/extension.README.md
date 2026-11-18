# Bughunter native extension artifact

This directory is an **experimental, capability-gated** artifact. It is not published or
advertised as working until the matching runtime gates pass on a real client.

The artifact is built only from a real runtime capability report:

```sh
node plugin/build.mjs --host qwen-extension --capability-report /path/to/report.json
node plugin/build.mjs --host gigacode --capability-report /path/to/report.json
```

The report must be produced by the target client at the current source commit. A fixture report
is valid only for unit tests; it is not evidence of support. The build fails with
`CAPABILITY_REPORT_REQUIRED` without a report and `STALE_CAPABILITY_REPORT` when the report's
`sourceCommit` differs from HEAD.

`--host all` does not build these opt-in surfaces. A release that includes them explicitly stays
`experimental`/`blocked` until install, workspace, target and resume evidence exists.
