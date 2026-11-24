import test from 'node:test';
import assert from 'node:assert/strict';
import { sign,verify,seal,unseal,esc,validateLine,sarvamBody,decodeWav,countChars,boundedInt } from '../src/core.js';
const secret='test-only-secret-never-use-in-production-00000000';
test('signed audio links reject modifications and other signing keys',async()=>{
  const value='audio:test.wav:123';const sig=await sign(secret,value);
  assert.equal(await verify(secret,value,sig),true);
  assert.equal(await verify(secret,value+'4',sig),false);
  assert.equal(await verify(secret+'different',value,sig),false);
  assert.equal(await verify(secret,value,'not!base64'),false);
});
test('consent ticket integrity and expiry',async()=>{
  const v={query:'?client_id=abc',nonce:'test',exp:Date.now()+10000};
  const t=await seal(secret,v);assert.deepEqual(await unseal(secret,t),v);
  await assert.rejects(unseal(secret,t+'x'));
  await assert.rejects(unseal(secret,await seal(secret,{...v,exp:Date.now()-1000})));
});
test('Gujarati body, validation, and voice model selection',()=>{
  const l=validateLine({text:'ભાઈ, રજા જોઈએ છે!',model:'bulbul:v3',speaker:'ratan'});
  assert.deepEqual(sarvamBody(l),{text:'ભાઈ, રજા જોઈએ છે!',language_code:'gu-IN',model:'bulbul:v3',speaker:'ratan',pace:0.9,speech_sample_rate:24000,output_audio_codec:'wav'});
  assert.equal(validateLine({text:'હા'}).speaker,'pooja_gu_conversational');
  for(const x of [{text:'hello'},{text:'અ'.repeat(601)},{text:'હા',pace:2},{text:'હા',model:'fake'},{text:'હા',speaker:'ratan'},{text:'હા',speaker:'bad/path'}]) assert.throws(()=>validateLine(x));
  assert.equal(countChars('😀'),1);
});
test('WAV decoder computes duration and rejects invalid audio',()=>{
  const b=Buffer.alloc(44+48000);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(48000,40);
  assert.equal(decodeWav(b.toString('base64')).duration_seconds,1);
  assert.throws(()=>decodeWav('aGVsbG8='));assert.throws(()=>decodeWav(b.subarray(0,100).toString('base64')));
});
test('HTML escaping and bounded configuration',()=>{assert.equal(esc('<script>"&'), '&lt;script&gt;&quot;&amp;');assert.equal(boundedInt('abc',24,1,48),24);assert.equal(boundedInt('48',24,1,48),48);});
