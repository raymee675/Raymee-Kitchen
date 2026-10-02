"use client";
import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { Flame, CircleHelp, Plus, ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { useKitchen } from "@/lib/use-kitchen";
import { useKitchenLocal } from "@/lib/use-kitchen-local";
import { OVAL_RX, OVAL_RY, timer, parseCommand, type Pancake, type Command, type Snapshot } from "@/lib/kitchen-model";
import { createUuid } from "@/lib/uuid";

type Contact = { pointerId:number; x:number; y:number; max:number; item:Pancake|null; action:"left"|"right"|null; plate:1|2; targetX:number; targetY:number };
type ModelContext = { registerTool:(tool:Record<string,unknown>, options:{signal:AbortSignal}) => unknown };
type KitchenController = {
 snapshot:Snapshot|null;
 now:number;
 connection:"connecting"|"online"|"offline"|"unauthorized";
 pendingIds:Set<string>;
 send:(command:Command)=>Promise<Snapshot>;
 sync:()=>Promise<void>;
 currentTime:()=>number;
 getSnapshot:()=>Snapshot|null;
 statusMessage?:string|null;
 cacheState?:"preparing"|"ready"|"unavailable";
 updateReady?:boolean;
 applyUpdate?:()=>void;
};

type ScreenWakeLockToken = {
 release:()=>Promise<void>;
 addEventListener:(type:"release",listener:()=>void)=>void;
};

function useScreenWakeLock(enabled:boolean) {
 const [state,setState]=useState<"idle"|"active"|"unavailable">("idle");
 const token=useRef<ScreenWakeLockToken|null>(null);
 useEffect(()=>{
   let alive=true;
   const api=(navigator as Navigator & {wakeLock?:{request:(type:"screen")=>Promise<ScreenWakeLockToken>}}).wakeLock;
   const release=()=>{const current=token.current;token.current=null;if(current)void current.release().catch(()=>{});};
   const acquire=async()=>{
     if(!enabled){release();setState("idle");return;}
     if(!api){setState("unavailable");return;}
     if(document.hidden){release();setState("idle");return;}
     try{
       const current=await api.request("screen");
       if(!alive){void current.release().catch(()=>{});return;}
       token.current=current;
       setState("active");
       current.addEventListener("release",()=>{if(token.current===current){token.current=null;if(alive)setState("unavailable");}});
     }catch{if(alive)setState("unavailable");}
   };
   const visibility=()=>{if(document.hidden){release();setState("idle");}else void acquire();};
   void acquire();
   document.addEventListener("visibilitychange",visibility);
   return()=>{alive=false;document.removeEventListener("visibilitychange",visibility);release();};
 },[enabled]);
 return state;
}

function KitchenView({useController}:{useController:()=>KitchenController}) {
 const kitchen = useController();
 const {snapshot, now, connection, pendingIds, send, sync} = kitchen;
 const [help,setHelp] = useState(false);
 const contact = useRef<Contact|null>(null);
 const [pressed,setPressed] = useState<string|null>(null);
 const actions = useRef(kitchen);
 useEffect(()=>{actions.current=kitchen;},[kitchen]);
 const available = connection === "online";
 const items = snapshot?.items ?? [];
 const counts = {blank:0,running:0,done:0};
 items.forEach(item=>counts[timer(item,now).state]++);
 const wakeLock=useScreenWakeLock(__PAGES_MODE__&&counts.running>0);

 useEffect(()=>{
   const context = (document as Document & {modelContext?:ModelContext}).modelContext;
   if (__PAGES_MODE__ || !context?.registerTool) return;
   const lifecycle = new AbortController();
   const register = (tool:Record<string,unknown>) => {
     try { void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{}); } catch {}
   };
   register({name:"read_kitchen",title:"鉄板の状態を確認",description:"共有されている2枚の鉄板と、お好み焼きの位置・設定時間・開始時刻を取得します。",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:async()=>{
     await actions.current.sync();
     return actions.current.getSnapshot();
   }});
   register({name:"operate_kitchen",title:"お好み焼きを操作",description:"楕円の追加(create)、計測開始(start)、設定を1秒変更(adjust)、終了済みの削除(remove)を実行します。画面と同じ共有データを変更します。operationIdと新規idはUUID v4、既存楕円の操作には取得したversionをexpectedVersionで指定します。",inputSchema:{type:"object",properties:{operationId:{type:"string"},type:{enum:["create","start","adjust","remove"]},id:{type:"string"},plate:{enum:[1,2]},x:{type:"number",minimum:0,maximum:1},y:{type:"number",minimum:0,maximum:1},expectedVersion:{type:"integer",minimum:1},delta:{enum:[-1,1]}},required:["operationId","type","id"],additionalProperties:false},annotations:{readOnlyHint:false},execute:async(input:unknown)=>{
     const command = parseCommand(input);
     const result = await actions.current.send(command);
     return {revision:result.revision,items:result.items};
   }});
   return ()=>lifecycle.abort();
 },[]);

 const run = (command:Command) => { void send(command).then(result=>{
   if(command.type==="adjust") { const item=result.items.find(i=>i.id===command.id); if(item) toast.success(`設定を${item.duration}秒に変更しました。`,{duration:1800}); }
 }).catch(()=>{}); };
 function perform(item:Pancake, action:string) {
   const current = timer(item,kitchen.currentTime());
   const base = {operationId:createUuid(),id:item.id,expectedVersion:item.version};
   if (action==="tap" && current.state==="blank") run({...base,type:"start"});
   else if ((action==="left"||action==="right") && current.state!=="done") run({...base,type:"adjust",delta:action==="right"?1:-1});
   else if ((action==="tap"||action==="up") && current.state==="done") run({...base,type:"remove"});
 }
 function down(event:PointerEvent<SVGSVGElement>,plate:1|2) {
   if (!available || !event.isPrimary || event.button!==0 || contact.current) return;
   const element = event.target as Element;
   const target = element.closest("[data-item-id]");
   const item = items.find(i=>i.id===target?.getAttribute("data-item-id")) ?? null;
   if (item && pendingIds.has(item.id)) return;
   const action = element.closest("[data-item-action]")?.getAttribute("data-item-action");
   const bounds=event.currentTarget.getBoundingClientRect();
   contact.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY,max:0,item,action:action==="left"||action==="right"?action:null,plate,targetX:(event.clientX-bounds.left)/bounds.width,targetY:(event.clientY-bounds.top)/bounds.height};
   setPressed(item?.id??null);
   event.currentTarget.setPointerCapture(event.pointerId);
 }
 function move(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if(c && c.pointerId===event.pointerId) c.max=Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y));
 }
 function up(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if (!c || c.pointerId!==event.pointerId) return;
   contact.current=null; setPressed(null);
   if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
   if(!available) return;
   if(Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y))>=12) return;
   if(c.item) perform(c.item,c.action??"tap");
   else run({operationId:createUuid(),id:createUuid(),type:"create",plate:c.plate,x:c.targetX,y:c.targetY});
 }
 function keyboard(event:KeyboardEvent<SVGElement>,item:Pancake,controlAction?:"left"|"right") {
   if(!available||pendingIds.has(item.id))return;
   const action=controlAction
     ? (event.key==="Enter"||event.key===" "?controlAction:undefined)
     : ({"Enter":"tap"," ":"tap","ArrowLeft":"left","ArrowRight":"right","ArrowUp":"up","Delete":"up"} as Record<string,string>)[event.key];
   if(action){event.preventDefault();perform(item,action);}
 }
  const connectionLabel = __PAGES_MODE__
    ? (connection==="online"?"この端末に保存":connection==="connecting"?"準備中":"操作停止中")
    : {connecting:"接続中",online:"同期中",offline:"未接続",unauthorized:"要端末登録"}[connection];
 return <main className="kitchen">
 <Toaster position="top-center" richColors theme="light"/>
 <header className="topbar"><div className="brand"><span className="brand-icon"><Flame size={23}/></span><div><h1>鉄板タイマー</h1><p>TEPPAN TIMER</p></div></div><div className="top-actions"><span className={`connection ${connection}`} role="status">{connectionLabel}</span>
 {__PAGES_MODE__&&counts.running>0&&<span className={`wake-indicator ${wakeLock}`} role="status">{wakeLock==="active"?"画面を点灯中":"端末設定で消灯を延長"}</span>}
 {__PAGES_MODE__&&kitchen.updateReady&&<button className="update-button" disabled={counts.running>0} onClick={()=>kitchen.applyUpdate?.()}>{counts.running>0?"調理後に更新":"更新を適用"}</button>}
 <Dialog open={help} onOpenChange={setHelp}><DialogTrigger asChild><button className="icon-button" aria-label="使い方"><CircleHelp size={21}/></button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>鉄板タイマーの使い方</DialogTitle><DialogDescription>{__PAGES_MODE__?"調理状態は、このスマホのブラウザー内だけに保存されます。":"同じ画面を開いたスマホで、調理の状態を共有できます。"}</DialogDescription></DialogHeader>
 <ol className="help-list"><li>鉄板の空いている場所をタップすると、白い楕円が置かれます。</li><li>白い楕円をタップすると、100秒で計測が始まります。</li><li>楕円の左右にある矢印をタップして、待機中・計測中の設定時間を1秒ずつ変更できます（90〜110秒）。</li><li>上から白くなり、0秒で全体が赤くなります。赤い楕円をタップして取り出します。</li></ol>
 <p className="help-note">時間調整で開始時刻は変わりません。調理中は画面を表示してご利用ください。{__PAGES_MODE__?"画面ロック中の通知はありません。":"未接続の間は表示のみとなります。"}</p>
 <p className="help-note">パソコン：Tabで楕円を選択、Enterで開始、左右キーで調整、上キーで取り出し。</p>
  <p className="help-note">PC版は通常のブラウザーで利用します。画面ロック中の通知はありません。</p>
 <button className="help-done" onClick={()=>setHelp(false)}>わかりました</button></DialogContent></Dialog>
 </div></header>
 <div className="overview"><p>調理状況</p><div className="totals"><span>待機 <b>{counts.blank}</b></span><span>調理中 <b>{counts.running}</b></span><span>焼き上がり <b className={counts.done?"finished-count":""}>{counts.done}</b></span></div></div>
 {__PAGES_MODE__&&kitchen.statusMessage&&<div className="status-banner" role="alert">{kitchen.statusMessage}</div>}
 {__PAGES_MODE__&&kitchen.cacheState==="preparing"&&<div className="status-banner" role="status">オフライン起動用の画面を準備しています。準備が終わるまでインターネット接続を保ってください。</div>}
 {__PAGES_MODE__&&kitchen.cacheState==="unavailable"&&<div className="status-banner" role="status">オフラインで再起動するための保存に失敗しました。アプリを再読み込みして準備状態を確認してください。</div>}
 {!__PAGES_MODE__&&connection==="unauthorized" && <div className="status-banner">この端末は未登録か、利用期限が切れています。<a href="/register">登録画面を開いてください</a> 管理者から登録コードを受け取ってください。</div>}
 {!__PAGES_MODE__&&connection==="offline" && <div className="status-banner" role="status">接続を確認しています。現在は表示のみです。 <button onClick={()=>void sync()}>再接続</button></div>}
 <section className="plates" aria-label="鉄板の操作画面">{([1,2] as const).map(plate=>{
   const plateItems=items.filter(i=>i.plate===plate);
   return <article className="plate-card" key={plate}><header className="plate-heading"><h2><span>0{plate}</span>鉄板 {plate}</h2><span>{plateItems.length} 枚</span></header><div className={`plate ${!available?"disabled":""}`}>
   <svg viewBox="0 0 1600 900" role="group" aria-label={`鉄板${plate}。空いている場所をタップして追加`} onPointerDown={e=>down(e,plate)} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{contact.current=null;setPressed(null);}} onLostPointerCapture={()=>{contact.current=null;setPressed(null);}} onContextMenu={e=>e.preventDefault()}>
   <rect width="1600" height="900" fill="transparent"/>
   {plateItems.map(item=>{
     const t=timer(item,now); const cx=item.x*1600,cy=item.y*900,rx=OVAL_RX*1600,ry=OVAL_RY*900;
     const busy=pendingIds.has(item.id);
     return <g key={item.id} data-item-id={item.id} data-state={t.state} data-duration={item.duration} data-version={item.version} className={`oval ${busy?"pending":""}`}>
       <defs><clipPath id={`clip-${item.id}`}><ellipse cx={cx} cy={cy} rx={rx} ry={ry}/></clipPath></defs>
       <ellipse role="button" tabIndex={0} aria-disabled={!available||busy} aria-label={`お好み焼き ${t.state==="blank"?"待機、タップで開始":t.state==="done"?"焼き上がり、タップで取り出し":`残り${t.remaining}秒、設定時間${item.duration}秒`}`} cx={cx} cy={cy} rx={rx} ry={ry} fill={t.state==="done"?"#e13b3b":t.state==="blank"?"#fff":"#0c0d0f"} stroke={pressed===item.id?"#ffb276":"#92989f"} strokeWidth={pressed===item.id?9:4} onKeyDown={e=>keyboard(e,item)}/>
       {t.state==="running"&&<rect x={cx-rx} y={cy-ry} width={rx*2} height={ry*2*t.progress} fill="#fff" clipPath={`url(#clip-${item.id})`} pointerEvents="none"/>}
       <text x={cx} y={cy-4} textAnchor="middle" className="oval-duration" fontSize="30" fill={t.state==="blank"?"#636d77":t.state==="done"?"#fff":t.progress>0.52?"#353b41":"#ffffff"} pointerEvents="none">{item.duration}秒</text>
       {t.state!=="blank"&&<text x={cx} y={cy+49} textAnchor="middle" className="oval-number" fontSize="66" fill={t.state==="done"?"#fff":t.progress>0.79?"#16191e":"#fff"} pointerEvents="none">{t.remaining}</text>}
       {t.state!=="done"&&<>
         <g role="button" tabIndex={0} aria-label="設定時間を1秒短くする" aria-disabled={!available||busy} data-item-action="left" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"left")}>
           <rect x={cx-rx} y={cy-ry} width="64" height={ry*2} fill="transparent" pointerEvents="all"/>
           <rect x={cx-rx+13} y={cy-38} width="46" height="76" rx="14" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx-rx+43} ${cy-17} l -17 17 17 17`} fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
         <g role="button" tabIndex={0} aria-label="設定時間を1秒長くする" aria-disabled={!available||busy} data-item-action="right" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"right")}>
           <rect x={cx+rx-64} y={cy-ry} width="64" height={ry*2} fill="transparent" pointerEvents="all"/>
           <rect x={cx+rx-59} y={cy-38} width="46" height="76" rx="14" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx+rx-43} ${cy-17} l 17 17 -17 17`} fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
       </>}
       {busy&&<circle cx={cx+rx-20} cy={cy-ry+20} r="15" fill="#e6793e"/>}
     </g>;
   })}
   </svg>
   {!plateItems.length&&<div className="empty-plate">{snapshot?<Plus size={30} strokeWidth={1}/>:<LoaderCircle className="animate-spin" size={25}/>}<span>{snapshot?"タップして置く":__PAGES_MODE__?"保存データを読み込み中":"共有データを読み込み中"}</span></div>}
   </div></article>;
 })}</section>
 <footer className="guide"><div><span className="guide-mark">1</span><span>空白をタップ<b>計測スタート</b></span></div><div><span className="guide-arrows"><ArrowLeft size={19}/><ArrowRight size={19}/></span><span>左右の矢印をタップ<b>90〜110秒に調整</b></span></div><div><span className="guide-red-dot" aria-hidden="true"/><span>赤い楕円をタップ<b>取り出す</b></span></div></footer>
 </main>;
}

export default function Kitchen() {
 return <KitchenView useController={useKitchen}/>;
}

export function PagesKitchen() {
 return <KitchenView useController={useKitchenLocal}/>;
}


