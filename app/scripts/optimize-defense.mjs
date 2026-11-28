import { readFile } from 'node:fs/promises';
import { optimizeDefense } from '../public/defensive-position-optimizer.js';

try {
  const [input] = process.argv.slice(2);
  if (!input || process.argv.length !== 3) {
    throw new Error('Usage: node app/scripts/optimize-defense.mjs scene.json');
  }
  const [scene, settingsFile, valueModel, carryFit] = await Promise.all([
    readFile(input, 'utf8').then(JSON.parse),
    readFile(new URL('../../notebooks/fitted/pitch_control_settings.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../notebooks/fitted/value_model.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../notebooks/fitted/carry_model.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const { hazard, carry_speed, def_delay, fracs, max_duration_s } = carryFit;
  const carryModel = { hazard, carry_speed, def_delay, fracs, max_duration_s, ball_dist_m: 1.5 };
  const result = optimizeDefense(scene, { settings: settingsFile.settings, valueModel, carryModel });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
