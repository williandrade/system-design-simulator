import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const frontendDir = join(projectDir, 'frontend');
const { name, version, productName, devDependencies } = JSON.parse(
  await readFile(join(desktopDir, 'package.json'), 'utf8'),
);
const electronVersion = devDependencies.electron;
const nodeVersion = '24.22.3';
const nodeArchiveHash = '1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5';

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

async function stageRuntimePackage(name, runtimeFiles, resourcesDir) {
  const source = join(projectDir, name);
  const destination = join(resourcesDir, name);
  await mkdir(destination);
  for (const file of ['package.json', 'package-lock.json', ...runtimeFiles]) {
    await cp(join(source, file), join(destination, file), { recursive: true });
  }
  // Package only the JavaScript runtime. npm CLI symlinks would point outside the moved bundle.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund'], destination);
}

async function stageNode(stagingDir, resourcesDir) {
  const distribution = `node-v${nodeVersion}-darwin-arm64`;
  const archive = join(stagingDir, `${distribution}.tar.xz`);
  run('/usr/bin/curl', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '180',
    '--output', archive, `https://nodejs.org/dist/v${nodeVersion}/${distribution}.tar.xz`,
  ]);

  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  if (digest.digest('hex') !== nodeArchiveHash) {
    throw new Error(`SHA-256 verification failed for ${distribution}.tar.xz`);
  }

  run('/usr/bin/tar', ['-xf', archive, `${distribution}/bin/node`, `${distribution}/LICENSE`], stagingDir);
  const runtimeDir = join(resourcesDir, 'runtime');
  await mkdir(runtimeDir);
  await cp(join(stagingDir, distribution, 'bin/node'), join(runtimeDir, 'node'));
  await cp(join(stagingDir, distribution, 'LICENSE'), join(runtimeDir, 'LICENSE'));
}

async function buildApp(stagingDir) {
  const icon = join(stagingDir, 'App.icns');
  run(process.execPath, [join(frontendDir, 'scripts/generate-brand-assets.mjs'), '--mac-icon', icon], frontendDir);
  const angularOutputDir = join(stagingDir, 'angular');
  run(process.execPath, [
    join(frontendDir, 'node_modules/@angular/cli/bin/ng.js'),
    'build', '--configuration', 'production,desktop', '--output-path', angularOutputDir,
  ], frontendDir);

  const resourcesDir = join(stagingDir, 'simulator');
  await mkdir(join(resourcesDir, 'data'), { recursive: true });
  await cp(join(angularOutputDir, 'browser'), join(resourcesDir, 'frontend'), { recursive: true });
  await cp(
    join(frontendDir, 'src/app/core/data/regions/us-east-1.json'),
    join(resourcesDir, 'data/us-east-1.json'),
  );
  const { services } = JSON.parse(await readFile(join(frontendDir, 'src/app/core/config/aws-services.json'), 'utf8'));
  await writeFile(join(resourcesDir, 'data/docs-service-ids.json'), JSON.stringify(services.map(({ type }) => type)));
  await stageRuntimePackage('backend', ['pricing.js', 'regions.js'], resourcesDir);
  await stageRuntimePackage('mcp', ['src'], resourcesDir);
  await stageNode(stagingDir, resourcesDir);

  const launcherSource = join(desktopDir, 'scripts/system-design-simulator-mcp');
  // Keep the previous filename available for MCP hosts with an existing launcher path.
  for (const filename of ['willis-overengineer-inator-mcp', 'system-design-simulator-mcp']) {
    const launcherPath = join(resourcesDir, filename);
    await cp(launcherSource, launcherPath);
    await chmod(launcherPath, 0o755);
  }

  const appDir = join(stagingDir, 'app');
  await mkdir(appDir);
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name, version, productName, main: 'main.cjs' }));
  for (const file of [
    'main.cjs', 'preload.cjs', 'mcp-setup.cjs', 'desktop-mcp.cjs',
    'protocol.cjs', 'migration.cjs', 'dev-runtime.cjs',
  ]) {
    await cp(join(desktopDir, file), join(appDir, file));
  }
  await cp(join(projectDir, 'LICENSE'), join(appDir, 'LICENSE'));
  await cp(join(projectDir, 'NOTICE'), join(appDir, 'NOTICE'));

  const [outputDir] = await packager({
    name: productName,
    icon,
    appBundleId: 'io.github.williandrade.system-design-simulator',
    dir: appDir,
    extraResource: resourcesDir,
    out: join(desktopDir, 'dist'),
    platform: 'darwin',
    arch: 'arm64',
    electronVersion,
    asar: true,
    overwrite: true,
    tmpdir: stagingDir,
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      continueOnError: false,
      // This local ad hoc build has no Team ID for Hardened Runtime library validation.
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
    },
  });
  console.log(`App ready: ${join(outputDir, `${productName}.app`)}`);
}

if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '24') {
  throw new Error('Build the desktop app on an Apple Silicon Mac with an ARM64 Node.js 24 runtime.');
}

const stagingDir = await mkdtemp(join(tmpdir(), 'system-design-simulator-package-'));
try {
  await buildApp(stagingDir);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
