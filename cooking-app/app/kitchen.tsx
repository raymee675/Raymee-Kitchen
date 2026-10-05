"use client";
import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { Flame, CircleHelp, Plus, ArrowLeft, ArrowRight, LoaderCircle, Download, Undo2, RotateCcw } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { useKitchen } from "@/lib/use-kitchen";
import { useKitchenLocal } from "@/lib/use-kitchen-local";
import { GRID_CELLS, GRID_COLUMNS, GRID_ROWS, OVAL_RX, OVAL_RY, completionStatus, completionTimer, gridCellAt, gridMoveBlockReason, gridMoveSourceBlockReason, isGridCellOccupied, isGridOverCapacity, nearestGridCell, timer, parseCommand, type GridMoveBlockReason, type Pancake, type Command, type Snapshot } from "@/lib/kitchen-model";
import { downloadExecutionRecords } from "@/lib/execution-record-export";
import { createUuid } from "@/lib/uuid";

type DropTarget = { plate:1|2; x:number; y:number; cellIndex:number; valid:boolean; reason:GridMoveBlockReason|null };
type Contact = { pointerId:number; expectedGeneration:number; x:number; y:number; max:number; item:Pancake|null; action:"left"|"right"|null; plate:1|2; targetX:number; targetY:number; grabOffsetX:number; grabOffsetY:number; longPressTimer:number|null; dragging:boolean; drop:DropTarget|null };
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

