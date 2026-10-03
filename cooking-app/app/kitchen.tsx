"use client";
import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { Flame, CircleHelp, Plus, ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { useKitchen } from "@/lib/use-kitchen";
import { useKitchenLocal } from "@/lib/use-kitchen-local";
import { OVAL_RX, OVAL_RY, clampPosition, overlaps, timer, parseCommand, type Pancake, type Command, type Snapshot } from "@/lib/kitchen-model";
import { createUuid } from "@/lib/uuid";

type DropTarget = { plate:1|2; x:number; y:number; valid:boolean };
type Contact = { pointerId:number; x:number; y:number; max:number; item:Pancake|null; action:"left"|"right"|null; plate:1|2; targetX:number; targetY:number; grabOffsetX:number; grabOffsetY:number; longPressTimer:number|null; dragging:boolean; drop:DropTarget|null };
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
 const [dragPreview,setDragPreview] = useState<(DropTarget & {id:string})|null>(null);
 const [deleteCue,setDeleteCue] = useState(false);
 const plateSurfaces = useRef<Partial<Record<1|2,HTMLDivElement|null>>>({});
 const plateSvgs = useRef<Partial<Record<1|2,SVGSVGElement|null>>>({});
 const actions = useRef(kitchen);
 useEffect(()=>{actions.current=kitchen;},[kitchen]);
 const available = connection === "online";
 const items = snapshot?.items ?? [];
 const counts = {blank:0,running:0,done:0};
 items.forEach(item=>counts[timer(item,now).state]++);
 const wakeLock=useScreenWakeLock(__PAGES_MODE__&&counts.running>0);

 useEffect(()=>()=>{
   const current=contact.current;
   if(current?.longPressTimer!==null && current?.longPressTimer!==undefined) window.clearTimeout(current.longPressTimer);
 },[]);

 useEffect(()=>{
   const context = (document as Document & {modelContext?:ModelContext}).modelContext;
   if (__PAGES_MODE__ || !context?.registerTool) return;
   const lifecycle = new AbortController();
   const register = (tool:Record<string,unknown>) => {
     try { void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{}); } catch {}
   };
   register({name:"read_kitchen",title:"鉄板の状態を確認",description:"共有されている2枚の鉄板と、お好み焼きの位置・温度・固定90秒タイマーの開始時刻を取得します。",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:async()=>{
     await actions.current.sync();
     return actions.current.getSnapshot();
   }});
   register({name:"operate_kitchen",title:"お好み焼きを操作",description:"楕円の追加(create)、固定90秒計測の開始(start)、温度を1℃変更(adjust)、鉄板間の移動(move)、終了済みの取り出し(remove)、状態を問わない削除(delete)を実行します。画面と同じ共有データを変更します。operationIdと新規idはUUID v4、既存楕円の操作には取得したversionをexpectedVersionで指定します。",inputSchema:{type:"object",properties:{operationId:{type:"string"},type:{enum:["create","start","adjust","move","remove","delete"]},id:{type:"string"},plate:{enum:[1,2]},x:{type:"number",minimum:0,maximum:1},y:{type:"number",minimum:0,maximum:1},expectedVersion:{type:"integer",minimum:1},delta:{enum:[-1,1]}},required:["operationId","type","id"],additionalProperties:false},annotations:{readOnlyHint:false},execute:async(input:unknown)=>{
     const command = parseCommand(input);
     const result = await actions.current.send(command);
     return {revision:result.revision,items:result.items};
   }});
   return ()=>lifecycle.abort();
 },[]);

 const run = (command:Command) => { void send(command).then(result=>{
   if(command.type==="adjust") { const item=result.items.find(i=>i.id===command.id); if(item) toast.success(`温度を${item.temperature}℃に変更しました。`,{duration:1800}); }
   else if(command.type==="move") { const item=result.items.find(i=>i.id===command.id); if(item) toast.success(`鉄板${item.plate}へ移動しました。`,{duration:1800}); }
   else if(command.type==="delete") toast.success("楕円を削除しました。",{duration:1800});
 }).catch(()=>{}); };
 function perform(item:Pancake, action:string) {
   const current = timer(item,kitchen.currentTime());
   const base = {operationId:createUuid(),id:item.id,expectedVersion:item.version};
   if (action==="tap" && current.state==="blank") run({...base,type:"start"});
   else if ((action==="left"||action==="right") && current.state!=="done") run({...base,type:"adjust",delta:action==="right"?1:-1});
   else if ((action==="tap"||action==="up") && current.state==="done") run({...base,type:"remove"});
 }
 function clearLongPressTimer(current:Contact) {
   if(current.longPressTimer!==null) { window.clearTimeout(current.longPressTimer); current.longPressTimer=null; }
 }
 function dropTargetAt(clientX:number,clientY:number,id:string,offsetX=0,offsetY=0):DropTarget|null {
   for(const plate of [1,2] as const) {
     const surface=plateSurfaces.current[plate],svg=plateSvgs.current[plate];
     if(!surface||!svg) continue;
     const surfaceBounds=surface.getBoundingClientRect();
     if(clientX<surfaceBounds.left||clientX>surfaceBounds.right||clientY<surfaceBounds.top||clientY>surfaceBounds.bottom) continue;
     const svgBounds=svg.getBoundingClientRect();
     if(!svgBounds.width||!svgBounds.height) return null;
     const position=clampPosition((clientX-svgBounds.left)/svgBounds.width+offsetX,(clientY-svgBounds.top)/svgBounds.height+offsetY);
     const valid=!items.some(other=>other.id!==id&&other.plate===plate&&overlaps(other,position));
     return {plate,...position,valid};
   }
   return null;
 }
 function down(event:PointerEvent<SVGSVGElement>,plate:1|2) {
   if (!available || !event.isPrimary || event.button!==0 || contact.current) return;
   const element = event.target as Element;
   const target = element.closest("[data-item-id]");
   const item = items.find(i=>i.id===target?.getAttribute("data-item-id")) ?? null;
   if (item && pendingIds.has(item.id)) return;
   const action = element.closest("[data-item-action]")?.getAttribute("data-item-action");
   const bounds=event.currentTarget.getBoundingClientRect();
   const targetX=(event.clientX-bounds.left)/bounds.width,targetY=(event.clientY-bounds.top)/bounds.height;
   const current:Contact={pointerId:event.pointerId,x:event.clientX,y:event.clientY,max:0,item,action:action==="left"||action==="right"?action:null,plate,targetX,targetY,grabOffsetX:item?item.x-targetX:0,grabOffsetY:item?item.y-targetY:0,longPressTimer:null,dragging:false,drop:null};
   contact.current=current;
   setPressed(item?.id??null);
   if(item&&!current.action) current.longPressTimer=window.setTimeout(()=>{
     if(contact.current!==current||current.max>=12||!current.item) return;
     current.longPressTimer=null;
     current.dragging=true;
     current.drop={plate:current.item.plate,x:current.item.x,y:current.item.y,valid:true};
     setDeleteCue(false);
     setDragPreview({id:current.item.id,...current.drop});
   },450);
   event.currentTarget.setPointerCapture(event.pointerId);
 }
 function move(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if(!c||c.pointerId!==event.pointerId) return;
   c.max=Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y));
   if(!c.dragging) { if(c.max>=12) clearLongPressTimer(c); return; }
   const target=c.item?dropTargetAt(event.clientX,event.clientY,c.item.id,c.grabOffsetX,c.grabOffsetY):null;
   if(target&&c.item) {
     c.drop=target;
     setDeleteCue(false);
     setDragPreview({id:c.item.id,...target});
   } else {
     setDragPreview(null);
     setDeleteCue(true);
   }
 }
 function up(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if (!c || c.pointerId!==event.pointerId) return;
   clearLongPressTimer(c);
   contact.current=null; setPressed(null); setDragPreview(null); setDeleteCue(false);
   if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
   if(!available) return;
   if(c.dragging&&c.item) {
     const target=dropTargetAt(event.clientX,event.clientY,c.item.id,c.grabOffsetX,c.grabOffsetY);
     const base={operationId:createUuid(),id:c.item.id,expectedVersion:c.item.version};
     if(!target) run({...base,type:"delete"});
     else if(!target.valid) toast.error("他の楕円と重なる位置には移動できません。");
     else if(target.plate===c.item.plate&&Math.abs(target.x-c.item.x)<0.000001&&Math.abs(target.y-c.item.y)<0.000001) return;
     else run({...base,type:"move",plate:target.plate,x:target.x,y:target.y});
     return;
   }
   if(Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y))>=12) return;
   if(c.item) perform(c.item,c.action??"tap");
   else run({operationId:createUuid(),id:createUuid(),type:"create",plate:c.plate,x:c.targetX,y:c.targetY});
 }
 function cancel(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if(!c||c.pointerId!==event.pointerId) return;
   clearLongPressTimer(c);
   contact.current=null; setPressed(null); setDragPreview(null); setDeleteCue(false);
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
 {deleteCue&&<div role="status" style={{position:"fixed",left:"50%",bottom:"max(16px, env(safe-area-inset-bottom))",transform:"translateX(-50%)",zIndex:1000,padding:"10px 16px",border:"1px solid #fff",borderRadius:999,background:"#a83424",color:"#fff",boxShadow:"0 4px 16px #0004",fontSize:14,fontWeight:700,whiteSpace:"nowrap",pointerEvents:"none"}}>鉄板の外です。離すと削除</div>}
 <header className="topbar"><div className="brand"><span className="brand-icon"><Flame size={23}/></span><div><h1>鉄板タイマー</h1><p>TEPPAN TIMER</p></div></div><div className="top-actions"><span className={`connection ${connection}`} role="status">{connectionLabel}</span>
 {__PAGES_MODE__&&counts.running>0&&<span className={`wake-indicator ${wakeLock}`} role="status">{wakeLock==="active"?"画面を点灯中":"端末設定で消灯を延長"}</span>}
 {__PAGES_MODE__&&kitchen.updateReady&&<button className="update-button" disabled={counts.running>0} onClick={()=>kitchen.applyUpdate?.()}>{counts.running>0?"調理後に更新":"更新を適用"}</button>}
 <Dialog open={help} onOpenChange={setHelp}><DialogTrigger asChild><button className="icon-button" aria-label="使い方"><CircleHelp size={21}/></button></DialogTrigger><DialogContent className="help-dialog"><DialogHeader><DialogTitle>鉄板タイマーの使い方</DialogTitle><DialogDescription>{__PAGES_MODE__?"調理状態は、このスマホのブラウザー内だけに保存されます。":"同じ画面を開いたスマホで、調理の状態を共有できます。"}</DialogDescription></DialogHeader>
 <ol className="help-list"><li>鉄板の空いている場所をタップすると、白い楕円が置かれます。</li><li>白い楕円をタップすると、90秒で計測が始まります。</li><li>楕円の左右にある矢印をタップして、待機中・計測中の温度を1℃ずつ変更できます。初期温度は96℃です。</li><li>楕円本体を長押しすると、2枚の鉄板の間で移動できます。鉄板の外で離すと削除されます。</li><li>計測時間は常に90秒です。上から白くなり、0秒で全体が赤くなります。赤い楕円をタップして取り出します。</li></ol>
 <p className="help-note">温度を変更してもタイマーは90秒のままです。調理中は画面を表示してご利用ください。{__PAGES_MODE__?"画面ロック中の通知はありません。":"未接続の間は表示のみとなります。"}</p>
 <p className="help-note">パソコン：Tabで楕円を選択、Enterで開始、左右キーで温度を1℃調整、上キーで取り出し。</p>
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
   const renderItems=[...plateItems];
   const draggedItem=dragPreview?items.find(i=>i.id===dragPreview.id):undefined;
   if(draggedItem&&dragPreview?.plate===plate&&draggedItem.plate!==plate) renderItems.push(draggedItem);
   return <article className="plate-card" key={plate}><header className="plate-heading"><h2><span>0{plate}</span>鉄板 {plate}</h2><span>{plateItems.length} 枚</span></header><div className={`plate ${!available?"disabled":""}`} ref={element=>{plateSurfaces.current[plate]=element;}}>
   <svg ref={element=>{plateSvgs.current[plate]=element;}} viewBox="0 0 1600 900" role="group" aria-label={`鉄板${plate}。空いている場所をタップして追加、楕円本体を長押しして移動`} onPointerDown={e=>down(e,plate)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel} onContextMenu={e=>e.preventDefault()}>
   <rect width="1600" height="900" fill="transparent"/>
   {renderItems.map(item=>{
     if(dragPreview?.id===item.id&&dragPreview.plate!==plate) return null;
     const preview=dragPreview?.id===item.id&&dragPreview.plate===plate?dragPreview:null;
     const shown=preview?{...item,x:preview.x,y:preview.y}:item;
     const t=timer(item,now); const cx=shown.x*1600,cy=shown.y*900,rx=OVAL_RX*1600,ry=OVAL_RY*900;
     const busy=pendingIds.has(item.id);
     return <g key={item.id} data-item-id={item.id} data-plate={plate} data-state={t.state} data-duration="90" data-temperature={item.temperature} data-version={item.version} data-drag-valid={preview?preview.valid:undefined} className={`oval ${busy?"pending":""} ${preview?"drag-preview":""} ${preview&&!preview.valid?"drag-invalid":""}`}>
       <defs><clipPath id={`clip-${item.id}`}><ellipse cx={cx} cy={cy} rx={rx} ry={ry}/></clipPath></defs>
       <ellipse role="button" tabIndex={0} aria-disabled={!available||busy} aria-label={`お好み焼き ${t.state==="blank"?`待機中、温度${item.temperature}度、タップで90秒の計測を開始`:t.state==="done"?`焼き上がり、温度${item.temperature}度、タップで取り出し`:`残り${t.remaining}秒、温度${item.temperature}度`}`} cx={cx} cy={cy} rx={rx} ry={ry} fill={t.state==="done"?"#e13b3b":t.state==="blank"?"#fff":"#0c0d0f"} stroke={preview&&!preview.valid?"#fa3535":pressed===item.id?"#ffb276":"#92989f"} strokeWidth={preview?10:pressed===item.id?9:4} onKeyDown={e=>keyboard(e,item)}/>
       {t.state==="running"&&<rect x={cx-rx} y={cy-ry} width={rx*2} height={ry*2*t.progress} fill="#fff" clipPath={`url(#clip-${item.id})`} pointerEvents="none"/>}
       <text x={cx} y={cy-4} textAnchor="middle" className="oval-temperature" fontSize="30" fill={t.state==="blank"?"#636d77":t.state==="done"?"#fff":t.progress>0.52?"#353b41":"#ffffff"} pointerEvents="none">{item.temperature}℃</text>
       {t.state!=="blank"&&<text x={cx} y={cy+49} textAnchor="middle" className="oval-number" fontSize="66" fill={t.state==="done"?"#fff":t.progress>0.79?"#16191e":"#fff"} pointerEvents="none">{t.remaining}</text>}
       {t.state!=="done"&&<>
         <g role="button" tabIndex={0} aria-label="温度を1℃下げる" aria-disabled={!available||busy} data-item-action="left" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"left")}>
           <rect x={cx-rx} y={cy-ry} width="64" height={ry*2} fill="transparent" pointerEvents="all"/>
           <rect x={cx-rx+13} y={cy-38} width="46" height="76" rx="14" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx-rx+43} ${cy-17} l -17 17 17 17`} fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
         <g role="button" tabIndex={0} aria-label="温度を1℃上げる" aria-disabled={!available||busy} data-item-action="right" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"right")}>
           <rect x={cx+rx-64} y={cy-ry} width="64" height={ry*2} fill="transparent" pointerEvents="all"/>
           <rect x={cx+rx-59} y={cy-38} width="46" height="76" rx="14" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx+rx-43} ${cy-17} l 17 17 -17 17`} fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
       </>}
       {busy&&<circle cx={cx+rx-20} cy={cy-ry+20} r="15" fill="#e6793e"/>}
     </g>;
   })}
   </svg>
   {!renderItems.length&&<div className="empty-plate">{snapshot?<Plus size={30} strokeWidth={1}/>:<LoaderCircle className="animate-spin" size={25}/>}<span>{snapshot?"タップして置く":__PAGES_MODE__?"保存データを読み込み中":"共有データを読み込み中"}</span></div>}
   </div></article>;
 })}</section>
 <footer className="guide"><div><span className="guide-mark">1</span><span>空白をタップ<b>90秒計測スタート</b></span></div><div><span className="guide-arrows"><ArrowLeft size={19}/><ArrowRight size={19}/></span><span>左右の矢印をタップ<b>温度を1℃調整</b></span></div><div><span className="guide-red-dot" aria-hidden="true"/><span>赤い楕円をタップ<b>取り出す</b></span></div></footer>
 </main>;
}

export default function Kitchen() {
 return <KitchenView useController={useKitchen}/>;
}

export function PagesKitchen() {
 return <KitchenView useController={useKitchenLocal}/>;
}


