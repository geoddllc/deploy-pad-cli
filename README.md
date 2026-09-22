# Geodd CLI

A command-line client for people and AI agents to discover Geodd models and prices, authenticate with Google, and manage API keys. This is a CLI, not an SDK.

Requires **Node.js 22 or newer** and npm. The current npm package and executable are both named `geodd`. Publishing is intentionally blocked with `"private": true` until npm ownership and licensing are confirmed.

## Build From Source

Install the locked dependencies:

```sh
npm ci
```

For browser authentication, put the existing Google **Web application client ID** in a `.env` file at the repository root. Replace the placeholder with the same public ID used by the frontend and accepted by the backend:

```dotenv
GEODD_GOOGLE_CLIENT_ID=your-existing-client-id.apps.googleusercontent.com
```

Build and run:

```sh
npm run build

node dist/cli.js --help
node dist/cli.js models list
node dist/cli.js auth login
```

Do not insert `geodd` or `deploypad` after `node dist/cli.js`. The script is already the executable; `models`, `auth`, or `keys` comes next.

### Build Configuration

The build embeds **only the public Google client ID** into `dist/config.js`. Its precedence is:

1. The build process's `GEODD_GOOGLE_CLIENT_ID` environment variable.
2. `GEODD_GOOGLE_CLIENT_ID` in the repository's `.env` file.
3. An empty default when neither is configured.

An explicitly empty environment value clears the bundled default. A nonempty malformed client ID fails the build without printing its value. Builds without an ID still support public models and supplied console sessions, but browser authentication needs a runtime override.

The client ID is public configuration, not a credential. It will be visible in the compiled code and npm package. Never use a Google client secret, session token, or API key in its place.

The build does not copy `.env`, expand shell expressions, or embed its other variables. `.env` and `.env.*` are ignored by Git and excluded from the package allowlist. Do not force-add these files to Git.

The CLI does **not** automatically load `.env` at runtime. Rebuild after changing `.env`. An exported runtime `GEODD_GOOGLE_CLIENT_ID` overrides the bundled default; other runtime settings must also be exported or supplied through CLI flags.

## Google Authentication Setup

Use the same existing Google Web Client ID as the frontend. No new Desktop OAuth client, client secret, or redirect URI is needed for this GIS popup flow.

In the existing client's **Authorized JavaScript origins**, add both origins below and retain the existing website origins:

```text
http://localhost
http://localhost:43187
```

Ensure the backend accepts that client ID as the Google token audience. A different `--port` must have its exact localhost origin authorized as well; the CLI never chooses a random fallback port.

```sh
node dist/cli.js auth login
node dist/cli.js auth signup
node dist/cli.js auth status
node dist/cli.js auth logout
```

Login never registers automatically. Signup creates a standard account and requires separate terms and privacy consent in the browser; marketing consent is optional. Signup does not fund a wallet or create an API key.

If the account requires existing 2FA, enter its six-digit authenticator or email code, including leading zeros. Email delivery happens only after an explicit browser action. The overall flow expires after at most ten minutes, with at most five minutes for 2FA.

Use `auth login --no-browser` to print the local URL without opening a browser. Noninteractive browser authentication requires this flag explicitly. The URL works on the machine running the CLI; it is not hosted or device authentication for a remote server.

## Models and Pricing

These commands need no authentication or Google configuration:

```sh
node dist/cli.js models list
node dist/cli.js models list --json
node dist/cli.js models show openai/gpt-oss-120b
node dist/cli.js models pricing
node dist/cli.js models pricing openai/gpt-oss-120b
```

Model IDs are exact and case-sensitive. All catalog models are retained, with unavailable models and unknown prices identified rather than silently omitted. Pricing preserves modality, type, unit, and original decimal strings; per-token prices also receive exact USD-per-million conversions.

## Sessions and Automation

Console requests use a Geodd session JWT in the `secret_token` header, without a Bearer prefix. Google ID tokens and inference API keys are not console sessions.

Agents can inject `GEODD_SESSION_TOKEN` securely through their process environment or secret manager. It takes precedence over a stored session and is never saved implicitly. Its origin binding defaults to `https://api.geodd.io`; explicitly set `GEODD_SESSION_TOKEN_ORIGIN` for another origin.

For a staging environment:

```sh
export GEODD_API_URL="https://your-staging-api.example"
export GEODD_SESSION_TOKEN_ORIGIN="$GEODD_API_URL"
# Inject GEODD_SESSION_TOKEN securely; do not place it in command arguments.
node dist/cli.js auth status --json
```

Alternatively, import a session from a private file or a secret-manager pipe:

```sh
node dist/cli.js auth login --token-stdin < /path/to/private-session-token
```

Import validates the supplied session against a protected console route before saving it, even if an overriding environment token exists. Input is bounded to 16 KiB and must contain one token. The file passed to stdin remains your responsibility; the CLI does not delete it.

### Session Storage

Stored sessions are **plaintext credentials**, isolated by canonical API origin. On POSIX systems, directories use `0700` and files use `0600`; unsafe ownership, permissions, symlinks, hardlinks, and macOS allow ACLs are refused.

