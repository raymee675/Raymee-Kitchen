import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCommand,timer,gesture,parseCommand,clampPosition,overlaps,clockSample,OVAL_RX,OVAL_RY} from '../lib/kitchen-model.ts';
const id='10000000-0000-4000-8000-000000000001';
const base={id,plate:1,x:.5,y:.5,duration:100,startedAt:null,version:1};
const cmd=(type,extra={})=>({operationId:crypto.randomUUID(),id,type,expectedVersion:1,...extra});
test('slow database work is not added to estimated network latency',()=>{
 const sample=clockSample(13000,10000,3100);
 assert.equal(sample.networkRtt,100); assert.equal(sample.estimatedNow,13050);
 assert.equal(clockSample(13000,10000,2900).networkRtt,0);
});
test('empty -> running -> half white -> exactly zero; no early finish',()=>{
 const [item]=applyCommand([base],cmd('start'),10000);
 assert.equal(timer(item,10000).remaining,100);
 assert.equal(timer(item,60000).progress,.5);
 assert.equal(timer(item,109999).remaining,1);
 assert.equal(timer(item,109999).state,'running');
 assert.equal(timer(item,110000).state,'done');
 assert.equal(timer(item,999999).remaining,0);
});
test('double start preserves the first timestamp',()=>{
 const initial=applyCommand([base],cmd('start'),10000);
 assert.deepEqual(applyCommand(initial,cmd('start'),13000),initial);
});
test('adjust duration, keep start, and reject stale item version',()=>{
 const started={...base,startedAt:10000,version:2};
 const [item]=applyCommand([started],cmd('adjust',{expectedVersion:2,delta:1}),30000);
 assert.equal(item.startedAt,10000); assert.equal(item.duration,101); assert.equal(timer(item,30000).remaining,81);
 assert.throws(()=>applyCommand([item],cmd('adjust',{expectedVersion:2,delta:1}),30000),e=>e.code==='conflict');
});
test('90 and 110 boundaries; finished timers cannot be revived',()=>{
 for(const [duration,delta] of [[90,-1],[110,1]]) assert.throws(()=>applyCommand([{...base,startedAt:0,duration}],cmd('adjust',{delta}),2000),e=>e.code==='duration_limit');
 assert.throws(()=>applyCommand([{...base,startedAt:0}],cmd('adjust',{delta:1}),100000),e=>e.code==='not_running');
});
test('shortening can finish immediately; only finished objects can be removed',()=>{
 const [item]=applyCommand([{...base,startedAt:0}],cmd('adjust',{delta:-1}),99500);
 assert.equal(timer(item,99500).state,'done');
 assert.deepEqual(applyCommand([item],cmd('remove',{expectedVersion:2}),99500),[]);
 assert.throws(()=>applyCommand([base],cmd('remove'),100000),e=>e.code==='not_finished');
});
test('placement is clamped and collisions are rejected per plate',()=>{
 const position=clampPosition(0,1); assert.equal(position.x,OVAL_RX+.02); assert.equal(position.y,1-OVAL_RY-.02);
 assert.equal(overlaps(base,{x:.51,y:.5}),true);
 assert.throws(()=>applyCommand([base],cmd('create',{id:crypto.randomUUID(),plate:1,x:.5,y:.5}),0),e=>e.code==='overlap');
 assert.equal(applyCommand([base],cmd('create',{id:crypto.randomUUID(),plate:2,x:.5,y:.5}),0).length,2);
});
test('swipes do not also tap; roundtrip drag does not create objects',()=>{
 assert.equal(gesture(0,0,0),'tap'); assert.equal(gesture(35,0,35),'right');
 assert.equal(gesture(-35,0,35),'left'); assert.equal(gesture(0,-35,35),'up');
 assert.equal(gesture(35,-35,50),'none'); assert.equal(gesture(1,1,80),'none');
});
test('untrusted command coordinates, IDs, durations are validated',()=>{
 assert.throws(()=>parseCommand(cmd('create',{plate:1,x:NaN,y:.5})),e=>e.code==='invalid');
 assert.throws(()=>parseCommand(cmd('adjust',{delta:2})),e=>e.code==='invalid');
 assert.throws(()=>parseCommand(cmd('start',{id:'not-a-uuid'})),e=>e.code==='invalid');
 assert.equal(parseCommand(cmd('adjust',{delta:1})).delta,1);
});
