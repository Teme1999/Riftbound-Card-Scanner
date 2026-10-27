import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const PACKAGE_LOCK_PATH = path.join(ROOT, 'package-lock.json');
const TAURI_CONFIG_PATH = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const CARGO_TOML_PATH = path.join(ROOT, 'src-tauri', 'Cargo.toml');

function parseArgs(argv) {
  const options = {
    date: null,
    index: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length);
    } else if (arg.startsWith('--index=')) {
      options.index = Number.parseInt(arg.slice('--index='.length), 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDate(value) {
  if (!value) {
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
    };
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error('Expected --date=YYYY-MM-DD.');
  }

  const [, year, month, day] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function nextReleaseIndex(currentReleaseVersion, dateParts, requestedIndex) {
  if (requestedIndex !== null) {
    if (!Number.isInteger(requestedIndex) || requestedIndex < 1) {
      throw new Error('Expected --index to be a positive integer.');
    }
    return requestedIndex;
  }

  const prefix = `${dateParts.year}.${pad2(dateParts.month)}.${pad2(dateParts.day)}.`;
  if (typeof currentReleaseVersion === 'string' && currentReleaseVersion.startsWith(prefix)) {
    const currentIndex = Number.parseInt(currentReleaseVersion.slice(prefix.length), 10);
    if (Number.isInteger(currentIndex) && currentIndex > 0) {
      return currentIndex + 1;
    }
  }

  return 1;
}

export function buildVersions(dateParts, index) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
  if (dateParts.year < 2000 || dateParts.year > 2099 || date.getUTCFullYear() !== dateParts.year ||
    date.getUTCMonth() + 1 !== dateParts.month || date.getUTCDate() !== dateParts.day ||
    !Number.isInteger(index) || index < 1 || index > 99) throw new Error('Expected a valid date and release index 1-99.');
  const releaseVersion = `${dateParts.year}.${pad2(dateParts.month)}.${pad2(dateParts.day)}.${index}`;
  const shortYear = String(dateParts.year).slice(-2);
  // MSI ignores a fourth component. Pack day/index into the third component so
  // both MSI and semantic version comparisons increase on same-day releases.
  const semver = `${Number(shortYear)}.${dateParts.month}.${dateParts.day * 100 + index}`;
  const wixVersion = semver;

  return { releaseVersion, semver, wixVersion };
}

function replaceCargoPackageVersion(cargoToml, semver) {
  const next = cargoToml.replace(/^version = "([^"]+)"$/m, `version = "${semver}"`);
  if (next === cargoToml) {
    throw new Error('Could not find package version in src-tauri/Cargo.toml.');
  }
  return next;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = readJson(PACKAGE_PATH);
  const packageLock = fs.existsSync(PACKAGE_LOCK_PATH) ? readJson(PACKAGE_LOCK_PATH) : null;
  const tauriConfig = readJson(TAURI_CONFIG_PATH);
  const cargoToml = fs.readFileSync(CARGO_TOML_PATH, 'utf8');

  const dateParts = parseDate(options.date);
  const index = nextReleaseIndex(packageJson.releaseVersion, dateParts, options.index);
  const versions = buildVersions(dateParts, index);

  const nextPackageJson = {
    ...packageJson,
    version: versions.semver,
    releaseVersion: versions.releaseVersion,
  };
  const nextPackageLock = packageLock
    ? {
        ...packageLock,
        version: versions.semver,
        packages: {
          ...packageLock.packages,
          '': {
            ...packageLock.packages?.[''],
            version: versions.semver,
          },
        },
      }
    : null;
  const nextTauriConfig = {
    ...tauriConfig,
    version: versions.semver,
    bundle: {
      ...tauriConfig.bundle,
      windows: {
        ...tauriConfig.bundle.windows,
        wix: {
          ...tauriConfig.bundle.windows.wix,
          version: versions.wixVersion,
        },
      },
    },
  };
  const nextCargoToml = replaceCargoPackageVersion(cargoToml, versions.semver);

  console.log(`package/version: ${packageJson.version} -> ${versions.semver}`);
  if (packageLock) {
    console.log(`package-lock/version: ${packageLock.version} -> ${versions.semver}`);
  }
  console.log(`package/releaseVersion: ${packageJson.releaseVersion} -> ${versions.releaseVersion}`);
  console.log(`tauri/version: ${tauriConfig.version} -> ${versions.semver}`);
  console.log(`tauri/bundle/windows/wix/version: ${tauriConfig.bundle.windows.wix.version} -> ${versions.wixVersion}`);
  console.log(`cargo/package/version -> ${versions.semver}`);

  writeJson(PACKAGE_PATH, nextPackageJson);
  if (nextPackageLock) {
    writeJson(PACKAGE_LOCK_PATH, nextPackageLock);
  }
  writeJson(TAURI_CONFIG_PATH, nextTauriConfig);
  fs.writeFileSync(CARGO_TOML_PATH, nextCargoToml);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