| Platform | Default location |
| --- | --- |
| macOS | `~/Library/Application Support/geodd/` |
| Linux | `$XDG_CONFIG_HOME/geodd/`, otherwise `~/.config/geodd/` |
| Windows | File persistence is disabled pending private-ACL implementation and validation; use origin-bound environment sessions |

`GEODD_CONFIG_DIR` overrides the session directory. These files must never be shared or committed. Permissions do not prevent access by malware running as your user or by an administrator.

`auth status` validates backend authorization and reports safe metadata, never tokens. JWT expiry decoding is advisory. Logout removes only the selected origin's local record: it does not revoke backend sessions or unset environment variables. There is no refresh-token flow.

## Key Management

Key mutations prompt in an interactive terminal. Automation must supply `--yes`; no mutation request is sent without approval. Existing-key commands require a **key ID**, not a secret. Key listing and secret-to-ID lookup are not supported.

The following examples mutate account resources. Use a designated staging account for acceptance testing, with an origin-bound session configured first:

```sh
node dist/cli.js keys create \
  --name staging-agent \
  --model openai/gpt-oss-120b \
  --monthly-volume 1000000 \
  --yes --json

node dist/cli.js keys update <key-id> --model openai/gpt-oss-120b --yes
node dist/cli.js keys rotate <key-id> --yes
node dist/cli.js keys delete <key-id> --yes
```

Replace `<key-id>` with the actual returned ID before running an existing-key command. Repeat `--model` to supply multiple models.

- Names are globally unique and limited to 1-32 ASCII letters, numbers, or dashes.
- Creation uses the backend's **PostPaid** billing default. Omitted monthly volume uses the backend's **3,000,000,000-token** default.
- Update **replaces** the entire attached model set; it does not append models.
- Rotation invalidates the previous secret. Deletion removes the key and its backend mapping.
- Successful create/rotate output contains a **one-time secret**. Store stdout securely; the CLI never retains the secret in a file.
- Mutations are never automatically retried. Timeouts and output failures can leave uncertain or recovery-needed outcomes; do not blindly repeat creation or rotation.

## Output and Configuration

Output is readable text on a terminal and JSON when piped. Use `--text` or `--json` to override; the flags are mutually exclusive. Instructions, browser URLs, prompts, and warnings go to stderr.

JSON mode returns one final result object:

```json
{"success":true,"data":{}}
```

```json
{"success":false,"error":{"code":"AUTH_INVALID","message":"The session is invalid or expired.","status":401}}
```

HTTP status is optional. Help and version output remain ordinary text. Key mutation data preserves the backend's successful response rather than assuming secret or ID field names.

| Setting | Behavior |
| --- | --- |
| `--api-url`, `GEODD_API_URL` | Explicit flag wins, then environment, then `https://api.geodd.io` |
| `GEODD_GOOGLE_CLIENT_ID` | Runtime override of the public ID bundled by the build |
| `GEODD_SESSION_TOKEN` | Injected console session, preferred over files |
| `GEODD_SESSION_TOKEN_ORIGIN` | Token's origin binding; defaults to production |
| `GEODD_CONFIG_DIR` | Private session-directory override |

API URLs must be HTTPS origins, except HTTP is permitted on exactly `localhost`, `127.0.0.1`, or `[::1]`. Paths, embedded credentials, query strings, and fragments are rejected. API redirects are not followed, and changing an API URL never automatically forwards a production credential to the new origin.

| Exit code | Meaning |
| --- | --- |
| `0` | Success or help |
| `1` | Transport, service, protocol, or unexpected failure |
| `2` | Usage or local validation failure |
| `3` | Missing/invalid session, authorization failure, or unresolved 2FA |
| `4` | Confirmation required or rejected, or browser cancellation |
| `130` | Interrupted |

## Tests and Package Validation

```sh
npm run typecheck
npm test
npm run check
npm run pack:check
```

The normal test suite uses Node's test runner, local mock servers, synthetic credentials, and isolated temporary directories. It does not require Google or production credentials, and test builds ignore your `.env` and exported Google client ID. `npm run check` also builds the production artifact, which does read build configuration as described above.

Create and test the npm tarball without publishing:

```sh
npm pack
npm exec --package ./geodd-0.1.0.tgz -- geodd --help
npm exec --package ./geodd-0.1.0.tgz -- geodd models list --json
```

`npm pack` rebuilds automatically. The package includes compiled JavaScript, browser assets, package metadata, and this README, not `.env`, session files, tests, or Kilo metadata. The public models command is the only production smoke test intended here.

## Release Status

Builds and automated tests have been validated on macOS with Node 22 and Node 24. Mocked browser flows have also been checked in desktop and mobile Chrome. Linux and Windows runtime acceptance remains outstanding.

Before publishing:

1. Confirm npm package ownership and the project's license. `private: true` currently blocks publishing; `UNLICENSED` records that no distribution license has been confirmed.
2. Supply the real public Google Web Client ID and authorize the exact localhost origins, matching backend audience configuration.
3. Run real login, signup, 2FA, and key acceptance checks against explicitly designated staging accounts. Mocks do not establish deployed Google configuration or mutation payload compatibility.
4. Validate secure Windows ACL storage before enabling or advertising Windows file persistence.

Publishing, production account/key mutations, billing changes, and Google/backend deployment configuration changes are separate release operations, not part of routine builds or tests.
