# hoibit: contributor and agent starting point

Cloudflare Workers CRM integration: HTTP CRM API, Telegram conversation bot and inbound-email forwarding.

Source snapshot checked **2026-09-12**, default branch `main` at
[`05c014213364`](https://github.com/bitcoin-friesland/hoibit/commit/05c014213364f5df80c7cc730982069e51cdc61d).
This records repository structure and declared commands, not a production audit or passing test run.

## First five minutes

1. Read [AGENTS.md](../AGENTS.md) and [README.md](../README.md). Load task-specific guides below.
2. Confirm the repository remote, branch, head and changed-file scope. Use an isolated checkout when another contributor is active.
3. Inspect [open PRs](https://github.com/bitcoin-friesland/hoibit/pulls) and the task discussion before taking a file. Agree who writes each overlapping file; a note in a handoff is not a technical lock.
4. Record the task's acceptance criteria, excluded areas and verification plan in the PR or existing workstream record.
5. Use the [handoff template](HANDOFF-TEMPLATE.md) before changing agents or ending a session.

Any agent can read these Markdown files, including Grok, Opus, Fable, SOL, Codex,
Claude Code and Cowork. File auto-loading varies by tool: explicitly attach or ask
the next agent to read the linked files. Model identity does not grant repository,
merge, deployment or data access. Existing project role assignments still apply.

## Project-specific boundaries

This public source repository is not permission to expose CRM records or send Telegram messages. No real automated test suite is configured. Validate authorization, duplicate events, external failures and redacted logging with local mocks before a release.

Current user instructions and repository policy determine authorization. Dated
logs describe past work; they do not authorize fresh production actions. If two
guides disagree, compare their dates, source and owner decision, then record the
conflict instead of silently choosing the more permissive instruction.

## Local development and declared checks

The root and worker `test` scripts are placeholders that deliberately exit 1; they are **not a test suite**. No root build or dev script exists. `mail-to-tg/package.json` declares `postal-mime`; the other worker has its own package manifest. No lockfile is committed in this snapshot, so a reproducible dependency/toolchain pin is still a follow-up.

Before running a worker locally, inspect its `wrangler.toml`, use an approved pinned Wrangler version, and configure only local D1/KV bindings plus fake Telegram transport. Do not run remote database commands, register a webhook, deploy a worker or send a real email/message as setup. Deployment account ownership and currently served versions remain unverified.

## Where to change what

| Concern | Source or existing guide |
| --- | --- |
| Architecture and operating context | [.crm-rules.md](../.crm-rules.md) |
| Build and dependency truth | [package.json](../package.json) |
| Worker entry points | [crm-api/index.js](../crm-api/index.js), [telegram-crm/index.js](../telegram-crm/index.js), [mail-to-tg/index.js](../mail-to-tg/index.js), [schema.sql](../schema.sql) |

Environment names and their source locations: [configuration reference](CONFIGURATION-REFERENCE.md). Values are deliberately excluded.

## Verification and troubleshooting

- Documentation: check relative links against the tracked tree, script names against the correct manifest, and every factual claim against its linked source. A link that resolves does not prove its contents are current.
- Implementation: run the affected package's checks and exercise acceptance criteria, including rejection, duplicate/retry and unavailable-provider states where applicable.
- Missing configuration: identify the variable name, consuming source and runtime; obtain test values through the approved secret channel. Never paste production values into a PR or bypass a guard to get a green build.
- Failed gate: record the command, working directory, tool versions, exact commit and sanitized failure. Compare against the base before calling it a regression. Distinguish failed, blocked, not run and passed.
- Hosted behavior: record preview/deploy URL and served commit separately from the source head. A green CI run, successful build or HTTP 200 alone does not establish access control, delivery or payment correctness.
- Integration: if head or base moves, review the combined diff and rerun affected checks. A self-review is not independent review.

## Keep these documents useful

Update this guide in the same PR when entry points, package commands, environment
names or safety boundaries change. Link detailed domain knowledge instead of
duplicating it. Keep dated evidence in its existing workstream or PR, with SHA,
scope and limitations; do not append full session transcripts to startup files.
Use a short decision record for durable choices: context, decision, alternatives,
consequences, owner/approval and superseded decision. Review release evidence again
after integration. Merge and production/provider changes require separate authority.

## Repeatable documentation check

Run `node scripts/check-documentation.mjs --self-test` and
`node scripts/check-documentation.mjs` from the repository root. See the
[documentation quality policy](DOCUMENTATION-QUALITY.md) for coverage, limitations
and the update triggers that keep the handoff useful. This supplements, not
replaces, the application checks above.
