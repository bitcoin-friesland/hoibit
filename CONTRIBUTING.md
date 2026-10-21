# Contributing

Thanks for helping. This repository runs a live CRM, so changes go through a pull request and CI before they reach `main`.

## Workflow

1. Branch from `main`. Keep one topic per branch and per pull request.
2. Make the change in the worker it belongs to. Setup and commands are in the [README](README.md#run-and-test).
3. Add or update tests in that worker's `test/` folder. Tests run in the Workers runtime against a local D1 with all migrations applied; Telegram, OpenStreetMap and other outside services are stubbed.
4. Before pushing, run in each worker you touched:
   ```sh
   npm run typecheck
   npm test
   ```
   and in the repository root:
   ```sh
   npm run format
   ```
5. Open a pull request. CI must be green. Describe what changes for the people using the bot, and anything that has to happen outside the code (a migration, a secret, deploy order).

Merging to `main` deploys the changed workers, so a merge is a release.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/) with the worker as scope, for example `fix(telegram-crm): …` or `feat(crm-api): …`.
- **TypeScript**, strict, formatted by Prettier with the root config. Comments explain why, not what.
- **Database changes** are new files in `crm-api/migrations/`, created with `npx wrangler d1 migrations create crm <name>` in `crm-api/`. Never edit an applied migration. Bind every value with the type of its column; see [.crm-rules.md](.crm-rules.md).
- **Every write** in crm-api records an `audit_log` row in the same batch. Team members are deactivated, not deleted.
- **RPC changes**: when telegram-crm needs a new or changed crm-api method, ship the crm-api change first and mention the order in the pull request.
- **No personal data or secrets** in code, tests, fixtures or logs. Use fictional names and `example.com` addresses in tests.

## Reporting problems

Open a GitHub issue for bugs and ideas. For a security problem, do not open a public issue; contact the maintainers privately via info@bitcoinfriesland.com.

## License

By contributing you agree that your contribution is released into the public domain under [The Unlicense](LICENSE).
