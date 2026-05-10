import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const requiredFiles = [
  'public/card-hashes.json',
  'public/models/yolo11n-obb-riftbound.onnx',
  'public/models/yolo11n-obb-riftbound-q8.onnx',
];

const failures = [];

async function requireFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size <= 0) {
      failures.push(`${relativePath} is empty or is not a file.`);
    }
  } catch {
    failures.push(`${relativePath} is missing.`);
  }
}

for (const file of requiredFiles) {
  await requireFile(file);
}

try {
  const cardFiles = await readdir(path.join(root, 'public/cards'));
  const webpCount = cardFiles.filter((file) => file.toLowerCase().endsWith('.webp')).length;
  if (webpCount === 0) {
    failures.push('public/cards does not contain any .webp card images.');
  }
} catch {
  failures.push('public/cards is missing.');
}

if (failures.length > 0) {
  console.error('Runtime asset preflight failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error('\nGenerate or restore the ignored runtime assets before building for production.');
  process.exit(1);
}

console.log('Runtime asset preflight passed.');
