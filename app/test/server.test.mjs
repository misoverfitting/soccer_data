import {test,after} from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';
const {server}=await import('../server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
after(()=>new Promise(resolve=>server.close(resolve)));
const base=`http://127.0.0.1:${server.address().port}`;
test('deployment health, static app, demo and match catalogue',async()=>{for(const p of ['/health','/','/client.js','/geometry.js','/d3-delaunay.min.js','/demo.json'])assert.equal((await fetch(base+p)).status,200,p);const matches=await (await fetch(base+'/api/matches')).json();assert.equal(matches.length,20);const m=await(await fetch(base+'/api/matches/1886347/metadata')).json();assert.equal(m.pitch_length,104);const phases=await(await fetch(base+'/api/matches/1886347/phases')).json();assert.equal(phases[0].frame_start,'28');});
test('reject unknown matches, invalid bounds and arbitrary file paths',async()=>{for(const p of ['/api/matches/1/metadata','/package.json'])assert.equal((await fetch(base+p)).status,404);assert.equal((await fetch(base+'/api/matches/1886347/clip?count=999999')).status,400);});
