import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { passingData } from '../passing-data.mjs';
import { optimizeDefense } from '../public/defensive-position-optimizer.js';
import { buildIntegrity } from '../public/integrity.js';
import { plausibleSamples, summarizePath } from '../public/optimizer-path.js';
import { POSSESSION_HOLD_FRAMES } from '../public/possession.js';
import { trackingStream } from '../tracking-stream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogue = JSON.parse(await readFile(path.join(root, 'app/chance-catalogue.json'), 'utf8'));

async function analyzeMatch(id, gitDirectory) {
  const clips = catalogue.matches[id].filter(clip => clip.highDanger);
  const prefix = path.join(root, 'data', 'matches', id, id);
  const meta = JSON.parse(await readFile(`${prefix}_match.json`, 'utf8'));
  const data = await passingData(root, id, meta);
  const needed = new Set(clips.flatMap(clip => Array.from(
    { length: clip.endFrame - clip.startFrame + POSSESSION_HOLD_FRAMES + 3 },
    (_, i) => clip.startFrame - POSSESSION_HOLD_FRAMES + i,
  )));
  const tracking = new Map();
  const stream = await trackingStream(`${prefix}_tracking_extrapolated.jsonl`, id, gitDirectory, catalogue.sourceCommit);
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (needed.has(frame.frame) && frame.timestamp != null) tracking.set(frame.frame, frame);
  }

  const roster = new Map(meta.players.map(player => [player.id, player.team_id]));
  const groupTeam = { 'home team': meta.home_team.id, 'away team': meta.away_team.id };
  const teamAt = frame => roster.get(frame.possession?.player_id) ?? groupTeam[frame.possession?.group];
  const heldTeam = new Map();
  for (const frame of tracking.values()) {
    const prev = tracking.get(frame.frame - 1);
    const prior = prev?.period === frame.period ? heldTeam.get(prev.frame) : null;
    const team = teamAt(frame);
    if (team != null) heldTeam.set(frame.frame, { team, age: 0 });
    else if (prior && prior.age + 1 < POSSESSION_HOLD_FRAMES) {
      heldTeam.set(frame.frame, { team: prior.team, age: prior.age + 1 });
    }
  }

  const rows = [];
  const seen = new Map();
  const counts = { clips: clips.length, emptyClips: 0, windows: 0, possession: 0, unavailable: 0, duplicates: 0 };
  for (const clip of clips) {
    const frames = Array.from({ length: clip.count }, (_, i) => tracking.get(clip.startFrame + i))
      .filter(frame => frame?.period === clip.period);
    if (!frames.length) {
      counts.emptyClips++;
      continue;
    }
    const group = clip.teamId === meta.home_team.id ? 'home team' : 'away team';
    const epv = frame => buildIntegrity(
      { ...frame, possession: { group } },
      tracking.get(frame.frame - 2), tracking.get(frame.frame + 2), meta, data,
    ).ballValue;
    const samples = plausibleSamples(frames, meta, data.physical);
    for (const sample of samples) {
      const start = tracking.get(sample.frame);
      const end = tracking.get(sample.frame + 10);
      if (!start || !end || end.frame > clip.endFrame || end.period !== clip.period) continue;
      counts.windows++;
      // Reject even a single opposing-possession frame inside the action.
      const continuous = Array.from({ length: 11 }, (_, i) => start.frame + i)
        .every(frame => tracking.get(frame)?.period === clip.period && heldTeam.get(frame)?.team === clip.teamId);
      if (!continuous) {
        counts.possession++;
        continue;
      }
      const key = `${clip.period}:${start.frame}:${clip.teamId}`;
      if (seen.has(key)) {
        seen.get(key).clips.push(clip.id);
        counts.duplicates++;
        continue;
      }
      if (!sample.scene) {
        counts.unavailable++;
        continue;
      }
      const startEpv = epv(start), endEpv = epv(end);
      let optimum;
      try {
        optimum = optimizeDefense({ ...sample.scene, metric: 'integrity' }, data, { direction: 'maximum' }).maximum;
      } catch (error) {
        if (!/spacing|feasible|layout/i.test(error.message)) throw error;
        counts.unavailable++;
        continue;
      }
      const [{ alignment }] = summarizePath([sample], [optimum]);
      if (![alignment, startEpv, endEpv].every(Number.isFinite)) {
        counts.unavailable++;
        continue;
      }
      const row = {
        match: id, period: clip.period, frame: start.frame, time: start.timestamp,
        defendingTeam: group === 'home team' ? meta.away_team.name : meta.home_team.name,
        clips: [clip.id], optimizationDegree: alignment, startEpv, endEpv, epvChange: endEpv - startEpv,
      };
      seen.set(key, row);
      rows.push(row);
    }
  }
  return { id, counts, rows };
}

if (!isMainThread) {
  for (const id of workerData.ids) parentPort.postMessage(await analyzeMatch(id, workerData.gitDirectory));
} else {
  const ids = process.argv.slice(2);
  if (!ids.length) ids.push(...Object.keys(catalogue.matches));
  const gitDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const count = Math.min(ids.length, availableParallelism(), 12);
  await Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { ids: ids.filter((_, index) => index % count === i), gitDirectory },
    });
    worker.on('message', result => console.log(JSON.stringify(result)));
    worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited with code ${code}`)));
  })));
}
