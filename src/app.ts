import { Command, CommanderError, Option } from 'commander';
import type { Readable, Writable } from 'node:stream';
import { apiOrigin, type Environment } from './config.js';
import { asCliError, CliError, safeText } from './errors.js';
import { HttpClient } from './http.js';
import { modelsForKeys, modelsList, modelsPricing, modelsShow } from './models.js';
import { outputMode, printResult, writeOutput, type CommandResult } from './output.js';
import type { Context } from './runtime.js';
import { authLogin, authLogout, authStatus, type LoginOptions } from './auth.js';
import { mutateKey, type KeyOptions } from './keys.js';
import { loadCredential } from './session.js';

export interface Runtime {
  env?: Environment;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  interactive?: boolean;
  stdoutIsTTY?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  confirm?: (message: string) => Promise<boolean>;
}

export async function runCli(args: string[], runtime: Runtime = {}): Promise<number> {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const json = outputMode(args, runtime.stdoutIsTTY ?? !!process.stdout.isTTY);
  const root = new Command().name('geodd').description('Geodd CLI for people and AI agents.').version('0.1.0');
  root.option('--api-url <origin>', 'API origin (GEODD_API_URL, otherwise https://api.geodd.io)')
    .addOption(new Option('--json', 'one JSON result on stdout (default when piped)').conflicts('text'))
    .addOption(new Option('--text', 'readable terminal output').conflicts('json'))
    .showHelpAfterError(false).exitOverride()
    .configureOutput({ writeOut: text => { stdout.write(text); }, writeErr: text => { stderr.write(text); }, outputError: () => {} });
  const context = (): Context => {
    const env = runtime.env ?? process.env;
    const origin = apiOrigin(root.opts<{ apiUrl?: string }>().apiUrl, env);
    const signal = runtime.signal ?? new AbortController().signal;
    return {
      env, origin, signal, stdin: runtime.stdin ?? process.stdin, stderr,
      interactive: runtime.interactive ?? (!!process.stdin.isTTY && !!process.stderr.isTTY),
      http: new HttpClient(origin, { signal, ...(runtime.fetch ? { fetch: runtime.fetch } : {}), ...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}) }),
      warn: message => writeOutput(stderr, message.split('\n').map(safeText).join('\n') + '\n'),
      ...(runtime.openBrowser ? { openBrowser: runtime.openBrowser } : {}),
      ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
    };
  };
  let result: CommandResult | undefined;
  const models = root.command('models').description('Public inference catalog and prices; authenticated console IDs with list --for-keys.');
  models.command('list').description('List public inference models, or console model IDs for key management.')
    .option('--for-keys', 'read the authenticated /console/models catalog; its IDs are used by keys create/update')
    .addHelpText('after', '\nDefault: public inference IDs and pricing, with no credentials.\n--for-keys: all console models, not scoped to any key; requires a Geodd session.\nUse the returned id with keys create/update --model. It is not an inference alias.')
    .action(async (options: { forKeys?: boolean }) => {
      const ctx = context();
      result = options.forKeys
        ? await modelsForKeys(ctx.http, (await loadCredential(ctx.origin, ctx.env)).token)
        : await modelsList(ctx.http);
    });
  models.command('show <model-id>').description('Show the exact case-sensitive public ID, including capabilities and limits.').action(async (id: string) => { result = await modelsShow(context().http, id); });
  models.command('pricing [model-id]').description('Original modality/unit prices and exact USD per million token prices.').action(async (id?: string) => { result = await modelsPricing(context().http, id); });
  const auth = root.command('auth').description('Google login/signup, protected session validation, and local logout.');
  auth.command('login').description('Sign into an existing account, or validate/import a Geodd session JWT from stdin.')
    .option('--token-stdin', 'read one Geodd session JWT from bounded stdin, not a Google ID token or inference key')
    .option('--no-browser', 'explicit local flow without opening a browser (required in non-TTY use)')
    .option('--port <port>', 'authorized localhost port (default: 43187)')
    .addHelpText('after', '\nExamples:\n  geodd auth login\n  geodd auth login --token-stdin < private-session-token\n  geodd auth login --no-browser --port 43187\n\nBrowser setup: configure GEODD_GOOGLE_CLIENT_ID and authorize both http://localhost\nand http://localhost:43187 in Google Cloud, matching backend audience configuration.\nPort overrides need their own authorization. Remote localhost URLs are not device login.\nStored sessions are private plaintext files. Never pass tokens in command arguments.')
    .action(async (options: LoginOptions) => { result = await authLogin(context(), options); });
  auth.command('signup').description('Create a standard account with separate explicit browser legal consent; no wallet or keys.')
    .option('--no-browser', 'explicit local flow without opening a browser')
    .option('--port <port>', 'authorized localhost port (default: 43187)')
    .addHelpText('after', '\nTerms and privacy must be accepted separately in the browser; marketing is optional.\nGoogle client ID and exact localhost origins must be configured as for auth login.\nNo enterprise signup, password setup, funding, or automatic key creation.')
    .action(async (options: LoginOptions) => { result = await authLogin(context(), options, true); });
  auth.command('status').description('Validate the selected session and 2FA policy with protected console routes; never print tokens.')
    .action(async () => { result = await authStatus(context()); });
  auth.command('logout').description('Remove this origin\'s local session only; no server revocation or environment changes.')
    .action(async () => { result = await authLogout(context()); });
  auth.addHelpText('after', '\nCredentials: GEODD_SESSION_TOKEN takes precedence over the selected origin\'s file.\nGEODD_SESSION_TOKEN_ORIGIN defaults to https://api.geodd.io; set it explicitly for staging.\nChanging --api-url never forwards a production session to another origin.\nNo refresh tokens or automatic browser login on authorization failure.\nGEODD_CONFIG_DIR overrides the private per-user plaintext session directory.\nWindows persistence is currently disabled pending private-ACL validation; use\norigin-bound environment sessions on Windows. Public models need no credentials.');
  const keys = root.command('keys').description('Create, replace models, rotate, or delete a key. Existing operations require IDs, not secrets.');
  const collect = (value: string, previous: string[] = []) => [...previous, value];
  keys.command('create').description('Create a globally named PostPaid key; stdout includes its one-time secret.')
    .requiredOption('--name <name>', 'globally unique name: 1-32 letters, numbers, or dashes')
    .requiredOption('--model <id>', '24-hex console model ID from models list --for-keys; repeat for multiple models', collect)
    .option('--monthly-volume <integer>', 'positive monthly token capacity (backend default: 3,000,000,000)')
    .option('--yes', 'explicitly approve the mutation, required for automation')
    .addHelpText('after', '\nBilling defaults to PostPaid. No billing-mode override is supported.\nSave the one-time secret securely from stdout; it is not stored by this CLI.')
    .action(async (options: KeyOptions) => { result = await mutateKey(context(), 'create', options); });
  keys.command('update <key-id>').description('REPLACE the complete attached model set, not add to it.')
    .requiredOption('--model <id>', 'replacement console model ID from models list --for-keys; repeat for multiple models', collect)
    .option('--yes', 'explicitly approve replacement, required for automation')
    .action(async (id: string, options: KeyOptions) => { result = await mutateKey(context(), 'update', options, id); });
  keys.command('rotate <key-id>').description('Invalidate the previous secret and return a new secret once on stdout.')
    .option('--yes', 'explicitly approve rotation, required for automation')
    .action(async (id: string, options: KeyOptions) => { result = await mutateKey(context(), 'rotate', options, id); });
  keys.command('delete <key-id>').description('Permanently delete a key and its backend mapping.')
    .option('--yes', 'explicitly approve deletion, required for automation')
    .action(async (id: string, options: KeyOptions) => { result = await mutateKey(context(), 'delete', options, id); });
  keys.addHelpText('after', '\nAgent workflow (inject GEODD_SESSION_TOKEN securely, never in argv):\n  geodd models list --for-keys --json\n  geodd keys create --name my-agent --model <console-model-id> --yes --json\n  geodd keys update <key-id> --model <console-model-id> --yes\n\nReplace placeholders with actual IDs. Public inference aliases such as\nopenai/gpt-oss-120b are not valid console model IDs. No mapping is guessed.\nReview the selected API origin. --yes approves key mutations, never signup legal terms.\nThere is no key-list command or secret-to-ID lookup. Key IDs come from saved responses.\nTimeouts can leave uncertain outcomes; never blindly retry creation or rotation.');
  root.addHelpText('after', '\nExamples:\n  npx geodd models list --json\n  geodd models show openai/gpt-oss-120b\n  geodd models pricing openai/gpt-oss-120b\n  geodd auth login\n  geodd auth status --json\n  geodd models list --for-keys --json\n  geodd keys create --name my-agent --model <console-model-id> --yes --json\n\nPublic models never use credentials. Console sessions use secret_token, not Bearer.\nKey commands use console model IDs, not public inference aliases.\nGoogle ID tokens and inference API keys are not console sessions.\nErrors in JSON mode are single result objects; instructions and warnings go to stderr.\nExit codes: 0 success/help, 1 service/protocol failure, 2 usage/validation,\n3 authentication/2FA, 4 confirmation rejected/required, 130 interrupted.');
  try {
    if (!args.length) { root.outputHelp(); return 0; }
    await root.parseAsync(args, { from: 'user' });
    if (!result) throw new CliError('USAGE', 'A subcommand is required. Run geodd --help.', 2);
    await printResult(stdout, result, json);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const failure = error instanceof CommanderError
      ? new CliError('USAGE', 'Invalid, missing, conflicting, or unknown command arguments. Run geodd --help or the subcommand with --help.', 2)
      : asCliError(error);
    const value = { code: failure.code, message: failure.message, ...(failure.status !== undefined ? { status: failure.status } : {}) };
    try {
      if (failure.code === 'MUTATION_OUTPUT_FAILED' || failure.code === 'OUTPUT_FAILED') await writeOutput(stderr, `${failure.code}: ${failure.message}\n`);
      else if (json) await writeOutput(stdout, JSON.stringify({ success: false, error: value }) + '\n');
      else await writeOutput(stderr, `${failure.code}: ${safeText(failure.message)}\n`);
    } catch { /* The destination is unavailable; never repeat secret-bearing results. */ }
    return failure.exitCode;
  }
}
