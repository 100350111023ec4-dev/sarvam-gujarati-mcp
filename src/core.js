// Pure helpers; no Cloudflare or MCP imports, so these are testable in Node.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const voices = {
  'bulbul:v4-flash': ['pooja_gu_conversational','pooja_gu_customer','aditya_hi_conversational','dev_en_conversational','ratan_hi_customer_expressive'],
  'bulbul:v3': ['ratan','priya','ritu','shubh','rohan']
};
export function b64url(bytes) {
  let raw = ''; for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function unb64url(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
}
async function hmacKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Missing signing secret');
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function sign(secret, text) { return b64url(new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(secret),encoder.encode(text)))); }
export async function verify(secret,text,sig) {
  try { return await crypto.subtle.verify('HMAC',await hmacKey(secret),unb64url(sig),encoder.encode(text)); } catch { return false; }
}
export async function seal(secret, value) {
  const body = b64url(encoder.encode(JSON.stringify(value)));
  return `${body}.${await sign(secret,'consent:'+body)}`;
}
export async function unseal(secret,ticket) {
  if(typeof ticket!=='string'||ticket.length>16000) throw new Error('Invalid consent');
  const parts=ticket.split('.');
  if(parts.length!==2 || !await verify(secret,'consent:'+parts[0],parts[1])) throw new Error('Invalid consent');
  const obj=JSON.parse(decoder.decode(unb64url(parts[0])));
  if (!Number.isSafeInteger(obj.exp)||obj.exp < Date.now()) throw new Error('Expired consent');
  return obj;
}
export function esc(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function countChars(s) { return Array.from(s).length; }
export function validateLine(line) {
  if (!line || typeof line.text!=='string'||!line.text.trim()||countChars(line.text)>600) throw new Error('Each line must have 1–600 characters.');
  if (!/[\u0A80-\u0AFF]/u.test(line.text)) throw new Error('Use Gujarati script (gu-IN).');
  const model=line.model??'bulbul:v4-flash';
  if (!Object.hasOwn(voices,model)) throw new Error('Unsupported model.');
  const speaker=line.speaker??(model==='bulbul:v3'?'ratan':'pooja_gu_conversational');
  // Allow valid-looking catalogue IDs; Sarvam validates exact availability.
  if (typeof speaker!=='string' || speaker.length>100 || !(model==='bulbul:v3'?/^[a-z][a-z0-9]*$/:/^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,5}$/).test(speaker)) throw new Error('Invalid speaker ID for model.');
  const pace=line.pace??0.9;
  if(typeof pace!=='number'||!Number.isFinite(pace)||pace<0.7||pace>1.2) throw new Error('Pace must be 0.7–1.2.');
  return { text:line.text.trim(), model,speaker,pace };
}
export function sarvamBody(line) {
  return { text:line.text, language_code:'gu-IN', model:line.model, speaker:line.speaker, pace:line.pace, speech_sample_rate:24000, output_audio_codec:'wav' };
}
export function decodeWav(b64) {
  if(typeof b64!=='string'||b64.length>20_000_000) throw new Error('Invalid audio response size.');
  const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  const view=new DataView(bytes.buffer);
  const str=(i,n)=>String.fromCharCode(...bytes.slice(i,i+n));
  if(bytes.length<44||str(0,4)!=='RIFF'||str(8,4)!=='WAVE') throw new Error('Sarvam did not return a WAV file.');
  let rate=0,data=0;
  for(let p=12;p+8<=bytes.length;) {
    const tag=str(p,4),size=view.getUint32(p+4,true); if(p+8+size>bytes.length) throw new Error('Truncated WAV.');
    if(tag==='fmt '&&size>=16) rate=view.getUint32(p+16,true);
    if(tag==='data') data+=size;
    p+=8+size+(size%2);
  }
  if(!rate||!data) throw new Error('WAV missing audio data.');
  return {bytes,duration_seconds:Math.round(data/rate*1000)/1000};
}
export function boundedInt(raw,fallback,min,max) { const n=Number(raw); return Number.isInteger(n)&&n>=min&&n<=max?n:fallback; }
