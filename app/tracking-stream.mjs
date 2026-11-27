import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

export async function trackingStream(file, id, gitDirectory, sourceCommit) {
  if ((await stat(file)).size > 1024) return createReadStream(file);
  const hash = (await readFile(file, 'utf8')).match(/oid sha256:([a-f0-9]{64})/)?.[1];
  if (hash && gitDirectory) {
    const object = path.join(gitDirectory, 'lfs', 'objects', hash.slice(0, 2), hash.slice(2, 4), hash);
    if (await stat(object).then(() => true, () => false)) return createReadStream(object);
  }
  const base = 'https://media.githubusercontent.com/media/misoverfitting/soccer_data';
  const response = await fetch(`${base}/${sourceCommit}/data/matches/${id}/${path.basename(file)}`);
  if (!response.ok) throw new Error(`Tracking download for ${id} returned ${response.status}`);
  return Readable.fromWeb(response.body);
}
