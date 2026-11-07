// Real local chain + SIWE + unanimous EIP-712 approval + fixed-price purchases.
// Approved review and encrypted storage are explicit isolated fixtures; no paid inference.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer as netServer} from 'node:net';
import {createServer} from 'node:http';
import {createCipheriv,randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {createPublicClient,createWalletClient,http,keccak256,toHex} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {hardhat} from 'viem/chains';
import {catalogueHash,originalityId,ORIGINALITY_VERSION} from '../../lib/originality.ts';
const root=process.cwd(),namespace=`reading-test-${randomUUID()}`,file=path.join(root,'.data',namespace,'studio.json'),children=[];
const artifact=JSON.parse(await readFile('contracts/artifacts/contracts/ConsentCraftReading.sol/ConsentCraftReading.json','utf8'));
async function port(){const s=netServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function start(args,options={}){const c=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],...options});let output='';c.stdout.on('data',d=>output=(output+d).slice(-100000));c.stderr.on('data',d=>output=(output+d).slice(-100000));c.output=()=>output;children.push(c);return c;}
async function ready(fn){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('Test service did not start.');}
const items=new Map();const storage=createServer((req,res)=>{const bytes=items.get(req.url.split('/').at(-1));res.writeHead(bytes?200:404);res.end(bytes||'missing');});storage.listen(0,'127.0.0.1');await once(storage,'listening');
try{
 const rpc=`http://127.0.0.1:${await port()}`;start(['../node_modules/hardhat/dist/src/cli.js','node','--hostname','127.0.0.1','--port',new URL(rpc).port],{cwd:path.join(root,'contracts')});
 const chain=createPublicClient({chain:hardhat,transport:http(rpc)});await ready(async()=>await chain.getChainId()===31337);
 const accountKeys=Array.from({length:7},()=>generatePrivateKey());
 const [author,collaborator,reviewer,treasury,alice,bob,outsider]=accountKeys.map(key=>privateKeyToAccount(key));
 for(const account of[author,collaborator,reviewer,treasury,alice,bob,outsider])await chain.request({method:'hardhat_setBalance',params:[account.address,'0x3635c9adc5dea00000']});
 const wallet=account=>createWalletClient({chain:hardhat,transport:http(rpc),account});
 const deployed=await wallet(author).deployContract({abi:artifact.abi,bytecode:artifact.bytecode,args:[reviewer.address,treasury.address]});const address=(await chain.waitForTransactionReceipt({hash:deployed})).contractAddress;
 const base=`http://127.0.0.1:${await port()}`,kek=randomBytes(32);
 const server=start(['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',new URL(base).port],{env:{...process.env,STUDIO_STORAGE:'file',VERCEL:'',CONSENTCRAFT_DATA_NAMESPACE:namespace,APP_ORIGIN:base,NEXT_PUBLIC_READING_ADDRESS:address,NEXT_PUBLIC_CHAIN_ID:'31337',CHAIN_RPC_URL:rpc,CHAIN_CONFIRMATIONS:'0',READING_START_BLOCK:'0',EDITION_REVIEWER_PRIVATE_KEY:accountKeys[2],CONTENT_KEY_ENCRYPTION_KEY:toHex(kek),ARWEAVE_GATEWAY:`http://127.0.0.1:${storage.address().port}`,ZG_COMPUTE_MODEL:'similarity-fixture',RATE_LIMIT_MULTIPLIER:'100'}});
 // The signer was generated in this process; retain its private key separately
 // instead of exposing it in logs or passing it through a command argument.
 await ready(async()=>{if(server.exitCode!==null)throw Error('App exited');return(await fetch(`${base}/api/studio`)).ok;});
 function session(){const jar=new Map();return{async call(url,body,status=200){const response=await fetch(`${base}${url}`,{method:body?'POST':'GET',headers:{Origin:base,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});for(const h of response.headers.getSetCookie()){const[k,v]=h.split(';')[0].split('=');if(v)jar.set(k,v);else jar.delete(k);}const json=await response.json();assert.equal(response.status,status,json.error||url);return json;}};}
 const sessions=[session(),session(),session(),session(),session()];
 for(const[i,account]of[author,collaborator,alice,bob,outsider].entries()){const{message}=await sessions[i].call('/api/studio',{action:'challenge',address:account.address,chainId:31337});await sessions[i].call('/api/studio',{action:'siwe',message,signature:await account.signMessage({message})});}
 const [a,c,buyerA,buyerB,other]=sessions;const{id}=await a.call('/api/studio',{action:'create',title:'Shared reading fixture',genre:'Original'});
 const getProject=async()=> (await a.call('/api/studio')).projects.find(p=>p.id===id);
 const invite=await a.call('/api/studio',{action:'invite',id,address:collaborator.address});await c.call('/api/studio',{action:'accept',token:invite.token});
 let p=await getProject();const jpeg=await sharp({create:{width:24,height:24,channels:3,background:'red'}}).jpeg().toBuffer();
 await a.call('/api/studio',{action:'save',id,revision:p.revision,title:p.title,description:'Fixture',terms:'Personal reading access for each purchasing wallet.',priceWei:'10000',panels:[{image:`data:image/jpeg;base64,${jpeg.toString('base64')}`,dialogue:'A shared story.',alt:'Generated fixture'}],members:p.members.map((m,i)=>({...m,share:i?4000:6000}))});
 p=await getProject();await c.call('/api/reading',{action:'start',id,revision:p.revision},403);await a.call('/api/reading',{action:'start',id,revision:p.revision});
 await other.call('/api/reading',{action:'approval',id},404);
 async function approve(s,account){const payload=await s.call('/api/reading',{action:'approval',id});payload.message.price=BigInt(payload.message.price);payload.message.approvalDeadline=BigInt(payload.message.approvalDeadline);await s.call('/api/reading',{action:'approve',id,rights:true,signature:await account.signTypedData(payload)});}
 await approve(a,author);await a.call('/api/reading',{action:'review',id},409);await a.call('/api/reading',{action:'prepare',id},409);
 await approve(c,collaborator);assert.equal((await getProject()).reading.approvals.length,2);
 p=await getProject();await a.call('/api/studio',{action:'save',id,revision:p.revision,panels:p.panels},409);
 console.log('PASS real SIWE, invitations, every collaborator approval, frozen content and owner-bypass rejection.');
 // Install a reviewed encrypted fixture only in this test namespace. This is
 // not a live curator approval and never touches production data or services.
 const key=randomBytes(32);function seal(key,plain,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv).setAAD(Buffer.from(aad));return{iv,body:Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()])};}
 const plain=Buffer.from(JSON.stringify({mime:'image/jpeg',image:jpeg.toString('base64'),dialogue:'A shared story.',alt:'Generated fixture'}));const sealed=seal(key,plain,'consentcraft.bundle.v1:page:0');
 const bundle=Buffer.from(JSON.stringify({schema:'consentcraft.bundle.v1',cipher:'AES-256-GCM',pageCount:1,pages:[{index:0,iv:sealed.iv.toString('base64'),ciphertext:sealed.body.toString('base64'),plaintextHash:keccak256(plain)}]}));
 const bundleId=randomBytes(32).toString('base64url'),metadataId=randomBytes(32).toString('base64url');const metadata=Buffer.from(JSON.stringify({name:'Shared reading fixture',description:'Fixture',genre:'Original',license:p.terms}));items.set(bundleId,bundle);items.set(metadataId,metadata);
 const db=JSON.parse(await readFile(file,'utf8'));const saved=db.projects.find(p=>p.id===id);Object.assign(saved.reading,{status:'approved',manifestHash:keccak256(bundle),bundleTxId:bundleId,coverTxId:'c'.repeat(43),uri:`ar://${metadataId}`,metadataHash:keccak256(metadata),review:{score:8000,flagged:false,reasons:['Synthetic approved fixture'],model:'fixture',provider:'fixture',teeVerified:false,at:new Date().toISOString(),promptVersion:'fixture',uncertainty:'Synthetic test only'}});
 const originality={version:ORIGINALITY_VERSION,contentHash:saved.reading.contentHash,catalogueHash:catalogueHash(31337,address,[]),crux:'Synthetic private synopsis',maxSimilarity:0,comparedComicCount:'0',model:'similarity-fixture',requestId:'synthetic-scan',comparisonRequestIds:[],at:new Date().toISOString(),comparisons:[]};
 saved.reading.originality=originality;saved.reading.metadataOriginalityId=originalityId(originality);
 const wrapped=seal(kek,key,`consentcraft:key:${id}`);db.readingSecrets={[id]:{wrappedKey:`${wrapped.iv.toString('base64')}.${wrapped.body.toString('base64')}`}};await writeFile(file,JSON.stringify(db));
 const prepared=await a.call('/api/reading',{action:'prepare',id});
 const permit={...prepared.permit,price:BigInt(prepared.permit.price),approvalDeadline:BigInt(prepared.permit.approvalDeadline),deadline:BigInt(prepared.permit.deadline)};
 async function send(account,functionName,args,value){const hash=await wallet(account).writeContract({address,abi:artifact.abi,functionName,args,value});assert.equal((await chain.waitForTransactionReceipt({hash})).status,'success');}
 await send(author,'publishComic',[permit,prepared.uri,prepared.team,prepared.signature]);await a.call('/api/reading',{action:'confirm',id});await a.call('/api/reading',{action:'confirm',id});assert.equal((await getProject()).version,1);
 await other.call('/api/reading/read/1',undefined,403);
 await send(alice,'buyReading',[1n],10000n);assert.equal((await buyerA.call('/api/reading/read/1')).pages[0].dialogue,'A shared story.');
 await send(bob,'buyReading',[1n],10000n);assert.equal((await buyerA.call('/api/reading/read/1')).pages[0].dialogue,'A shared story.');assert.equal((await buyerB.call('/api/reading/read/1')).pages[0].dialogue,'A shared story.');
 assert.equal((await buyerA.call(`/api/reading?wallet=${alice.address}&library=1`)).comics[0].id,'1');
 assert.equal((await buyerB.call(`/api/reading?wallet=${bob.address}&library=1`)).comics[0].id,'1');
 await assert.rejects(send(alice,'buyReading',[1n],10000n));await other.call('/api/reading/read/1',undefined,403);
 await send(reviewer,'setDelisted',[1n,true]);assert.equal((await buyerA.call('/api/reading/read/1')).pages.length,1);assert.equal((await buyerB.call('/api/reading/read/1')).pages.length,1);
 assert.equal(await chain.readContract({address,abi:artifact.abi,functionName:'credits',args:[collaborator.address]}),7800n);
 console.log('PASS unanimous on-chain publication, fixed-price purchases by two readers, independent encrypted HTTP reading, persistent access, libraries, and collaborator earnings.');
}finally{for(const child of children.reverse())if(child.exitCode===null)child.kill();await new Promise(r=>storage.close(r));}
