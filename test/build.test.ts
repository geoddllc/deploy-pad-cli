import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const buildScript = resolve('scripts/build.mjs');
const fileId = '123-file-client.apps.googleusercontent.com';
const environmentId = '456-environment-client.apps.googleusercontent.com';
const syntheticSecret = 'synthetic-private-value-do-not-bundle';
const compiledConfig = "const BUNDLED_GOOGLE_CLIENT_ID = '';\nexport const clientId = BUNDLED_GOOGLE_CLIENT_ID;\n";

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'geodd-build-'));
  try {
    await mkdir(join(directory, 'src', 'assets'), { recursive: true });
    await writeFile(join(directory, 'src', 'assets', 'index.html'), '<html>synthetic browser asset</html>');
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    for (const output of ['dist', '.test-dist/src']) {
      await mkdir(join(directory, output), { recursive: true });
      await writeFile(join(directory, output, 'config.js'), compiledConfig);
      await writeFile(join(directory, output, 'cli.js'), '#!/usr/bin/env node\n');
    }
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function build(directory: string, env: NodeJS.ProcessEnv = {}, testing = false) {
  const environment = { ...process.env, ...env };
  if (!Object.hasOwn(env, 'GEODD_GOOGLE_CLIENT_ID')) delete environment.GEODD_GOOGLE_CLIENT_ID;
  return execute(process.execPath, [buildScript, ...(testing ? ['--test'] : [])], { cwd: directory, env: environment });
}

async function configuration(directory: string, testing = false): Promise<string> {
  return readFile(join(directory, testing ? '.test-dist/src' : 'dist', 'config.js'), 'utf8');
}

test('build bundles only the public ID from dotenv without copying or exporting other values', async () => {
  await fixture(async directory => {
    const dotenv = `# local build configuration\nGEODD_GOOGLE_CLIENT_ID="${fileId}" # public ID\nGEODD_SESSION_TOKEN=${syntheticSecret}\nGOOGLE_CLIENT_SECRET=${syntheticSecret}\nNODE_OPTIONS=${syntheticSecret}\n`;
    await writeFile(join(directory, '.env'), dotenv);
    const result = await build(directory);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.match(await configuration(directory), new RegExp(fileId.replaceAll('.', '\\.')));
    assert.doesNotMatch(await configuration(directory), new RegExp(syntheticSecret));
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), dotenv);
    assert.deepEqual((await readdir(join(directory, 'dist'))).sort(), ['assets', 'cli.js', 'config.js']);
    assert.equal(await readFile(join(directory, 'dist', 'assets', 'index.html'), 'utf8'), '<html>synthetic browser asset</html>');
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'dist', 'cli.js'))).mode & 0o777, 0o755);
    const runtime = await execute(process.execPath, ['--input-type=module', '-e', 'import {clientId} from "./dist/config.js"; console.log(clientId);'], { cwd: directory });
    assert.equal(runtime.stdout.trim(), fileId);
  });
});

test('build uses explicit environment precedence over dotenv, including explicit empty values', async () => {
  await fixture(async directory => {
    await writeFile(join(directory, '.env'), `export GEODD_GOOGLE_CLIENT_ID='${fileId}'\n`);
    await build(directory, { GEODD_GOOGLE_CLIENT_ID: environmentId });
    assert.ok((await configuration(directory)).includes(JSON.stringify(environmentId)));
    assert.ok(!(await configuration(directory)).includes(fileId));
    await build(directory, { GEODD_GOOGLE_CLIENT_ID: '' });
    assert.ok((await configuration(directory)).includes('const BUNDLED_GOOGLE_CLIENT_ID = "";'));
    assert.ok(!(await configuration(directory)).includes(environmentId));
  });
});

test('missing client ID permits builds and does not retain a previous bundled value', async () => {
  await fixture(async directory => {
    await build(directory, { GEODD_GOOGLE_CLIENT_ID: environmentId });
    await build(directory);
    assert.ok((await configuration(directory)).includes('const BUNDLED_GOOGLE_CLIENT_ID = "";'));
    await writeFile(join(directory, '.env'), `UNRELATED=${syntheticSecret}\n`);
    await build(directory);
    assert.ok(!(await configuration(directory)).includes(syntheticSecret));
  });
});

test('invalid build IDs fail without echoing credentials or modifying compiled output', async () => {
  await fixture(async directory => {
    for (const value of [syntheticSecret, 'bad";throw new Error("injected")', `${fileId}\n${syntheticSecret}`]) {
      await assert.rejects(build(directory, { GEODD_GOOGLE_CLIENT_ID: value }), (error: unknown) => {
        assert.ok(error instanceof Error && 'stderr' in error && 'code' in error);
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /must be a Google Web Client ID/);
        assert.ok(!String(error.stderr).includes(syntheticSecret));
        assert.ok(!String(error.stderr).includes(value));
        return true;
      });
      assert.equal(await configuration(directory), compiledConfig);
    }
  });
});

test('test builds ignore dotenv and exported credentials to remain deterministic', async () => {
  await fixture(async directory => {
    await writeFile(join(directory, '.env'), `GEODD_GOOGLE_CLIENT_ID=${fileId}\nGEODD_SESSION_TOKEN=${syntheticSecret}\n`);
    await chmod(join(directory, '.env'), 0o000);
    try {
      await build(directory, { GEODD_GOOGLE_CLIENT_ID: syntheticSecret }, true);
      assert.ok((await configuration(directory, true)).includes('const BUNDLED_GOOGLE_CLIENT_ID = "";'));
      assert.equal(await configuration(directory), compiledConfig);
    } finally { await chmod(join(directory, '.env'), 0o600); }
  });
});

test('unexpected compiled configuration fails instead of silently shipping a missing default', async () => {
  await fixture(async directory => {
    for (const value of ['export const unrelated = true;\n', compiledConfig + compiledConfig]) {
      await writeFile(join(directory, 'dist', 'config.js'), value);
      await assert.rejects(build(directory, { GEODD_GOOGLE_CLIENT_ID: fileId }), (error: unknown) => {
        assert.ok(error instanceof Error && 'stderr' in error);
        assert.match(String(error.stderr), /missing or ambiguous/);
        return true;
      });
      assert.equal(await configuration(directory), value);
    }
  });
});
