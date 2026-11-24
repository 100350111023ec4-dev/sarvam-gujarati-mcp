import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { voices, sign, verify, seal, unseal, esc, countChars, validateLine, sarvamBody, decodeWav, boundedInt } from './core.js';

// Atomically reserve quota before sending billable API calls. Failed calls count
// too, because an upstream timeout does not prove that Sarvam did not bill it.
export class UsageLimiter extends DurableObject {
  async fetch(request) {
    const {type, chars=0, calls=0}=await request.json();
    const auth=type==='login';
    const key=auth?'login':'speech';
    const period=auth?Math.floor(Date.now()/3600000):Math.floor(Date.now()/86400000);
    const maxChars=boundedInt(this.env.DAILY_CHAR_LIMIT,6000,1,100000);
    const maxCalls=boundedInt(this.env.DAILY_REQUEST_LIMIT,40,1,1000);
    const result=await this.ctx.storage.transaction(async tx=>{
      let state=await tx.get(key);
      if(!state||state.period!==period) state={period,chars:0,calls:0};
      if(auth) { if(state.calls>=15) return {ok:false}; state.calls++; }
      else { if(state.chars+chars>maxChars||state.calls+calls>maxCalls) return {ok:false}; state.chars+=chars; state.calls+=calls; }
      await tx.put(key,state); return {ok:true,used:state};
    });
    return Response.json(result);
  }
}
async function reserve(env,type,chars=0,calls=0) {
  const stub=env.LIMITER.get(env.LIMITER.idFromName('single-owner'));
  const r=await stub.fetch('https://internal.invalid/reserve',{method:'POST',body:JSON.stringify({type,chars,calls})});
  if(!r.ok) throw new Error('Usage limiter unavailable. No speech generated.');
  return (await r.json()).ok;
}
const headers={ 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
const page=(body,status=200,cookie)=>new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sarvam MCP authorization</title><style>body{font:16px system-ui;max-width:480px;margin:12vh auto;padding:24px;color:#182432;background:#f7f9fc}main{background:white;padding:24px;border:1px solid #d8dfe8;border-radius:12px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0}button{background:#124978;color:white;border:0;border-radius:6px}small{overflow-wrap:anywhere;display:block;color:#42566b}</style><main>${body}</main></html>`,{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8',...(cookie?{'Set-Cookie':cookie}:{})}});
const cookieName='__Host-sarvam-consent';
const clearCookie=`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
function configured(env) { return typeof env.SARVAM_API_KEY==='string'&&env.SARVAM_API_KEY.length>0&&typeof env.OWNER_PASSWORD==='string'&&env.OWNER_PASSWORD.length>=32&&typeof env.SIGNING_SECRET==='string'&&env.SIGNING_SECRET.length>=32&&env.OWNER_PASSWORD!==env.SIGNING_SECRET; }
async function passwordMatches(env,entered) {
  if(typeof entered!=='string'||entered.length>512) return false;
  return verify(env.SIGNING_SECRET,'password:'+entered,await sign(env.SIGNING_SECRET,'password:'+env.OWNER_PASSWORD));
}
async function serveAudio(request,env,url) {
  const match=/^\/audio\/([a-f0-9-]{36}\.wav)$/.exec(url.pathname);
  if(!match||!['GET','HEAD'].includes(request.method)) return new Response('Not found',{status:404,headers});
  const key=match[1],exp=Number(url.searchParams.get('exp')),sig=url.searchParams.get('sig')??'';
  if(!Number.isSafeInteger(exp)||exp<=Math.floor(Date.now()/1000)||!await verify(env.SIGNING_SECRET,`audio:${key}:${exp}`,sig)) return new Response('Link invalid or expired',{status:403,headers});
  const obj=await env.AUDIO.get('clips/'+key);
  if(!obj) return new Response('Audio not found',{status:404,headers});
  return new Response(request.method==='HEAD'?null:obj.body,{headers:{...headers,'Content-Type':'audio/wav','Content-Length':String(obj.size),'Content-Disposition':`inline; filename="${key}"`}});
}
const publicHandler={ async fetch(request,env) {
  const url=new URL(request.url);
  try {
    if(url.pathname==='/health'&&request.method==='GET') return Response.json({service:'sarvam-gujarati-mcp',ready:configured(env)},{status:configured(env)?200:503,headers});
    if(!configured(env)) return new Response('Server configuration incomplete',{status:503,headers});
    if(url.pathname.startsWith('/audio/')) return await serveAudio(request,env,url);
    if(url.pathname==='/'&&request.method==='GET') return page('<h1>Sarvam Gujarati MCP</h1><p>Private owner-only voice-generation service. Connect via OAuth at /mcp.</p>');
    if(url.pathname==='/authorize'&&request.method==='GET') {
      if(url.search.length>8000) return page('<h1>Request too long</h1>',400);
      const auth=await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client=await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
      if(!client) return page('<h1>Unknown OAuth client</h1>',400);
      const nonce=crypto.randomUUID();
      const ticket=await seal(env.SIGNING_SECRET,{query:url.search,nonce,exp:Date.now()+600000});
      return page(`<h1>Connect Gujarati voice generation</h1><p>This client will be allowed to use your paid Sarvam API within the configured quota.</p><small>Client: ${esc(client.clientName||auth.clientId)}<br>Redirect: ${esc(auth.redirectUri)}</small><p>Only approve a connection you initiated. Check the redirect host carefully.</p><form method="post" action="/authorize"><input type="hidden" name="ticket" value="${esc(ticket)}"><label>Owner password<input type="password" name="password" required autocomplete="current-password" maxlength="512"></label><button type="submit">Authorize voice generation</button></form>`,200,`${cookieName}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
    }
    if(url.pathname==='/authorize'&&request.method==='POST') {
      if(request.headers.get('Origin')!==url.origin) return page('<h1>Invalid origin</h1>',403,clearCookie);
      if(!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return page('<h1>Invalid form</h1>',400,clearCookie);
      const raw=await request.text(); if(raw.length>20000) return page('<h1>Request too long</h1>',413,clearCookie);
      const form=new URLSearchParams(raw);
      const ticket=await unseal(env.SIGNING_SECRET,form.get('ticket'));
      const nonce=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.split('=')[1];
      if(!nonce||nonce!==ticket.nonce) return page('<h1>Consent expired</h1><p>Restart connection from ChatGPT.</p>',403,clearCookie);
      if(!await reserve(env,'login')) return page('<h1>Too many authorization attempts</h1><p>Try again in the next UTC hour.</p>',429,clearCookie);
      if(!await passwordMatches(env,form.get('password'))) return page('<h1>Incorrect owner password</h1><p>Restart connection from ChatGPT.</p>',403,clearCookie);
      const auth=await env.OAUTH_PROVIDER.parseAuthRequest(new Request(url.origin+'/authorize'+ticket.query));
      const client=await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
      if(!client) return page('<h1>Unknown OAuth client</h1>',400,clearCookie);
      const scopes=(auth.scope||[]).filter(s=>s==='tts:generate');
      if((auth.scope||[]).some(s=>s!=='tts:generate')) return page('<h1>Unsupported scope</h1>',400,clearCookie);
      const {redirectTo}=await env.OAUTH_PROVIDER.completeAuthorization({request:auth,userId:'owner',metadata:{clientName:client.clientName||'MCP client'},scope:scopes,props:{userId:'owner',permission:'tts:generate'}});
      return new Response(null,{status:302,headers:{...headers,Location:redirectTo,'Set-Cookie':clearCookie}});
    }
    return new Response('Not found',{status:404,headers});
  } catch { return page('<h1>Request could not be completed</h1><p>Restart the connection or check your configuration.</p>',400,clearCookie); }
}};

