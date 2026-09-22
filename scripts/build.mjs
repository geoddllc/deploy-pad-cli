import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

try {
  const testing = process.argv.includes('--test');
  const destination = testing ? '.test-dist/src' : 'dist';
  let clientId = '';
  if (!testing) {
    if (process.env.GEODD_GOOGLE_CLIENT_ID !== undefined) clientId = process.env.GEODD_GOOGLE_CLIENT_ID;
    else {
      try { clientId = parseEnv(await readFile('.env', 'utf8')).GEODD_GOOGLE_CLIENT_ID ?? ''; }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the local .env build configuration.'); }
    }
    if (clientId && !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      throw new Error('GEODD_GOOGLE_CLIENT_ID must be a Google Web Client ID ending in .apps.googleusercontent.com, never a client secret or token.');
    }
  }
  const configPath = `${destination}/config.js`;
  const config = await readFile(configPath, 'utf8');
  const declaration = /^const BUNDLED_GOOGLE_CLIENT_ID = .*;$/gm;
  if ([...config.matchAll(declaration)].length !== 1) throw new Error('Compiled Google configuration is missing or ambiguous. Run the TypeScript build first.');
  await writeFile(configPath, config.replace(declaration, () => `const BUNDLED_GOOGLE_CLIENT_ID = ${JSON.stringify(clientId)};`));
  await mkdir(`${destination}/assets`, { recursive: true });
  await cp('src/assets', `${destination}/assets`, { recursive: true });
  await chmod(`${destination}/cli.js`, 0o755);
} catch (error) {
  console.error(error instanceof Error && !('code' in error) ? error.message : 'The CLI build could not finish. Check source assets and output-directory access.');
  process.exitCode = 1;
}
