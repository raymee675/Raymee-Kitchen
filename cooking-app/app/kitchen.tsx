"use client";
import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type ChangeEvent } from "react";
import { Flame, CircleHelp, Plus, ArrowLeft, ArrowRight, ArrowUp, LoaderCircle, Download, Undo2, RotateCcw, Database } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { useKitchen } from "@/lib/use-kitchen";
import { useKitchenLocal } from "@/lib/use-kitchen-local";
import { GRID_CELLS, GRID_COLUMNS, GRID_ROWS, OVAL_RX, OVAL_RY, completionStatus, completionTimer, gridCellAt, gridMoveBlockReason, isGridCellActuallyOccupied, isGridCellOccupied, isGridOverCapacity, nearestGridCell, timer, parseCommand, type GridMoveBlockReason, type Pancake, type Command, type Snapshot } from "@/lib/kitchen-model";
import { downloadExecutionRecords } from "@/lib/execution-record-export";
import { createLocalBoardBackup, parseLocalBoardBackup, type ParsedLocalBoardBackup } from "@/lib/local-kitchen-storage";
import { createUuid } from "@/lib/uuid";

type Contact = { pointerId:number; expectedGeneration:number; x:number; y:number; max:number; startedAt:number; item:Pancake|null; action:"left"|"right"|null; plate:1|2; targetX:number; targetY:number };
type ModelContext = { registerTool:(tool:Record<string,unknown>, options:{signal:AbortSignal}) => unknown };
type KitchenController = {
 snapshot:Snapshot|null;
 now:number;
 connection:"connecting"|"online"|"offline"|"unauthorized";
 pendingIds:Set<string>;
 backupBusy?:boolean;
 recoveryAvailable?:boolean;
 send:(command:Command)=>Promise<Snapshot>;
 restoreBackup?:(backup:ParsedLocalBoardBackup,expectedRevision:number|null)=>Promise<Snapshot>;
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
 const [dataManagementOpen,setDataManagementOpen] = useState(false);
 const [backupDraft,setBackupDraft] = useState<ParsedLocalBoardBackup|null>(null);
 const [backupReading,setBackupReading] = useState(false);
 const [resetConfirmation,setResetConfirmation] = useState(false);
 const resetSubmitting=useRef(false);
 const contact = useRef<Contact|null>(null);
 const backupFileInput = useRef<HTMLInputElement|null>(null);
 const [pressed,setPressed] = useState<string|null>(null);
 const plateSvgs = useRef<Partial<Record<1|2,SVGSVGElement|null>>>({});
 const actions = useRef(kitchen);
 useEffect(()=>{actions.current=kitchen;},[kitchen]);
 const available = connection === "online" && !kitchen.backupBusy;
 const canRestoreBoard = Boolean(kitchen.recoveryAvailable || (snapshot && available));
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
   register({name:"operate_kitchen",title:"お好み焼きを操作",description:"楕円の追加(create)、固定90秒計測の開始(start)、温度を1℃変更(adjust)、同じ鉄板の下段から同じ列の空いた上段への移動(move)、焼き上がり楕円の完成ボックス移動(remove)、完成ボックス項目の提供/提供不可確定(remove)、直近の配置・移動の取り消し(undo)を実行します。新規配置は下段の空きマスのみです。画面では下段の待機中楕円は、同じ列の上段が空いていれば最初のタップでタイマーを始めず上段へ移動し、上段でタップすると計測を開始します。上段が使用中なら下段でタップして計測を開始します。下段の調理中の楕円をタップすると同じ鉄板・同じ列の空いた上段へ移動します。上段は下段からの上向き移動先専用です。上段からの移動、左右・同段・鉄板間の移動はできません。取り消しは直近50件までで、タイマー開始・温度変更・完成ボックス移動・提供操作を行うと、それ以前の取り消し履歴は消えます。画面と同じ共有データを変更します。operationIdはUUID v4です。read_kitchenで取得したgenerationをexpectedGenerationに必ず指定してください。undoではread_kitchenのundoHistory末尾にあるoperationIdをexpectedUndoOperationIdへ指定します。createでは下段の座標を指定し、idは指定せず、配置順に採番します。他の操作には対象のidと取得したversionをexpectedVersionで指定します。",inputSchema:{type:"object",properties:{operationId:{type:"string"},expectedGeneration:{type:"integer",minimum:0},type:{enum:["create","start","adjust","move","remove","undo"]},id:{type:"string"},plate:{enum:[1,2]},x:{type:"number",minimum:0,maximum:1},y:{type:"number",minimum:0,maximum:1},expectedVersion:{type:"integer",minimum:1},expectedUndoOperationId:{type:"string"},delta:{enum:[-1,1]}},required:["operationId","type","expectedGeneration"],additionalProperties:false},annotations:{readOnlyHint:false},execute:async(input:unknown)=>{
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
  function exportBoardBackup() {
    if (!snapshot) return;
    try {
      const content = createLocalBoardBackup(snapshot, kitchen.currentTime());
      const date = new Date(kitchen.currentTime()).toISOString().slice(0,10);
      const url = URL.createObjectURL(new Blob([content], {type:"application/json;charset=utf-8"}));
      const link = document.createElement("a");
      link.href = url;
      link.download = `teppan-timer-pages-backup-${date}.json`;
      link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast.success("盤面バックアップを保存しました。別の場所にも保管してください。", {duration:2600});
    } catch (error) {
      toast.error(error instanceof Error?error.message:"バックアップを書き出せませんでした。");
    }
  }
  function selectBackupFile(event:ChangeEvent<HTMLInputElement>) {
    const input=event.currentTarget;
    const file=input.files?.[0];
    input.value="";
    if(!file)return;
    setBackupDraft(null);
    if(file.size>10*1024*1024){toast.error("バックアップファイルは10MB以下を選んでください。現在の盤面は変更していません。");return;}
    setBackupReading(true);
    void file.text().then(parseLocalBoardBackup).then(backup=>{
      setBackupDraft(backup);
      toast.success("バックアップを確認しました。内容を確認して読み込みを確定してください。",{duration:2400});
    }).catch(error=>{
      toast.error(error instanceof Error?error.message:"バックアップを読み込めませんでした。現在の盤面は変更していません。");
    }).finally(()=>setBackupReading(false));
  }
  function restoreBoardBackup() {
    if(!backupDraft||!canRestoreBoard||!kitchen.restoreBackup||pendingIds.size>0)return;
    const expectedRevision=kitchen.recoveryAvailable?null:snapshot?.revision??null;
    void kitchen.restoreBackup(backupDraft,expectedRevision).then(()=>{
      setBackupDraft(null);
      setDataManagementOpen(false);
      toast.success("盤面バックアップを読み込みました。",{duration:2400});
    }).catch(()=>{});
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
   if (action==="tap" && current.state==="blank") {
     const source=nearestGridCell(item.x,item.y);
     if(source.row===GRID_ROWS-1) {
       const target=GRID_CELLS[source.index-GRID_COLUMNS];
       if(!target) { toast.error("真上の移動先を確認できませんでした。"); return; }
       if(isGridCellActuallyOccupied(items,item.plate,target.index,item.id)) { run({...base,type:"start"}); return; }
       const reason=gridMoveBlockReason(items,item.id,item.plate,target.index);
       if(reason) { toast.error(gridMoveBlockMessage(reason)); return; }
       run({...base,type:"move",plate:item.plate,x:target.x,y:target.y});
       return;
     }
     run({...base,type:"start"});
   }
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
 function cancelActiveContact() {
   const current=contact.current;
   if(current) {
     for(const svg of Object.values(plateSvgs.current)) {
       if(svg?.hasPointerCapture(current.pointerId)) svg.releasePointerCapture(current.pointerId);
     }
   }
   contact.current=null;
   setPressed(null);
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
   const current:Contact={pointerId:event.pointerId,expectedGeneration,x:event.clientX,y:event.clientY,max:0,startedAt:performance.now(),item,action:action==="left"||action==="right"?action:null,plate,targetX,targetY};
   contact.current=current;
   setPressed(item?.id??null);
   event.currentTarget.setPointerCapture(event.pointerId);
 }
 function move(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if(!c||c.pointerId!==event.pointerId) return;
   c.max=Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y));
 }
 function up(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if (!c || c.pointerId!==event.pointerId) return;
   contact.current=null; setPressed(null);
   if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
   if(!available||actions.current.getSnapshot()?.generation!==c.expectedGeneration) return;
   if(Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y))>=12) return;
   if(c.item&&!c.action&&performance.now()-c.startedAt>=450) return;
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
   contact.current=null; setPressed(null);
 }
 function keyboard(event:KeyboardEvent<SVGElement>,item:Pancake,controlAction?:"left"|"right") {
   if(!available||pendingIds.has(item.id))return;
   const action=controlAction
     ? (event.key==="Enter"||event.key===" "?controlAction:undefined)
     : ({"Enter":"tap"," ":"tap","ArrowLeft":"left","ArrowRight":"right","ArrowUp":"up","Delete":"up"} as Record<string,string>)[event.key];
   if(action){event.preventDefault();perform(item,action);}
 }
  const connectionLabel = __PAGES_MODE__
     ? (kitchen.backupBusy?"復元中":connection==="online"?"この端末に保存":connection==="connecting"?"準備中":"操作停止中")
     : {connecting:"接続中",online:"同期中",offline:"未接続",unauthorized:"要端末登録"}[connection];
  const latestUndo=snapshot?.undoHistory.at(-1);
  return <main className={`kitchen${__PAGES_MODE__?" pages-kitchen":""}`}>
 <Toaster position="top-center" richColors theme="light"/>
 <header className="topbar"><div className="brand"><span className="brand-icon"><Flame size={23}/></span><div><h1>鉄板タイマー</h1><p>TEPPAN TIMER</p></div></div><div className="top-actions"><span className={`connection ${connection}`} role="status">{connectionLabel}</span>
 {__PAGES_MODE__&&counts.running>0&&<span className={`wake-indicator ${wakeLock}`} role="status">{wakeLock==="active"?"画面を点灯中":"端末設定で消灯を延長"}</span>}
 {__PAGES_MODE__&&kitchen.updateReady&&<button className="update-button" disabled={counts.running>0} onClick={()=>kitchen.applyUpdate?.()}>{counts.running>0?"調理後に更新":"新しい版に更新"}</button>}
 <button className="update-button export-button" aria-label="実行記録をExcel用CSVに書き出す" title="実行記録をExcel用CSVに書き出す" disabled={!snapshot||records.length===0} onClick={exportRecords}><Download size={15}/><span>記録を書き出す</span></button>
 <button className="update-button export-button undo-button" aria-label="直前の操作を取り消す" title={latestUndo?"直前の操作を取り消す":"取り消せる操作はありません"} disabled={!available||pendingIds.size>0||!latestUndo} onClick={()=>{if(latestUndo)run({operationId:createUuid(),type:"undo",expectedUndoOperationId:latestUndo.operationId});}}><Undo2 size={15}/><span>操作を取り消す</span></button>
  {!resetConfirmation
    ? <button className="update-button export-button reset-button" disabled={!snapshot||!available||pendingIds.size>0} onClick={()=>setResetConfirmation(true)}><RotateCcw size={15}/><span>リセット</span></button>
    : <div className="reset-confirmation" role="alert"><span>鉄板・完成ボックス・実行記録・取り消し履歴を消去し、IDを1-1から再開します。{__PAGES_MODE__?"このブラウザーの調理データ":"全端末で共有する調理データ"}が対象です。{__PAGES_MODE__?"盤面を戻す場合はJSONバックアップ、記録を残す場合はCSVを先に保存してください。":"記録を残す場合は先に書き出してください。"}</span><button className="update-button reset-confirm" disabled={!available||pendingIds.size>0||resetSubmitting.current} onClick={confirmReset}>初期化を確定</button><button className="reset-cancel" disabled={pendingIds.size>0||resetSubmitting.current} onClick={()=>{if(!resetSubmitting.current)setResetConfirmation(false);}}>キャンセル</button></div>}
  {__PAGES_MODE__&&<Dialog open={dataManagementOpen} onOpenChange={open=>{setDataManagementOpen(open);if(!open){setBackupDraft(null);setBackupReading(false);}}}>
    <DialogTrigger asChild><button className="update-button export-button data-management-trigger" aria-label="データ管理" title="データ管理" disabled={!canRestoreBoard}><Database size={15}/><span>データ管理</span></button></DialogTrigger>
    <DialogContent className="data-management-dialog">
      <DialogHeader><DialogTitle>データ管理</DialogTitle><DialogDescription>{kitchen.recoveryAvailable?"保存データを読み込めません。この画面が編集ロックを保持し、保存領域へ書き込める間だけ、検証済みJSONバックアップから復旧できます。":"データはこのスマートフォンのブラウザー内に保存されます。JSONバックアップは端末のダウンロード先に保存し、必要に応じて別の場所にも保管してください。"}</DialogDescription></DialogHeader>
      <div className="data-management-actions">
        <button type="button" className="data-action-button" disabled={!snapshot||!available} onClick={exportBoardBackup}><Database size={18}/><span><strong>盤面バックアップを保存</strong><small>盤面・タイマー・完成ボックス・実行記録・次のIDをJSONに保存</small></span></button>
        <button type="button" className="data-action-button" disabled={!snapshot||!available||records.length===0} onClick={exportRecords}><Download size={18}/><span><strong>実行記録CSVを書き出す</strong><small>完了した記録のみ。盤面の復元には使えません</small></span></button>
        <input ref={backupFileInput} className="backup-file-input" type="file" accept=".json,application/json" aria-label="JSONバックアップファイル" onChange={selectBackupFile}/>
        <button type="button" className="data-action-button" disabled={!canRestoreBoard||backupReading||pendingIds.size>0} onClick={()=>backupFileInput.current?.click()}><Download size={18}/><span><strong>{backupReading?"バックアップを確認中…":kitchen.recoveryAvailable?"JSONバックアップを選んで復旧":"JSONバックアップを選んで復元"}</strong><small>選択後に内容を確認してから、現在の保存データを置き換えます</small></span></button>
      </div>
      {backupDraft&&<section className="backup-preview" aria-live="polite">
        <h3>復元するバックアップ</h3>
        <p>作成日時：{new Date(backupDraft.exportedAt).toLocaleString("ja-JP")}</p>
        <p>読み込み後：鉄板上の楕円 {backupDraft.snapshot.items.length}枚・完成ボックス {backupDraft.snapshot.completionItems.length}個・実行記録 {backupDraft.snapshot.records.length}件</p>
        {kitchen.recoveryAvailable
          ? <p>置き換え対象：現在の保存データを読み込めません（バックアップから復旧）</p>
          : <p>置き換え対象：鉄板上の楕円 {items.length}枚・完成ボックス {completionItems.length}個・実行記録 {records.length}件</p>}
        <p>現在の保存データをこの内容に置き換えます。内容を確認して確定してください。</p>
        <div><button type="button" className="reset-cancel" disabled={kitchen.backupBusy} onClick={()=>setBackupDraft(null)}>キャンセル</button><button type="button" className="backup-restore-button" disabled={!canRestoreBoard||pendingIds.size>0||kitchen.backupBusy} onClick={restoreBoardBackup}>{kitchen.recoveryAvailable?"このバックアップで復旧":"このデータに置き換える"}</button></div>
      </section>}
    </DialogContent>
  </Dialog>}
  <Dialog open={help} onOpenChange={setHelp}><DialogTrigger asChild><button className="icon-button" aria-label="使い方"><CircleHelp size={21}/></button></DialogTrigger><DialogContent className="help-dialog"><DialogHeader><DialogTitle>鉄板タイマーの使い方</DialogTitle><DialogDescription>{__PAGES_MODE__?"調理状態は、このスマートフォンのこのブラウザー内だけに保存されます。":"同じ画面を開いたスマホで、調理の状態を共有できます。"}</DialogDescription></DialogHeader>
  <ol className="help-list"><li>鉄板は縦2行・横3列の6マスです。新しい楕円は下段の空きマスをタップして配置します。上段は、下段から移動した楕円だけを置ける移動先専用です。</li><li>下段の待機中の楕円は、同じ鉄板・同じ列の上段が空いていればタップで上段へ移動します。上段が埋まっている場合は計測を始めます。移動できない配置の場合は元の場所に残り、理由を表示します。上段の待機中の楕円をタップすると固定90秒の計測が始まります。調理中の下段の楕円をタップすると、同じ鉄板・同じ列の真上にある空き上段マスへ移動します。移動先が使用中、または鉄板が過密の場合は移動せず、理由を表示します。上段の楕円は移動できません。</li><li>楕円の左右にある矢印をタップすると、待機中・計測中の温度を1℃ずつ変更できます。焼き上がり後は変更できません。初期値は96℃です。この温度は設定・記録用で、センサーの実測値ではありません。計測時間は常に90秒です。</li><li>残り0秒で楕円が赤くなります。赤い楕円をタップすると完成ボックスへ移り、30分の保管タイマーが始まります。期限前に完成ボックスをタップすると提供済みになり、期限後は「提供不可」として履歴に残して取り出せます。</li></ol>
  <p className="help-note">「操作を取り消す」では直近50件までの楕円配置・鉄板上の移動を操作順に戻せます。タイマー開始、温度変更、完成ボックスへの移動、提供・提供不可の確定を行うと、それ以前の取り消し履歴は消えます。過密な旧データは位置を保って表示し、新規配置とその鉄板にある楕円の移動はできません。</p>
  {__PAGES_MODE__?<>
    <p className="help-note">調理状態はこのスマートフォンのこのブラウザー内だけに保存され、PC版や別ブラウザーとは共有されません。サイトデータの削除、ブラウザー変更、端末交換で消えることがあります。定期的に「データ管理」からJSONバックアップを保存してください。CSVは完了した実行記録だけの書き出しで、盤面復元には使えません。</p>
    <p className="help-note">調理中は画面を表示してご利用ください。画面ロック中にタイマー通知やアラームを鳴らす保証はありません。新しい版の案内が表示されたら、調理を終えてから「新しい版に更新」を押してください。</p>
  </>:<>
    <p className="help-note">未接続の間は表示のみとなります。パソコンではTabで楕円を選択、Enterで計測開始・下段の調理中楕円の上段移動・焼き上がりの取り出し、左右キーで温度を1℃調整できます。</p>
    <p className="help-note">記録は「記録を書き出す」からExcelで開けるCSVにできます。温度ごとの加熱秒数に加え、焼き上がり・保管・提供の時刻と最終ステータスを出力します。</p>
    <p className="help-note">PC版は通常のブラウザーで利用します。画面ロック中の通知はありません。</p>
  </>}
  <button className="help-done" onClick={()=>setHelp(false)}>わかりました</button></DialogContent></Dialog>
  </div></header>
  {__PAGES_MODE__&&<p className="pages-storage-note" role="note">保存先はこのスマートフォンのこのブラウザーです。サイトデータ削除や端末交換に備え、「データ管理」からJSONバックアップを保存してください。</p>}
 <div className="overview"><p>調理状況</p><div className="totals"><span>待機 <b>{counts.blank}</b></span><span>調理中 <b>{counts.running}</b></span><span>焼き上がり <b className={counts.done?"finished-count":""}>{counts.done}</b></span><span>完成ボックス <b>{completionItems.length}</b></span></div></div>
 {__PAGES_MODE__&&kitchen.statusMessage&&<div className="status-banner" role="alert">{kitchen.statusMessage}</div>}
 {__PAGES_MODE__&&kitchen.recoveryAvailable&&<div className="status-banner" role="alert"><span>編集ロックを保持し、端末の保存領域へ書き込める間は、検証済みJSONバックアップから復旧できます。</span> <button className="update-button" onClick={()=>setDataManagementOpen(true)}>バックアップから復旧</button></div>}
 {gridBlocked&&<div className="grid-capacity-warning" role="status">既存の配置数が6マスを超えている鉄板があります。楕円は元の位置のまま保持しています。新規配置と超過している鉄板からの移動はできません。焼き上がった楕円を完成ボックスへ移すと数が減り、両方の鉄板が6枚以下になると残りを自動でマスへ整理します。</div>}
 {__PAGES_MODE__&&kitchen.cacheState==="preparing"&&<div className="status-banner" role="status">オフライン起動用の画面を準備しています。準備が終わるまでインターネット接続を保ってください。</div>}
 {__PAGES_MODE__&&kitchen.cacheState==="unavailable"&&<div className="status-banner" role="status">オフラインで再起動するための保存に失敗しました。アプリを再読み込みして準備状態を確認してください。</div>}
 {!__PAGES_MODE__&&connection==="unauthorized" && <div className="status-banner">この端末は未登録か、利用期限が切れています。<a href="/register">登録画面を開いてください</a> 管理者から登録コードを受け取ってください。</div>}
 {!__PAGES_MODE__&&connection==="offline" && <div className="status-banner" role="status">接続を確認しています。現在は表示のみです。 <button onClick={()=>void sync()}>再接続</button></div>}
  <section id="completion-box" tabIndex={-1} className="completion-box" aria-label="お好み焼き完成ボックス">
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
  {__PAGES_MODE__&&completionItems.length>0&&<div className="pages-completion-shortcut"><a href="#completion-box" aria-label={`完成ボックスへ。${completionItems.length}個あります。`}><ArrowUp size={16} aria-hidden="true"/><span>完成ボックスへ <b>{completionItems.length}</b></span></a></div>}
  <section className="plates" aria-label="鉄板の操作画面">{([1,2] as const).map(plate=>{
    const plateItems=items.filter(i=>i.plate===plate);
    return <article className="plate-card" key={plate}><header className="plate-heading"><h2><span>0{plate}</span>鉄板 {plate}</h2><span className={plateItems.length>GRID_CELLS.length?"plate-count-overflow":""}>{plateItems.length} / {GRID_CELLS.length} マス</span></header><div className={`plate ${!available?"disabled":""}`}>
   <svg ref={element=>{plateSvgs.current[plate]=element;}} viewBox="0 0 1600 900" role="group" aria-label={`鉄板${plate}。3列2行の6マスです。新しい楕円は下段の空きマスをタップして配置します。下段の待機中の楕円は、同じ列の上段が空いていればタップで移動し、移動後にタップすると計測を開始します。上段が使用中なら下段タップで計測を開始します。下段の調理中の楕円はタップすると同じ列の空いた上段へ移動します。上段は移動先専用で、上段からの移動、左右・同段・鉄板間の移動はできません。`} onPointerDown={e=>down(e,plate)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel} onContextMenu={e=>e.preventDefault()}>
   <rect width="1600" height="900" fill="transparent"/>
   <g className="plate-grid" pointerEvents="none" aria-hidden="true">
     {Array.from({length:GRID_COLUMNS-1},(_,index)=><line key={`column-${index}`} x1={(index+1)*1600/GRID_COLUMNS} y1="0" x2={(index+1)*1600/GRID_COLUMNS} y2="900"/>)}
     {Array.from({length:GRID_ROWS-1},(_,index)=><line key={`row-${index}`} x1="0" y1={(index+1)*900/GRID_ROWS} x2="1600" y2={(index+1)*900/GRID_ROWS}/>)}
     {GRID_CELLS.map(cell=><circle key={cell.index} cx={cell.x*1600} cy={cell.y*900} r="9" className={isGridCellOccupied(items,plate,cell.index)?"plate-grid-center occupied":"plate-grid-center"}/>)}
   </g>
   {plateItems.map(item=>{
     const t=timer(item,now); const cx=item.x*1600,cy=item.y*900,rx=OVAL_RX*1600,ry=OVAL_RY*900;
     const lowerRow=nearestGridCell(item.x,item.y).row===GRID_ROWS-1;
     const upperCell=lowerRow?GRID_CELLS[nearestGridCell(item.x,item.y).index-GRID_COLUMNS]:undefined;
     const upperCellOccupied=t.state==="blank"&&lowerRow&&upperCell?isGridCellActuallyOccupied(items,item.plate,upperCell.index,item.id):false;
     const blankMoveBlockReason=t.state==="blank"&&lowerRow&&upperCell?gridMoveBlockReason(items,item.id,item.plate,upperCell.index):null;
     const blankTapInstruction=t.state!=="blank"?"":!lowerRow?"タップで90秒の計測を開始":!upperCell?"上段の移動先を確認できません":upperCellOccupied?"上段使用中のためタップで計測開始":blankMoveBlockReason?`${gridMoveBlockMessage(blankMoveBlockReason)} 待機状態です`:"タップで上段へ移動。上段で再度タップすると計測開始";
     const timerY=cy+ry*(lowerRow?-0.68:0.68);
     const busy=pendingIds.has(item.id);
     return <g key={item.id} data-item-id={item.id} data-plate={plate} data-state={t.state} data-duration="90" data-temperature={item.temperature} data-version={item.version} className={`oval ${busy?"pending":""}`}>
       <title>{`お好み焼きID: ${item.id}`}</title>
       <defs><clipPath id={`clip-${item.id}`}><ellipse cx={cx} cy={cy} rx={rx} ry={ry}/></clipPath></defs>
       <ellipse role="button" tabIndex={0} aria-disabled={!available||busy} aria-label={`お好み焼きID ${item.id}、${t.state==="blank"?`待機中、温度${item.temperature}度、${blankTapInstruction}`:t.state==="done"?`焼き上がり、温度${item.temperature}度、タップで完成ボックスに移動`:lowerRow?`調理中、残り${t.remaining}秒、温度${item.temperature}度、タップで真上の空きマスへ移動`:`調理中、残り${t.remaining}秒、温度${item.temperature}度、上段からは移動できません`}`} cx={cx} cy={cy} rx={rx} ry={ry} fill={t.state==="done"?"#e13b3b":t.state==="blank"?"#fff":"#0c0d0f"} stroke={pressed===item.id?"#ffb276":"#92989f"} strokeWidth={pressed===item.id?9:4} onKeyDown={e=>keyboard(e,item)}/>
       {t.state==="running"&&<rect x={cx-rx} y={cy-ry} width={rx*2} height={ry*2*t.progress} fill="#fff" clipPath={`url(#clip-${item.id})`} pointerEvents="none"/>}
       {t.state!=="blank"&&<text x={cx} y={timerY} textAnchor="middle" className="oval-number" fontSize="66" fill={t.state==="done"?"#fff":t.progress>(lowerRow?0.16:0.84)?"#16191e":"#fff"} pointerEvents="none">{t.remaining}</text>}
       {t.state!=="done"&&<>
         <g role="button" tabIndex={0} aria-label="温度を1℃下げる" aria-disabled={!available||busy} data-item-action="left" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"left")}>
          <rect x={cx-rx} y={cy-ry-22} width={__PAGES_MODE__?"128":"96"} height={ry*2+44} fill="transparent" pointerEvents="all"/>
           <rect x={cx-rx+9} y={cy-48} width="60" height="96" rx="18" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx-rx+48} ${cy-22} l -22 22 22 22`} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
         <g role="button" tabIndex={0} aria-label="温度を1℃上げる" aria-disabled={!available||busy} data-item-action="right" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"right")}>
          <rect x={cx+rx-(__PAGES_MODE__?128:96)} y={cy-ry-22} width={__PAGES_MODE__?"128":"96"} height={ry*2+44} fill="transparent" pointerEvents="all"/>
           <rect x={cx+rx-69} y={cy-48} width="60" height="96" rx="18" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx+rx-48} ${cy-22} l 22 22 -22 22`} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
       </>}
       {busy&&<circle cx={cx+rx-20} cy={cy-ry+20} r="15" fill="#e6793e"/>}
     </g>;
   })}
   </svg>
    <div className="plate-label-overlay" aria-hidden={!__PAGES_MODE__}>
      {plateItems.map(item=>{
        const lowerRow=nearestGridCell(item.x,item.y).row===GRID_ROWS-1;
        return <div key={`label-${item.id}`} className={`plate-label${lowerRow?" lower":""}`} style={{left:`${item.x*100}%`}}>
          <span className="oval-temperature">{item.temperature}℃</span>
          <span className="oval-id">{item.id}</span>
       </div>;
     })}
   </div>
   {!plateItems.length&&<div className="empty-plate">{snapshot?<Plus size={30} strokeWidth={1}/>:__PAGES_MODE__&&kitchen.recoveryAvailable?<Database size={25}/>:<LoaderCircle className="animate-spin" size={25}/>}<span>{snapshot?"下段の空きマスをタップして配置":__PAGES_MODE__&&kitchen.recoveryAvailable?"データ管理からバックアップを復旧":__PAGES_MODE__?"保存データを読み込み中":"共有データを読み込み中"}</span></div>}
   </div></article>;
 })}</section>
  {__PAGES_MODE__
    ? <footer className="guide pages-guide"><div><span className="guide-mark">1</span><span>下段の空きマスをタップ<b>新しい楕円を置く</b></span></div><div><span className="guide-mark">白</span><span>白い上段楕円をタップ<b>90秒計測を開始</b></span></div><div><span className="guide-mark">移</span><span>下段の楕円をタップ<b>待機中は空き上段へ、調理中も真上へ</b></span></div><div><span className="guide-red-dot" aria-hidden="true"/><span>赤い楕円をタップ<b>完成ボックスへ</b></span></div><div><span className="guide-mark">30</span><span>完成ボックスをタップ<b>提供済み／提供不可</b></span></div><p>上段に空きがない下段の待機中楕円はタップで計測を開始します。楕円の左右にある矢印で、待機中・計測中の温度を1℃ずつ調節できます。焼き上がり後は変更できません。温度は記録用（実測値ではありません）で、計測時間は固定90秒です。</p></footer>
    : <footer className="guide"><div><span className="guide-mark">1</span><span>下段の楕円をタップ<b>空白は配置、待機中は空き上段へ、調理中は真上へ</b></span></div><div><span className="guide-arrows"><ArrowLeft size={19}/><ArrowRight size={19}/></span><span>左右の矢印をタップ<b>温度を1℃調整</b></span></div><div><span className="guide-red-dot" aria-hidden="true"/><span>赤い楕円をタップ<b>完成ボックスへ</b></span></div><div><span className="guide-mark">30</span><span>完成ボックスをタップ<b>提供/提供不可</b></span></div></footer>}
 </main>;
}

export default function Kitchen() {
 return <KitchenView useController={useKitchen}/>;
}

export function PagesKitchen() {
 return <KitchenView useController={useKitchenLocal}/>;
}


