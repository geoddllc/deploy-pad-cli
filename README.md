# Geodd CLI

A command-line client for people and AI agents to discover Geodd models and prices, authenticate with Google, and manage API keys. This is a CLI, not an SDK.

Requires **Node.js 22 or newer** and npm. The npm package is `@geodd/cli`; the executable is `geodd`.

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

### Model IDs for Keys

The commands above use **public inference IDs**, such as `openai/gpt-oss-120b`. Key creation and model-set updates use a different identifier: the model document's 24-character hexadecimal MongoDB ID. After authenticating with `auth login` or supplying an origin-bound session, discover those IDs with a read-only command:

```sh
node dist/cli.js models list --for-keys
node dist/cli.js models list --for-keys --json
```

This calls `GET /console/models` with the selected origin-bound session, without a body or selected-key filter. It lists every returned model in backend order and exposes only `id` and `name`. Use that `id` with key commands. The CLI does not guess a mapping from public inference names or IDs.

Example JSON response from `https://api.geodd.io`, shortened to three entries from a confirmed response:

```json
{
  "success": true,
  "data": [
    {
      "id": "6a46324b5f8f2743b7db27c2",
      "name": "GLM 5.2"
    },
    {
      "id": "6a0c61a2440517768d5b51fa",
      "name": "DeepSeek V4 Flash"
    },
    {
      "id": "6a0339638bcea1adc9ba6194",
      "name": "openai/gpt-oss-120b"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `success` | Whether the CLI command completed successfully |
| `data` | Console model entries; the actual response can contain more entries than this excerpt |
| `data[].id` | The model database ID to pass to `keys create --model` or `keys update --model` |
| `data[].name` | The model's display name, or `null` if no name is available |

Even when `name` looks like an inference ID, as it does for `openai/gpt-oss-120b`, pass the **`id` field** to key commands. In this example, that is `6a0339638bcea1adc9ba6194`. These are model identifiers, not API key secrets or existing key IDs.

The catalog is live, not a fixed list maintained by the CLI. Fetch it for the same API origin you will use for key management; do not assume these example IDs are permanent or shared between production and staging.

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

First run `models list --for-keys` and identify the model you want. The following commands mutate account resources. For acceptance testing, use a designated staging account and IDs fetched from that staging origin.

For the production catalog excerpt above, the create command for `openai/gpt-oss-120b` uses its returned database ID:

```sh
node dist/cli.js keys create \
  --name my-agent-key \
  --model 6a0339638bcea1adc9ba6194 \
  --yes --json
```

Confirm the ID is still in your selected origin's catalog and choose a globally unique name before running this example. Save the returned one-time secret securely; do not paste it into documentation, issues, or agent prompts. `--monthly-volume` is optional and is intentionally omitted here.

For existing keys, replace `KEY_ID_FROM_CREATE_RESPONSE` with the key's returned ID and `MODEL_ID_FROM_CONSOLE_CATALOG` with a model ID from `models list --for-keys`:

```sh
node dist/cli.js keys update KEY_ID_FROM_CREATE_RESPONSE --model MODEL_ID_FROM_CONSOLE_CATALOG --yes
node dist/cli.js keys rotate KEY_ID_FROM_CREATE_RESPONSE --yes
node dist/cli.js keys delete KEY_ID_FROM_CREATE_RESPONSE --yes
```

Repeat `--model` to supply multiple console model IDs. Hexadecimal IDs are normalized to lowercase and deduplicated before sending. A public inference ID is rejected locally, before credential lookup or any API request. Well-formed IDs are still checked for existence by the backend; a 24-character value is not proof that a model exists.

- Names are globally unique and limited to 1-32 ASCII letters, numbers, or dashes.
- Creation uses the backend's **PostPaid** billing default. `--monthly-volume` is optional; omitting it uses the backend's **3,000,000,000-token** default. The CLI does not enforce a spending cap.
- Update **replaces** the entire attached model set; it does not append models.
- Rotation invalidates the previous secret. Deletion removes the key and its backend mapping.
- Successful create/rotate output contains a **one-time secret**. Store stdout securely; the CLI never retains the secret in a file.
- Mutations are never automatically retried. Timeouts and output failures can leave uncertain or recovery-needed outcomes; do not blindly repeat creation or rotation.
- Known backend validation messages, including invalid/nonexistent model IDs and duplicate key names, are reported safely. Unknown error bodies, credentials, and other users' existing key IDs are not printed.

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
npm exec --package ./geodd-cli-0.1.0.tgz -- geodd --help
npm exec --package ./geodd-cli-0.1.0.tgz -- geodd models list --json
```

`npm pack` rebuilds automatically. The package includes compiled JavaScript, browser assets, package metadata, this README, and the MIT license, not `.env`, session files, tests, or Kilo metadata. The public models command is the only production smoke test intended here.

## Release Status

Builds and automated tests have been validated on macOS with Node 22 and Node 24. Mocked browser flows have also been checked in desktop and mobile Chrome. Linux and Windows runtime acceptance remains outstanding.

Publishing, production account/key mutations, billing changes, and Google/backend deployment configuration changes are separate release operations, not part of routine builds or tests.

## License

[MIT](LICENSE). Copyright (c) 2026 Geodd.
