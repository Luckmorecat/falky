# Working in this repository

Use the `gh` CLI for GitHub operations, including pull requests, issues,
workflow runs, and attachments. Use `gh api` when a dedicated subcommand
does not cover the operation, and check `gh <command> --help` for supported
options.

Use the [pr skill](.agents/skills/pr/SKILL.md) when creating or updating PR bodies.

Avoid adding comments that merely restate what the code does.

## Corners

Nested corners are concentric: an outer radius is the inner radius plus the
padding between them (`outer = inner + gap`). Derive the outer radius from
the inner one in CSS (`calc(inner + gap)`) instead of picking a round number,
so it stays right under `--corner` scaling in Safari. Scale the inner radius by
`--corner`, never the gap.
