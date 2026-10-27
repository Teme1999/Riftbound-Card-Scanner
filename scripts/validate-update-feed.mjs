import fs from 'node:fs/promises';
import path from 'node:path';

function signingPacket(value, size) {
  const text = Buffer.from(String(value).trim(), 'base64').toString('utf8');
  const packet = Buffer.from(text.split(/\r?\n/)[1] || '', 'base64');
  if (packet.length !== size) throw new Error('Invalid updater signing data.');
  return packet;
}

export function validateSigningKey(signature, publicKey) {
  const key = signingPacket(publicKey, 42), signed = signingPacket(signature, 74);
  if (!key.subarray(2, 10).equals(signed.subarray(2, 10))) {
    throw new Error('Updater signature uses a different signing key from tauri.conf.json.');
  }
  // This checks format/key identity. Tauri verifies the cryptographic signature
  // over the actual downloaded package before allowing installation.
}

export async function validateUpdateFeed(feed, { directory, publicKey, version, repository, tag } = {}) {
  if (!feed?.version || (version && feed.version !== version)) throw new Error('Updater version mismatch.');
  const entries = Object.entries(feed.platforms || {});
  if (!entries.some(([key]) => key === 'windows-x86_64')) throw new Error('Missing Windows x64 updater target.');
  for (const [, entry] of entries) {
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('Unexpected updater URL.');
    if (repository && tag && !url.pathname.startsWith(`/${repository}/releases/download/${tag}/`)) throw new Error('Updater release URL mismatch.');
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Updater filename must survive GitHub asset name normalization.');
    if (publicKey) validateSigningKey(entry.signature, publicKey);
    if (directory) {
      const artifact = await fs.stat(path.join(directory, name));
      if (!artifact.isFile() || !artifact.size) throw new Error('Empty updater artifact.');
      const signature = (await fs.readFile(path.join(directory, `${name}.sig`), 'utf8')).trim();
      if (signature !== entry.signature) throw new Error('Updater signature does not match its artifact sidecar.');
    }
  }
  return feed;
}
