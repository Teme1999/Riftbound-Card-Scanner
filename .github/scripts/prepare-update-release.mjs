import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUpdateFeed } from '../../scripts/validate-update-feed.mjs';

async function filesUnder(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes:true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(filename));
    else files.push(filename);
  }
  return files;
}

export async function prepareUpdateRelease({ root = process.cwd(), output, repository, tag, now = new Date() }) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (pkg.version !== config.version || tag !== `v${pkg.releaseVersion}`) throw new Error('Release version files/tag disagree.');
  const files = await filesUnder(path.join(root, 'src-tauri/target/release/bundle/msi'));
  const candidates = [];
  for (const file of files.filter((filename) => /\.msi(?:\.zip)?$/i.test(filename))) {
    if (files.includes(`${file}.sig`)) candidates.push({ file, time:(await fs.stat(file)).mtimeMs });
  }
  candidates.sort((a,b) => Number(b.file.endsWith('.zip')) - Number(a.file.endsWith('.zip')) || b.time - a.time);
  if (!candidates.length) throw new Error('No signed MSI updater artifact was produced.');
  const updater = candidates[0].file;
  const installer = updater.endsWith('.msi') ? updater : files.find((file) => file.endsWith('.msi'));
  if (!installer) throw new Error('No MSI installer was produced.');
  await fs.mkdir(output, { recursive:true });
  const base = `RiftboundScanner_${pkg.releaseVersion}_x64_en-US.msi`;
  await fs.copyFile(installer, path.join(output, base));
  const updaterName = base + (updater.endsWith('.zip') ? '.zip' : '');
  await fs.copyFile(updater, path.join(output, updaterName));
  await fs.copyFile(`${updater}.sig`, path.join(output, `${updaterName}.sig`));
  const signature = (await fs.readFile(`${updater}.sig`, 'utf8')).trim();
  const entry = { signature, url:`https://github.com/${repository}/releases/download/${tag}/${updaterName}` };
  const feed = { version:pkg.version, notes:'See the GitHub release notes for this version.', pub_date:now.toISOString(),
    platforms:{ 'windows-x86_64':entry, 'windows-x86_64-msi':entry } };
  await validateUpdateFeed(feed, { directory:output, version:pkg.version, repository, tag, publicKey:config.plugins.updater.pubkey });
  await fs.writeFile(path.join(output, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  return { dir:output, artifact_name:`riftbound-installer-${pkg.releaseVersion}`, files:`${output}/*` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const index = arg.indexOf('='); return [arg.slice(2,index), arg.slice(index+1)];
  }));
  const result = await prepareUpdateRelease(args);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key,value]) => `${key}=${value}\n`).join(''));
  }
  console.log('Signed release artifacts and updater manifest validated.');
}
