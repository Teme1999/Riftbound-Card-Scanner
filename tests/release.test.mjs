import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildVersions } from '../.github/scripts/bump-release-version.mjs';
import { prepareUpdateRelease } from '../.github/scripts/prepare-update-release.mjs';
import { validateUpdateFeed, validateSigningKey } from '../scripts/validate-update-feed.mjs';

const version = '26.10.2601', releaseVersion = '2026.10.26.1';
function signingData(id=1, signature=false) {
  const packet = Buffer.alloc(signature?74:42); packet.write('Ed'); packet.fill(id,2,10);
  return Buffer.from(`untrusted comment: test\n${packet.toString('base64')}\n`).toString('base64');
}

test('MSI and semantic versions increase for same-day releases and date boundaries', () => {
  const first = buildVersions({year:2026,month:10,day:26},1), second = buildVersions({year:2026,month:10,day:26},2);
  assert.equal(first.semver,version); assert.equal(first.wixVersion,version);
  assert.equal(second.semver,'26.10.2602');
  assert.equal(buildVersions({year:2026,month:10,day:27},1).semver,'26.10.2701');
  assert.equal(buildVersions({year:2026,month:11,day:1},1).semver,'26.11.101');
  assert.throws(() => buildVersions({year:2026,month:2,day:31},1));
  assert.throws(() => buildVersions({year:2026,month:10,day:26},100));
});

test('signing metadata must use the configured public key', () => {
  validateSigningKey(signingData(1,true),signingData(1));
  assert.throws(() => validateSigningKey(signingData(2,true),signingData(1)),/different signing key/);
});

test('release packaging uses GitHub-safe names and validates exact signed sidecars', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'riftbound-release-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    await fs.rm(root,{recursive:true,force:true});
  });
  const directory = path.join(root,'src-tauri/target/release/bundle/msi'), output=path.join(root,'output');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version,releaseVersion}));
  await fs.writeFile(path.join(root,'src-tauri/tauri.conf.json'),JSON.stringify({version,plugins:{updater:{pubkey:signingData()}}}));
  const name = 'Riftbound Scanner_raw.msi';
  await fs.writeFile(path.join(directory,name),'test installer bytes');
  await fs.writeFile(path.join(directory,`${name}.sig`),signingData(1,true));
  await prepareUpdateRelease({root,output,repository:'owner/repo',tag:`v${releaseVersion}`});
  const feed=JSON.parse(await fs.readFile(path.join(output,'latest.json'),'utf8'));
  assert.ok(feed.platforms['windows-x86_64'].url.endsWith('RiftboundScanner_2026.10.26.1_x64_en-US.msi'));
  await validateUpdateFeed(feed,{directory:output,version,publicKey:signingData()});
  const broken=structuredClone(feed); broken.platforms['windows-x86_64'].url=broken.platforms['windows-x86_64'].url.replace('RiftboundScanner','Riftbound%20Scanner');
  await assert.rejects(validateUpdateFeed(broken),/normalization/);
  await fs.writeFile(path.join(output,'RiftboundScanner_2026.10.26.1_x64_en-US.msi.sig'),'wrong signature');
  await assert.rejects(validateUpdateFeed(feed,{directory:output}),/sidecar/);
});
