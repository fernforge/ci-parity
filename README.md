# ci-parity

Catch the "passes locally, fails in CI" bugs before you push — statically, in about 50ms, with no Docker.

You edit, commit, push, wait 8 minutes, and CI fails on something your machine never sees: a Node version your workflow pins differently, a lockfile that's out of sync with `npm ci`, a secret the workflow injects that your shell doesn't have, a `sed -i` that only works on Linux. `ci-parity` reads your workflow files and your repo's config and predicts those failure classes locally.

```
$ npx ci-parity

ci-parity  scanned 1 workflow file(s) in .

  [fail-in-ci] Node major version disagrees across your config files
    - .nvmrc: 18 (Node 18.x)
    - package.json engines.node: >=20 (Node 20.x)
    - ci.yml setup-node node-version: 22 (Node 22.x)
    fix: Pick one source of truth. Put the version in .nvmrc and point the
         workflow at it with node-version-file, then match engines.node.

  [fail-in-ci] 1 dependency is in package.json but not in package-lock.json
    - out of sync: left-pad
    - workflow install: npm ci
    fix: Run `npm install` to regenerate package-lock.json, then commit it.

  [parity-risk] 1 env var your workflow injects is absent locally
    - DEPLOY_KEY <- secrets.DEPLOY_KEY (ci.yml); not in your shell or .env

  2 likely-to-fail-in-CI, 2 parity risk(s). Push will likely fail CI.
```

Exit code is `1` when something will likely fail CI, so it drops straight into a pre-push hook.

## How it's different from what you already use

- **actionlint** checks that your workflow YAML is *valid* — expression types, action inputs, shellcheck on `run:` scripts. It does not compare your workflow to your local environment. `ci-parity` is exactly that comparison.
- **act** *runs* your workflow locally in Docker. That's heavier, its runner images are incomplete, secrets and services need manual wiring, and the OS still differs from GitHub's runners. `ci-parity` doesn't run anything — it predicts the mismatches statically. Use both: `ci-parity` for the fast pre-push gate, `act` when you need to actually execute a job.

## What it checks

All static. No network, no Docker, no running your build.

- **Multi-source Node/tool version drift.** Compares the Node major across `.nvmrc`, `.tool-versions`, `package.json` `engines.node`, `actions/setup-node` in your workflows, and your locally-installed `node`. Single-source setups (`node-version-file: .nvmrc`) are treated as healthy and never flagged.
- **packageManager vs lockfile.** A `packageManager: "pnpm@9"` (Corepack) field with no `pnpm-lock.yaml` committed resolves installs differently in CI than locally.
- **Lockfile staleness.** Dependencies in `package.json` that aren't in `package-lock.json` — the exact drift that makes `npm ci` / frozen installs exit non-zero in CI while `npm install` passes on your machine.
- **Env/secrets missing locally.** Names a workflow injects from `secrets.*` / `vars.*` that aren't in your shell or a local `.env`. When a test reads one, local and CI can take different code paths.
- **OS-only shell steps.** `run:` steps using GNU-only forms (`sed -i` without a suffix, `readlink -f`, `grep -P`, `date -d`, `stat -c`) that behave differently on a macOS/Windows dev machine than the Linux runner.
- **npm 12 default-block risk.** npm 12 (shipped 2026-07-08) defaults `allow-scripts`, `allow-git`, and `allow-remote` to deny. It flags dependencies with lifecycle install scripts (read straight from `package-lock.json`'s `hasInstallScript` field, no install needed), git-protocol deps, and remote tarball-URL deps that will silently stop working the moment CI upgrades npm — unless you've already opted in via `.npmrc`.

## Install

```
npx ci-parity          # one-off, no install
npm i -D ci-parity     # add to a project
```

## GitHub Action

Run the same check as a CI job — catches the same failures on a teammate's PR who skipped the hook:

```yaml
- uses: fernforge/ci-parity@v0.2.0
  with:
    path: .        # optional, default "."
    strict: false  # optional, fail on warnings too
```

## Pre-push hook

With [simple-git-hooks](https://github.com/toplenboren/simple-git-hooks):

```json
{
  "simple-git-hooks": { "pre-push": "npx ci-parity" }
}
```

Or husky — drop `npx ci-parity` into `.husky/pre-push`. A non-zero exit blocks the push.

## Options

```
ci-parity [path]     scan a repo (default: current directory)
--json               machine-readable output
--strict             exit 1 on parity risks (warnings) too, not just likely failures
--warn-only          always exit 0 (report without blocking)
-h, --help
-v, --version
```

Exit codes: `0` clean (or `--warn-only`), `1` a finding that will likely fail CI (or any finding under `--strict`), `2` internal error.

## Scope

GitHub Actions + npm/pnpm/yarn today. It reasons about `.github/workflows/*.yml` and standard Node config files; other CI providers aren't covered yet. It predicts a specific, common set of failure classes — it's not a substitute for running your tests.

## License

MIT. Built autonomously by an AI agent.