async function makeClip(env,origin,line,index,role) {
  const r=await fetch('https://api.sarvam.ai/text-to-speech',{method:'POST',redirect:'error',headers:{'api-subscription-key':env.SARVAM_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(sarvamBody(line)),signal:AbortSignal.timeout(60000)});
  if(!r.ok) throw new Error(`Sarvam HTTP ${r.status}. Check key, balance, model, speaker or rate limit. Not automatically retried.`);
  const result=await r.json();
  const {bytes,duration_seconds}=decodeWav(result.audios?.[0]);
  const key=crypto.randomUUID()+'.wav';
  await env.AUDIO.put('clips/'+key,bytes,{httpMetadata:{contentType:'audio/wav'}});
  const expires=Math.floor(Date.now()/1000)+boundedInt(env.AUDIO_LINK_HOURS,24,1,48)*3600;
  const sig=await sign(env.SIGNING_SECRET,`audio:${key}:${expires}`);
  return {index,role,model:line.model,speaker:line.speaker,language:'gu-IN',pace:line.pace,text:line.text,duration_seconds,download_url:`${origin}/audio/${key}?exp=${expires}&sig=${sig}`,expires_at:new Date(expires*1000).toISOString(),request_id:result.request_id??null};
}
const reply=(value,isError=false)=>({content:[{type:'text',text:JSON.stringify(value,null,2)}],...(isError?{isError:true}:{})});
const lineShape={text:z.string().min(1).max(1200).describe('Exact spoken dialogue in Gujarati script. No stage directions.'),model:z.enum(['bulbul:v4-flash','bulbul:v3']).optional(),speaker:z.string().max(100).optional().describe('Exact Sarvam speaker ID for selected model.'),pace:z.number().min(0.7).max(1.2).optional()};
const annotations={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true};
function makeServer(env,origin) {
  const server=new McpServer({name:'sarvam-gujarati-mcp',version:'1.0.0'});
  server.registerTool('sarvam_voice_options',{description:'Show example Gujarati voice settings without using credits. Listen to actual samples before choosing.',inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:false}},async()=>reply({language:'gu-IN',examples:voices,notes:'V4 Pooja Gujarati personas are dedicated Gujarati voices. Other V4 examples are cross-language; audition them. V3 ratan is a documented Gujarati male recommendation. Use distinct speakers and pace 0.9. See https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/how-to/change-the-speaker-voice'}));
  server.registerTool('sarvam_generate_speech',{description:'Generate ONE Gujarati spoken line as a WAV file. Uses Sarvam API credits and returns a private expiring download link. No auto-retries.',inputSchema:lineShape,annotations},async args=>{
    try { const line=validateLine(args); if(!await reserve(env,'speech',countChars(line.text),1)) return reply({error:'Daily usage cap reached (UTC).'},true); return reply(await makeClip(env,origin,line,1,'speaker')); }
    catch(e){return reply({error:e instanceof Error?e.message:'Generation failed. Do not retry automatically.'},true);}
  });
  server.registerTool('sarvam_generate_dialogue',{description:'Generate up to 8 Gujarati dialogue lines in strict order as separate WAV files, each with a specified role and voice. Uses Sarvam credits; returns durations and private expiring download links. Does not create video or guarantee lip sync. Stops on first failure and returns successful files.',inputSchema:{lines:z.array(z.object({...lineShape,role:z.string().min(1).max(40)})).min(1).max(8)},annotations},async({lines})=>{
    const completed=[];
    try {const valid=lines.map(validateLine);const total=valid.reduce((n,l)=>n+countChars(l.text),0); if(total>2400) return reply({error:'Maximum 2400 characters per dialogue batch.'},true); if(!await reserve(env,'speech',total,valid.length)) return reply({error:'Daily usage cap reached (UTC).'},true); for(let i=0;i<valid.length;i++) completed.push(await makeClip(env,origin,valid[i],i+1,lines[i].role));return reply({status:'complete',clips:completed,total_audio_seconds:completed.reduce((n,c)=>n+c.duration_seconds,0),note:'Keep listed order. Listen before publishing; add pauses in video editor.'});}
    catch(e){return reply({status:'stopped',error:e instanceof Error?e.message:'Generation failed.',completed,failed_line:completed.length+1,note:'Do not repeat completed lines. Quota was reserved up front.'},true);}
  });
  return server;
}
const mcpHandler={async fetch(request,env,ctx){
  if(!configured(env)) return new Response('Server configuration incomplete',{status:503,headers});
  if(ctx.props?.userId!=='owner'||ctx.props?.permission!=='tts:generate') return new Response('Forbidden',{status:403,headers});
  const origin=new URL(request.url).origin;
  return createMcpHandler(()=>makeServer(env,origin),{route:'/mcp',responseMode:'json'})(request,env,ctx);
}};
export default {async fetch(request,env,ctx){
  let resource;
  try {resource=new URL(env.MCP_RESOURCE); if(resource.protocol!=='https:'||resource.pathname!=='/mcp'||resource.search||resource.hash||resource.hostname.toLowerCase().includes('replace_with')) throw new Error();}
  catch {return new Response('Set MCP_RESOURCE to the exact deployed HTTPS /mcp URL in wrangler.jsonc.',{status:503,headers});}
  if(new URL(request.url).origin!==resource.origin) return new Response('Incorrect host',{status:403,headers});
  const provider=new OAuthProvider({apiRoute:'/mcp',apiHandler:mcpHandler,defaultHandler:publicHandler,authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',clientIdMetadataDocumentEnabled:true,scopesSupported:['tts:generate'],resourceMetadata:{resource:resource.href,authorization_servers:[resource.origin],scopes_supported:['tts:generate'],resource_name:'Sarvam Gujarati MCP'}});
  return provider.fetch(request,env,ctx);
}};