function localClockLabel(timestamp:number|null) {
 if(timestamp===null)return "";
 const date=new Date(timestamp);
 return `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
}

function gridMoveBlockMessage(reason:GridMoveBlockReason|null) {
 const messages:Record<GridMoveBlockReason,string>={
   missing:"このお好み焼きは取り出されています。",
   source_not_bottom:"上段のお好み焼きは移動できません。",
   different_plate:"別の鉄板へは移動できません。同じ鉄板で操作してください。",
   wrong_row:"下段から真上の上段マスへのみ移動できます。",
   different_column:"同じ列の真上にあるマスへ移動してください。",
   occupied:"移動先の上段マスは使用中のため移動できません。",
   over_capacity:"既存の過密状態を保持中のため、この鉄板からは移動できません。焼き上がった楕円を完成ボックスへ移してください。",
 };
 return reason?messages[reason]:"このマスへは移動できません。";
}

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
 const [resetConfirmation,setResetConfirmation] = useState(false);
 const resetSubmitting=useRef(false);
 const contact = useRef<Contact|null>(null);
 const [pressed,setPressed] = useState<string|null>(null);
 const [dragPreview,setDragPreview] = useState<(DropTarget & {id:string})|null>(null);
 const plateSurfaces = useRef<Partial<Record<1|2,HTMLDivElement|null>>>({});
 const plateSvgs = useRef<Partial<Record<1|2,SVGSVGElement|null>>>({});
 const actions = useRef(kitchen);
 useEffect(()=>{actions.current=kitchen;},[kitchen]);
 const available = connection === "online";
 const observedGeneration = useRef<number|null>(snapshot?.generation ?? null);
 useEffect(()=>{
   const nextGeneration=snapshot?.generation ?? null;
   if(observedGeneration.current===nextGeneration)return;
   observedGeneration.current=nextGeneration;
   cancelActiveContact();
 },[snapshot?.generation]);
 const items = snapshot?.items ?? [];
 const gridBlocked = isGridOverCapacity(items);
 const completionItems = snapshot?.completionItems ?? [];
 const counts = {blank:0,running:0,done:0};
 items.forEach(item=>counts[timer(item,now).state]++);
 const records = snapshot?.records ?? [];
 const recordsById = new Map(records.map(record=>[record.id,record]));
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
   register({name:"read_kitchen",title:"鉄板の状態を確認",description:"共有されている2枚の鉄板、お好み焼きの位置・温度・固定90秒タイマー、完成ボックスと30分期限、および実行記録を取得します。",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:async()=>{
     await actions.current.sync();
     return actions.current.getSnapshot();
   }});
   register({name:"operate_kitchen",title:"お好み焼きを操作",description:"楕円の追加(create)、固定90秒計測の開始(start)、温度を1℃変更(adjust)、同じ鉄板の下段から同じ列の空いた上段への移動(move)、焼き上がり楕円の完成ボックス移動(remove)、完成ボックス項目の提供/提供不可確定(remove)、直近の配置・移動の取り消し(undo)を実行します。新規配置は下段の空きマスのみで、画面では下段の調理中の楕円をタップすると同じ鉄板・同じ列の空いた上段へ自動で移動します。上段は下段からの上向き移動先専用です。上段からの移動、左右・同段・鉄板間の移動はできません。取り消しは直近50件までで、タイマー開始・温度変更・完成ボックス移動・提供操作を行うと、それ以前の取り消し履歴は消えます。画面と同じ共有データを変更します。operationIdはUUID v4です。read_kitchenで取得したgenerationをexpectedGenerationに必ず指定してください。undoではread_kitchenのundoHistory末尾にあるoperationIdをexpectedUndoOperationIdへ指定します。createでは下段の座標を指定し、idは指定せず、配置順に採番します。他の操作には対象のidと取得したversionをexpectedVersionで指定します。",inputSchema:{type:"object",properties:{operationId:{type:"string"},expectedGeneration:{type:"integer",minimum:0},type:{enum:["create","start","adjust","move","remove","undo"]},id:{type:"string"},plate:{enum:[1,2]},x:{type:"number",minimum:0,maximum:1},y:{type:"number",minimum:0,maximum:1},expectedVersion:{type:"integer",minimum:1},expectedUndoOperationId:{type:"string"},delta:{enum:[-1,1]}},required:["operationId","type","expectedGeneration"],additionalProperties:false},annotations:{readOnlyHint:false},execute:async(input:unknown)=>{
     const command = parseCommand(input);
     if(command.expectedGeneration===undefined) throw new Error("read_kitchenで取得したgenerationをexpectedGenerationに指定してください。");
     const result = await actions.current.send({...command,expectedGeneration:command.expectedGeneration});
     return {revision:result.revision,generation:result.generation,items:result.items,completionItems:result.completionItems,records:result.records,undoHistory:result.undoHistory};
   }});
   return ()=>lifecycle.abort();
 },[]);

 const run = (command:Command) => {
   let operation:Promise<Snapshot>;
   try { operation=send(command); }
   catch(error) { toast.error(error instanceof Error?error.message:"操作を保存できませんでした。"); return; }
   void operation.then(result=>{
   if(command.type==="adjust") { const item=result.items.find(i=>i.id===command.id); if(item) toast.success(`温度を${item.temperature}℃に変更しました。`,{duration:1800}); }
   else if(command.type==="move") { const item=result.items.find(i=>i.id===command.id); if(item) toast.success("真上のマスへ移動しました。",{duration:1800}); }
   else if(command.type==="remove") {
     const record=result.records.find(item=>item.id===command.id);
     if(result.completionItems.some(item=>item.id===command.id)) toast.success("完成ボックスに移しました。",{duration:1800});
     else if(record?.servedAt!==null&&record?.servedAt!==undefined) toast.success("提供済みにしました。",{duration:1800});
     else if(record?.unavailableAt!==null&&record?.unavailableAt!==undefined) toast.success("提供不可として記録しました。",{duration:1800});
   }
   else if(command.type==="undo") toast.success("直前の操作を取り消しました。",{duration:1800});
 }).catch(()=>{}); };
 function exportRecords() {
   if (!records.length) return;
   downloadExecutionRecords(records, kitchen.currentTime());
   toast.success(`${records.length}件の実行記録を書き出しました。`, {duration:2200});
 }
 function confirmReset() {
   if(!snapshot||!available||pendingIds.size>0||resetSubmitting.current)return;
   resetSubmitting.current=true;
   void send({operationId:createUuid(),type:"reset",expectedGeneration:snapshot.generation}).then(()=>{
     setResetConfirmation(false);
     toast.success("調理データを初期化しました。次のIDは1-1です。",{duration:2400});
   }).catch(()=>{}).finally(()=>{resetSubmitting.current=false;});
 }
 function perform(item:Pancake, action:string, expectedGeneration?:number) {
   const current = timer(item,kitchen.currentTime());
   const base = {operationId:createUuid(),id:item.id,expectedVersion:item.version,...(expectedGeneration===undefined?{}:{expectedGeneration})};
   if (action==="tap" && current.state==="blank") run({...base,type:"start"});
   else if (action==="tap" && current.state==="running") {
     const source=nearestGridCell(item.x,item.y);
     if(source.row!==GRID_ROWS-1) { toast.error("上段のお好み焼きは移動できません。"); return; }
     const target=GRID_CELLS[source.index-GRID_COLUMNS];
     if(!target) { toast.error("真上の移動先を確認できませんでした。"); return; }
     const reason=gridMoveBlockReason(items,item.id,item.plate,target.index);
     if(reason) { toast.error(gridMoveBlockMessage(reason)); return; }
     run({...base,type:"move",plate:item.plate,x:target.x,y:target.y});
   }
   else if ((action==="left"||action==="right") && current.state!=="done") run({...base,type:"adjust",delta:action==="right"?1:-1});
   else if ((action==="tap"||action==="up") && current.state==="done") run({...base,type:"remove"});
 }
 function clearLongPressTimer(current:Contact) {
   if(current.longPressTimer!==null) { window.clearTimeout(current.longPressTimer); current.longPressTimer=null; }
 }
 function cancelActiveContact() {
   const current=contact.current;
   if(current) {
     clearLongPressTimer(current);
     for(const svg of Object.values(plateSvgs.current)) {
       if(svg?.hasPointerCapture(current.pointerId)) svg.releasePointerCapture(current.pointerId);
     }
   }
   contact.current=null;
   setPressed(null);
   setDragPreview(null);
 }
 function dropTargetAt(clientX:number,clientY:number,id:string,offsetX=0,offsetY=0):DropTarget|null {
   for(const plate of [1,2] as const) {
     const svg=plateSvgs.current[plate];
     if(!svg) continue;
     const svgBounds=svg.getBoundingClientRect();
     if(clientX<svgBounds.left||clientX>svgBounds.right||clientY<svgBounds.top||clientY>svgBounds.bottom) continue;
     if(!svgBounds.width||!svgBounds.height) return null;
     const position=nearestGridCell((clientX-svgBounds.left)/svgBounds.width+offsetX,(clientY-svgBounds.top)/svgBounds.height+offsetY);
     const reason=gridMoveBlockReason(items,id,plate,position.index);
     return {plate,x:position.x,y:position.y,cellIndex:position.index,valid:reason===null,reason};
   }
   return null;
 }
 function down(event:PointerEvent<SVGSVGElement>,plate:1|2) {
   const expectedGeneration=snapshot?.generation;
   if (!available || expectedGeneration===undefined || !event.isPrimary || event.button!==0 || contact.current) return;
   const element = event.target as Element;
   const target = element.closest("[data-item-id]");
   const item = items.find(i=>i.id===target?.getAttribute("data-item-id")) ?? null;
   if (item && pendingIds.has(item.id)) return;
   const action = element.closest("[data-item-action]")?.getAttribute("data-item-action");
   const bounds=event.currentTarget.getBoundingClientRect();
   const targetX=(event.clientX-bounds.left)/bounds.width,targetY=(event.clientY-bounds.top)/bounds.height;
   const current:Contact={pointerId:event.pointerId,expectedGeneration,x:event.clientX,y:event.clientY,max:0,item,action:action==="left"||action==="right"?action:null,plate,targetX,targetY,grabOffsetX:item?item.x-targetX:0,grabOffsetY:item?item.y-targetY:0,longPressTimer:null,dragging:false,drop:null};
   contact.current=current;
   setPressed(item?.id??null);
   if(item&&!current.action&&gridMoveSourceBlockReason(items,item.id)===null) current.longPressTimer=window.setTimeout(()=>{
     if(contact.current!==current||current.max>=12||!current.item) return;
     current.longPressTimer=null;
     current.dragging=true;
     const cell=nearestGridCell(current.item.x,current.item.y);
     current.drop={plate:current.item.plate,x:cell.x,y:cell.y,cellIndex:cell.index,valid:true,reason:null};
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
     setDragPreview({id:c.item.id,...target});
   } else {
     setDragPreview(null);
   }
 }
 function up(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if (!c || c.pointerId!==event.pointerId) return;
   clearLongPressTimer(c);
   contact.current=null; setPressed(null); setDragPreview(null);
   if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
   if(!available||actions.current.getSnapshot()?.generation!==c.expectedGeneration) return;
   if(c.dragging&&c.item) {
     const target=dropTargetAt(event.clientX,event.clientY,c.item.id,c.grabOffsetX,c.grabOffsetY);
     if(!target) return;
     if(target.plate===c.item.plate&&target.cellIndex===nearestGridCell(c.item.x,c.item.y).index) return;
     if(!target.valid) {
       toast.error(gridMoveBlockMessage(target.reason));
       return;
     }
     const base={operationId:createUuid(),expectedGeneration:c.expectedGeneration,id:c.item.id,expectedVersion:c.item.version};
     run({...base,type:"move",plate:target.plate,x:target.x,y:target.y});
     return;
   }
   if(Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y))>=12) return;
   if(c.item) perform(c.item,c.action??"tap",c.expectedGeneration);
   else {
     const cell=gridCellAt(c.targetX,c.targetY);
     if(cell.row!==GRID_ROWS-1) { toast.error("上段は移動専用です。下段に配置するか、下段から同じ列の上段へ移動してください。"); return; }
     if(gridBlocked) { toast.error("各鉄板が6枚以下になるまで配置できません。"); return; }
     if(isGridCellOccupied(items,c.plate,cell.index)) { toast.error("このマスにはすでに楕円があります。空いているマスをタップしてください。"); return; }
     run({operationId:createUuid(),expectedGeneration:c.expectedGeneration,type:"create",plate:c.plate,x:cell.x,y:cell.y});
   }
 }
 function cancel(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if(!c||c.pointerId!==event.pointerId) return;
   clearLongPressTimer(c);
   contact.current=null; setPressed(null); setDragPreview(null);
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
 const latestUndo=snapshot?.undoHistory.at(-1);
 return <main className="kitchen">
 <Toaster position="top-center" richColors theme="light"/>
 <header className="topbar"><div className="brand"><span className="brand-icon"><Flame size={23}/></span><div><h1>鉄板タイマー</h1><p>TEPPAN TIMER</p></div></div><div className="top-actions"><span className={`connection ${connection}`} role="status">{connectionLabel}</span>
 {__PAGES_MODE__&&counts.running>0&&<span className={`wake-indicator ${wakeLock}`} role="status">{wakeLock==="active"?"画面を点灯中":"端末設定で消灯を延長"}</span>}
 {__PAGES_MODE__&&kitchen.updateReady&&<button className="update-button" disabled={counts.running>0} onClick={()=>kitchen.applyUpdate?.()}>{counts.running>0?"調理後に更新":"更新を適用"}</button>}
 <button className="update-button export-button" aria-label="実行記録をExcel用CSVに書き出す" title="実行記録をExcel用CSVに書き出す" disabled={!snapshot||records.length===0} onClick={exportRecords}><Download size={15}/><span>記録を書き出す</span></button>
 <button className="update-button export-button undo-button" aria-label="直前の操作を取り消す" title={latestUndo?"直前の操作を取り消す":"取り消せる操作はありません"} disabled={!available||pendingIds.size>0||!latestUndo} onClick={()=>{if(latestUndo)run({operationId:createUuid(),type:"undo",expectedUndoOperationId:latestUndo.operationId});}}><Undo2 size={15}/><span>操作を取り消す</span></button>
 {!resetConfirmation
   ? <button className="update-button export-button reset-button" disabled={!snapshot||!available||pendingIds.size>0} onClick={()=>setResetConfirmation(true)}><RotateCcw size={15}/><span>リセット</span></button>
   : <div className="reset-confirmation" role="alert"><span>鉄板・完成ボックス・実行記録・取り消し履歴を消去し、IDを1-1から再開します。{__PAGES_MODE__?"このブラウザーの調理データ":"全端末で共有する調理データ"}が対象です。記録を残す場合は先に書き出してください。</span><button className="update-button reset-confirm" disabled={!available||pendingIds.size>0||resetSubmitting.current} onClick={confirmReset}>初期化を確定</button><button className="reset-cancel" disabled={pendingIds.size>0||resetSubmitting.current} onClick={()=>{if(!resetSubmitting.current)setResetConfirmation(false);}}>キャンセル</button></div>}
 <Dialog open={help} onOpenChange={setHelp}><DialogTrigger asChild><button className="icon-button" aria-label="使い方"><CircleHelp size={21}/></button></DialogTrigger><DialogContent className="help-dialog"><DialogHeader><DialogTitle>鉄板タイマーの使い方</DialogTitle><DialogDescription>{__PAGES_MODE__?"調理状態は、このスマホのブラウザー内だけに保存されます。":"同じ画面を開いたスマホで、調理の状態を共有できます。"}</DialogDescription></DialogHeader>
 <ol className="help-list"><li>鉄板は縦2行・横3列の6マスです。新しい楕円は下段の空きマスをタップして配置します。上段は、下段から移動した楕円だけを置ける移動先専用です。</li><li>白い楕円をタップすると、90秒で計測が始まります。調理中の下段の楕円をタップすると、同じ鉄板・同じ列の真上にある空き上段マスへ自動で移動します。移動先が使用中、または鉄板が過密の場合は移動せず、理由を表示します。上段の楕円は移動できません。</li><li>楕円の左右にある矢印をタップして、待機中・計測中の温度を1℃ずつ変更できます。初期温度は96℃です。</li><li>下段の楕円本体を長押ししても、同じ鉄板・同じ列の真上にある空いた上段マスへ移動できます。左右・同段・鉄板間の移動はできません。鉄板の外または鉄板の間の隙間で離すと、元の場所に戻ります。</li><li>計測時間は常に90秒です。上から白くなり、0秒で全体が赤くなります。赤い楕円をタップすると、完成ボックスへ移って30分タイマーが始まります。</li><li>完成ボックスを期限前にタップすると提供済みになります。期限を過ぎると青い楕円の「提供不可」に変わり、タップすると履歴に残してボックスから除きます。</li></ol>
 <p className="help-note">「操作を取り消す」では直近50件までの楕円配置・鉄板上の移動を操作順に戻せます。タイマー開始、温度変更、完成ボックスへの移動、提供・提供不可の確定を行うと、それ以前の取り消し履歴は消えます。過密な旧データは位置を保って表示し、新規配置とその鉄板にある楕円の移動はできません。焼き上がった楕円を完成ボックスへ移すと数が減り、両方の鉄板が6枚以下になれば残りは自動でマスに整理されます。</p>
 <p className="help-note">温度を変更してもタイマーは90秒のままです。調理中は画面を表示してご利用ください。{__PAGES_MODE__?"画面ロック中の通知はありません。":"未接続の間は表示のみとなります。"}</p>
 <p className="help-note">パソコン：Tabで楕円を選択、Enterで計測開始・下段の調理中楕円の上段移動・焼き上がりの取り出し、左右キーで温度を1℃調整。完成ボックスもTabで選択してEnterで操作できます。</p>
 <p className="help-note">記録は「記録を書き出す」からExcelで開けるCSVにできます。温度ごとの加熱秒数に加え、焼き上がり・保管・提供の時刻と最終ステータスを出力します。</p>
  <p className="help-note">PC版は通常のブラウザーで利用します。画面ロック中の通知はありません。</p>
 <button className="help-done" onClick={()=>setHelp(false)}>わかりました</button></DialogContent></Dialog>
 </div></header>
 <div className="overview"><p>調理状況</p><div className="totals"><span>待機 <b>{counts.blank}</b></span><span>調理中 <b>{counts.running}</b></span><span>焼き上がり <b className={counts.done?"finished-count":""}>{counts.done}</b></span><span>完成ボックス <b>{completionItems.length}</b></span></div></div>
 {__PAGES_MODE__&&kitchen.statusMessage&&<div className="status-banner" role="alert">{kitchen.statusMessage}</div>}
 {gridBlocked&&<div className="grid-capacity-warning" role="status">既存の配置数が6マスを超えている鉄板があります。楕円は元の位置のまま保持しています。新規配置と超過している鉄板からの移動はできません。焼き上がった楕円を完成ボックスへ移すと数が減り、両方の鉄板が6枚以下になると残りを自動でマスへ整理します。</div>}
 {__PAGES_MODE__&&kitchen.cacheState==="preparing"&&<div className="status-banner" role="status">オフライン起動用の画面を準備しています。準備が終わるまでインターネット接続を保ってください。</div>}
 {__PAGES_MODE__&&kitchen.cacheState==="unavailable"&&<div className="status-banner" role="status">オフラインで再起動するための保存に失敗しました。アプリを再読み込みして準備状態を確認してください。</div>}
 {!__PAGES_MODE__&&connection==="unauthorized" && <div className="status-banner">この端末は未登録か、利用期限が切れています。<a href="/register">登録画面を開いてください</a> 管理者から登録コードを受け取ってください。</div>}
 {!__PAGES_MODE__&&connection==="offline" && <div className="status-banner" role="status">接続を確認しています。現在は表示のみです。 <button onClick={()=>void sync()}>再接続</button></div>}
 <section className="completion-box" aria-label="お好み焼き完成ボックス">
   <header className="completion-box-heading"><div><h2>完成ボックス</h2><p>赤くなったお好み焼きは30分以内に提供</p></div><span>{completionItems.length} 個</span></header>
   <div className="completion-list" role="list">
     {completionItems.map(boxItem=>{
       const record=recordsById.get(boxItem.id);
       if(!record)return null;
       const outcome=completionStatus(record,now);
       const clock=completionTimer(record,now);
       const unavailable=outcome==="unavailable";
       const minutes=String(Math.floor(clock.remainingSeconds/60)).padStart(2,"0");
       const seconds=String(clock.remainingSeconds%60).padStart(2,"0");
       const label=unavailable?"提供不可":`${minutes}:${seconds} 残り`;
       const deadline=localClockLabel(record.serveDeadlineAt);
       return <button key={boxItem.id} type="button" role="listitem" title={`お好み焼きID: ${boxItem.id}`} className={`completion-card ${unavailable?"unavailable":""} ${pendingIds.has(boxItem.id)?"pending":""}`} disabled={!available||pendingIds.has(boxItem.id)} aria-label={`お好み焼きID ${boxItem.id}、${label}。タップして${unavailable?"提供不可として取り出す":"提供済みにする"}`} onClick={()=>run({operationId:createUuid(),type:"remove",id:boxItem.id,expectedVersion:boxItem.version})}>
         <span className="completion-card-id">{boxItem.id}</span>
         <strong>{label}</strong>
         <small>{unavailable?"期限切れ":`期限 ${deadline}`}</small>
       </button>;
     })}
     {!completionItems.length&&<p className="completion-empty">赤い楕円をタップすると、ここに移ります。</p>}
   </div>
 </section>
 <section className="plates" aria-label="鉄板の操作画面">{([1,2] as const).map(plate=>{
   const plateItems=items.filter(i=>i.plate===plate);
   const renderItems=[...plateItems];
   const draggedItem=dragPreview?items.find(i=>i.id===dragPreview.id):undefined;
   if(draggedItem&&dragPreview?.plate===plate&&draggedItem.plate!==plate) renderItems.push(draggedItem);
   return <article className="plate-card" key={plate}><header className="plate-heading"><h2><span>0{plate}</span>鉄板 {plate}</h2><span className={plateItems.length>GRID_CELLS.length?"plate-count-overflow":""}>{plateItems.length} / {GRID_CELLS.length} マス</span></header><div className={`plate ${!available?"disabled":""}`} ref={element=>{plateSurfaces.current[plate]=element;}}>
   <svg ref={element=>{plateSvgs.current[plate]=element;}} viewBox="0 0 1600 900" role="group" aria-label={`鉄板${plate}。3列2行の6マスです。新しい楕円は下段の空きマスをタップして配置します。下段の調理中の楕円をタップすると同じ列の空いた上段へ移動します。上段は移動先専用で、上段からの移動、左右・同段・鉄板間の移動はできません。`} onPointerDown={e=>down(e,plate)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel} onContextMenu={e=>e.preventDefault()}>
   <rect width="1600" height="900" fill="transparent"/>
   <g className="plate-grid" pointerEvents="none" aria-hidden="true">
     {Array.from({length:GRID_COLUMNS-1},(_,index)=><line key={`column-${index}`} x1={(index+1)*1600/GRID_COLUMNS} y1="0" x2={(index+1)*1600/GRID_COLUMNS} y2="900"/>)}
     {Array.from({length:GRID_ROWS-1},(_,index)=><line key={`row-${index}`} x1="0" y1={(index+1)*900/GRID_ROWS} x2="1600" y2={(index+1)*900/GRID_ROWS}/>)}
     {GRID_CELLS.map(cell=><circle key={cell.index} cx={cell.x*1600} cy={cell.y*900} r="9" className={isGridCellOccupied(items,plate,cell.index)?"plate-grid-center occupied":"plate-grid-center"}/>)}
   </g>
   {renderItems.map(item=>{
     if(dragPreview?.id===item.id&&dragPreview.plate!==plate) return null;
     const preview=dragPreview?.id===item.id&&dragPreview.plate===plate?dragPreview:null;
     const shown=preview?{...item,x:preview.x,y:preview.y}:item;
     const t=timer(item,now); const cx=shown.x*1600,cy=shown.y*900,rx=OVAL_RX*1600,ry=OVAL_RY*900;
     const busy=pendingIds.has(item.id);
     return <g key={item.id} data-item-id={item.id} data-plate={plate} data-state={t.state} data-duration="90" data-temperature={item.temperature} data-version={item.version} data-drag-valid={preview?preview.valid:undefined} className={`oval ${busy?"pending":""} ${preview?"drag-preview":""} ${preview&&!preview.valid?"drag-invalid":""}`}>
       <title>{`お好み焼きID: ${item.id}`}</title>
       <defs><clipPath id={`clip-${item.id}`}><ellipse cx={cx} cy={cy} rx={rx} ry={ry}/></clipPath></defs>
       <ellipse role="button" tabIndex={0} aria-disabled={!available||busy} aria-label={`お好み焼きID ${item.id}、${t.state==="blank"?`待機中、温度${item.temperature}度、タップで90秒の計測を開始`:t.state==="done"?`焼き上がり、温度${item.temperature}度、タップで完成ボックスに移動`:nearestGridCell(item.x,item.y).row===GRID_ROWS-1?`調理中、残り${t.remaining}秒、温度${item.temperature}度、タップで真上の空きマスへ移動`:`調理中、残り${t.remaining}秒、温度${item.temperature}度、上段からは移動できません`}`} cx={cx} cy={cy} rx={rx} ry={ry} fill={t.state==="done"?"#e13b3b":t.state==="blank"?"#fff":"#0c0d0f"} stroke={preview&&!preview.valid?"#fa3535":pressed===item.id?"#ffb276":"#92989f"} strokeWidth={preview?10:pressed===item.id?9:4} onKeyDown={e=>keyboard(e,item)}/>
       {t.state==="running"&&<rect x={cx-rx} y={cy-ry} width={rx*2} height={ry*2*t.progress} fill="#fff" clipPath={`url(#clip-${item.id})`} pointerEvents="none"/>}
       <text x={cx} y={cy-49} textAnchor="middle" className="oval-temperature" fontSize="26" fill={t.state==="blank"?"#636d77":t.state==="done"?"#fff":t.progress>0.52?"#353b41":"#ffffff"} pointerEvents="none">{item.temperature}℃</text>
       <text x={cx} y={cy-29} textAnchor="middle" className="oval-id" fontSize="15" fill={t.state==="blank"?"#636d77":t.state==="done"?"#fff":t.progress>0.52?"#353b41":"#ffffff"} pointerEvents="none">{item.id}</text>
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
   {!renderItems.length&&<div className="empty-plate">{snapshot?<Plus size={30} strokeWidth={1}/>:<LoaderCircle className="animate-spin" size={25}/>}<span>{snapshot?"下段の空きマスをタップして配置":__PAGES_MODE__?"保存データを読み込み中":"共有データを読み込み中"}</span></div>}
   </div></article>;
 })}</section>
 <footer className="guide"><div><span className="guide-mark">1</span><span>下段の空白・調理中の楕円をタップ<b>空白は配置、調理中は真上へ移動</b></span></div><div><span className="guide-arrows"><ArrowLeft size={19}/><ArrowRight size={19}/></span><span>左右の矢印をタップ<b>温度を1℃調整</b></span></div><div><span className="guide-red-dot" aria-hidden="true"/><span>赤い楕円をタップ<b>完成ボックスへ</b></span></div><div><span className="guide-mark">30</span><span>完成ボックスをタップ<b>提供/提供不可</b></span></div></footer>
 </main>;
}

export default function Kitchen() {
 return <KitchenView useController={useKitchen}/>;
}

export function PagesKitchen() {
 return <KitchenView useController={useKitchenLocal}/>;
}


