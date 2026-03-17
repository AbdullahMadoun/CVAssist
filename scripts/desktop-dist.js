const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const stageDir = path.join(rootDir, '.desktop-build');
const stageDistDir = path.join(stageDir, 'dist');
const rootDistDir = path.join(rootDir, 'dist');
const installMarkerPath = path.join(stageDir, '.last-installed-package-lock.json');
const copyTargets = [
  'desktop',
  'public',
  'server',
  'scripts',
  'data',
  'package.json',
  'package-lock.json',
];
const optionalDirectoryTargets = new Set(['data']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function removeIfExists(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
      throw new Error(
        `Could not replace ${targetPath} because Windows reports it is locked. ` +
        'Close any running CV Customizer process or Explorer handle that is using dist/, then rerun `npm run desktop:dist`.'
      );
    }
    throw error;
  }
}

function copyIntoStage(relativePath) {
  const sourcePath = path.join(rootDir, relativePath);
  const destPath = path.join(stageDir, relativePath);
  removeIfExists(destPath);
  if (!fs.existsSync(sourcePath)) {
    if (optionalDirectoryTargets.has(relativePath)) {
      fs.mkdirSync(destPath, { recursive: true });
      return;
    }
    throw new Error(`Missing required build input: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(sourcePath, destPath, { recursive: true, force: true });
}

function run(command, args, workdir) {
  const commandLabel = [command, ...args].join(' ');
  console.log(`\n> ${commandLabel}`);
  const result = spawnSync(command, args, {
    cwd: workdir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function readFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function hasAllProductionDependencies(stagePath) {
  const packageJson = readJson(path.join(rootDir, 'package.json'));
  const dependencyNames = Object.keys(packageJson.dependencies || {});
  return dependencyNames.every((dependencyName) => {
    const dependencyPath = path.join(
      stagePath,
      'node_modules',
      ...dependencyName.split('/')
    );
    return fs.existsSync(dependencyPath);
  });
}

fs.mkdirSync(stageDir, { recursive: true });

for (const target of copyTargets) {
  copyIntoStage(target);
}

removeIfExists(stageDistDir);

const rootPackageLock = readFileIfExists(path.join(rootDir, 'package-lock.json'));
const installedPackageLock = readFileIfExists(installMarkerPath);
const hasNodeModules = fs.existsSync(path.join(stageDir, 'node_modules'));
const hasRequiredDependencies = hasNodeModules && hasAllProductionDependencies(stageDir);

if (!installedPackageLock && hasRequiredDependencies && rootPackageLock) {
  fs.writeFileSync(installMarkerPath, rootPackageLock);
}

const needsInstall =
  !hasRequiredDependencies ||
  !rootPackageLock ||
  (installedPackageLock !== null && rootPackageLock !== installedPackageLock);

if (needsInstall) {
  run('npm', ['install'], stageDir);
  if (rootPackageLock) {
    fs.writeFileSync(installMarkerPath, rootPackageLock);
  }
}

run('npm', ['run', 'rebuild:native'], stageDir);
run('npx', ['electron-builder', '--win', 'portable'], stageDir);

removeIfExists(rootDistDir);
fs.mkdirSync(rootDistDir, { recursive: true });
fs.cpSync(stageDistDir, rootDistDir, { recursive: true, force: true });

console.log(`\nCopied staged dist output to ${rootDistDir}`);
