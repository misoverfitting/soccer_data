import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as geometry from '../public/geometry.js';
import * as danger from '../public/danger.js';
test('client selector loads chance bounds and jump button finds outcome frame',async()=>{
 const demo=JSON.parse(await readFile(new URL('../public/demo.json',import.meta.url),'utf8'));
 const catalogue=JSON.parse(await readFile(new URL('../chance-catalogue.json',import.meta.url),'utf8'));
 const chances=catalogue.matches['1886347'];
 const requests=[],els=new Map();
 const context2d=new Proxy({},{get:()=>()=>{}});
 const element=id=>{if(!els.has(id)){const e={id,value:({team:'all',colour:'danger',duration:'30',speed:'1',chanceFilter:'high',start:'10'})[id]??'',checked:id==='ball',options:[],textContent:'',hidden:false,disabled:false,addEventListener(){},getBoundingClientRect(){return {width:1000,height:625};},getContext(){return context2d;},scrollIntoView(){},add(o){this.options.push(o);},replaceChildren(...options){this.options=options;this.value=options[0]?.value??'';}};Object.defineProperty(e,'selectedOptions',{get:()=>e.options.filter(o=>o.value===e.value)});els.set(id,e);}return els.get(id);};
 const sandbox={...geometry,...danger,devicePixelRatio:1,performance:{now:()=>0},requestAnimationFrame(){},window:{matchMedia:()=>({matches:false}),addEventListener(){}},document:{getElementById:element},Option:class{constructor(text,value){this.textContent=text;this.value=value;}},fetch:async url=>{
 requests.push(url);let data;if(url==='/demo.json')data=demo;else if(url==='/api/matches')data=[{id:1886347,label:'Test match'}];else if(url.endsWith('/metadata'))data=demo.metadata;else if(url.endsWith('/phases'))data=[];else if(url.endsWith('/chances'))data={chances};else if(url.includes('/clip?')){const u=new URL(url,'http://test'),start=Number(u.searchParams.get('start'));data=demo.frames.slice(0,281).map((f,i)=>({...f,frame:start+i,period:2}));}else throw Error(url);return {ok:true,json:async()=>data};}};
 vm.runInNewContext(await readFile(new URL('../public/d3-delaunay.min.js',import.meta.url),'utf8'),sandbox);
 const client=(await readFile(new URL('../public/client.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
 await vm.runInNewContext(`(async()=>{${client}\n})()`,sandbox);
 assert.equal(element('chance').options.length,1+chances.filter(c=>c.highDanger).length);
 const goal=chances.find(c=>c.outcome==='goal');element('chance').value=goal.id;await element('chance').onchange();
 const req=requests.find(r=>r.includes('/clip?'));assert.ok(req.includes(`end=${goal.endFrame}`));assert.ok(req.includes('period=2'));assert.equal(element('jumpShot').hidden,false);assert.match(element('chanceStage').textContent,/20.0 s before/);
 element('jumpShot').onclick();assert.equal(element('frame').textContent,goal.anchorFrame);assert.match(element('chanceStage').textContent,/0.0 s after/);
 element('chanceFilter').value='goals';element('chanceFilter').onchange();assert.equal(element('chance').options.length,1+chances.filter(c=>c.outcome==='goal').length);
});
