"use client";
import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type ChangeEvent } from "react";
import { CircleHelp, ArrowLeft, ArrowRight, Download, Undo2, RotateCcw, Database, RefreshCw } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { showKitchenError } from "@/lib/kitchen-notification";
import { useKitchen } from "@/lib/use-kitchen";
import { useKitchenLocal } from "@/lib/use-kitchen-local";
import { DOUGH_ID_BLOCK_SIZE, DOUGH_TIMER_BATCH_SIZE, GRID_CELLS, GRID_COLUMNS, GRID_ROWS, MAX_PANCAKE_IDS, OVAL_RX, OVAL_RY, completionStatus, doughBatchStatus, gridCellAt, gridMoveBlockReason, gridRepositionBlockReason, isGridCellActuallyOccupied, isGridCellOccupied, isGridOverCapacity, nearestGridCell, nextDoughBatchFirstOrdinal, timer, parseCommand, type GridMoveBlockReason, type Pancake, type Command, type ExecutionRecord, type Snapshot } from "@/lib/kitchen-model";
import { downloadExecutionRecords } from "@/lib/execution-record-export";
import { createLocalBoardBackup, parseLocalBoardBackup, type ParsedLocalBoardBackup } from "@/lib/local-kitchen-storage";
import { createUuid } from "@/lib/uuid";

type Contact = { pointerId:number; expectedGeneration:number; expectedDoughBatchId:string|null; expectedNextPancakeOrdinal:number; x:number; y:number; max:number; startedAt:number; item:Pancake|null; itemEntityKey:string|null; itemId:string|null; itemVersion:number|null; action:"left"|"right"|null; plate:1|2; targetX:number; targetY:number; holdTimer:number|null; holdCancelled:boolean; longPressArmed:boolean; dragging:boolean };
type DropTarget = {plate:1|2; cellIndex:number; reason:"missing"|"occupied"|"over_capacity"|null};
type MoveCue = {entityKey:string; dragging:boolean; target:DropTarget|null};
type ModelContext = { registerTool:(tool:Record<string,unknown>, options:{signal:AbortSignal}) => unknown };
type KitchenController = {
 snapshot:Snapshot|null;
 now:number;
 connection:"connecting"|"online"|"offline"|"unauthorized";
 pendingIds:Set<string>;
 backupBusy?:boolean;
 recoveryAvailable?:boolean;
 legacyDoughResetRequired?:boolean;
 legacyDoughResetAvailable?:boolean;
 send:(command:Command)=>Promise<Snapshot>;
 restoreBackup?:(backup:ParsedLocalBoardBackup,expectedRevision:number|null)=>Promise<Snapshot>;
 resetLegacyDoughData?:()=>Promise<Snapshot>;
 sync:()=>Promise<void>;
 currentTime:()=>number;
 getSnapshot:()=>Snapshot|null;
 prepareSnapshot?:()=>Promise<Snapshot>;
 prepareExportSnapshot?:()=>Promise<Snapshot>;
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
   source_not_bottom:"短いタップでは上段から移動しません。長押しして空きマスへドラッグしてください。",
   different_plate:"別の鉄板へは移動できません。同じ鉄板で操作してください。",
   wrong_row:"下段から真上の上段マスへのみ移動できます。",
   different_column:"同じ列の真上にあるマスへ移動してください。",
   occupied:"移動先の上段マスは使用中のため移動できません。",
   over_capacity:"既存の過密状態を保持中のため、この鉄板からは移動できません。焼き上がった楕円を完成ボックスへ移してください。",
 };
 return reason?messages[reason]:"このマスへは移動できません。";
}

type DeliveryStatus = "served" | "available" | "unavailable" | "unprepared";
type DeliverySearchMatch = {entityKey:string; status:DeliveryStatus};

function deliveryStatus(record:ExecutionRecord|undefined,inCompletionBox:boolean,now:number):DeliveryStatus {
 if(!record)return "unprepared";
 const state=completionStatus(record,now);
 if(state==="served")return "served";
 if(state==="unavailable"&&record.serveTimerStartedAt!==null&&record.serveDeadlineAt!==null)return "unavailable";
 if(state==="holding"&&inCompletionBox)return "available";
 return "unprepared";
}

function findDeliverySearchMatches(snapshot:Snapshot,searchId:string,now:number):DeliverySearchMatch[] {
 const normalizedId=searchId.trim().toLowerCase();
 const recordsByEntityKey=new Map(snapshot.records.map(record=>[record.entityKey,record]));
 const completionEntityKeys=new Set(snapshot.completionItems.map(item=>item.entityKey));
 const matchesByEntityKey=new Map<string,DeliverySearchMatch>();
 const addMatch=(entityKey:string,status:DeliveryStatus)=>{
   matchesByEntityKey.set(entityKey,{entityKey,status});
 };

 for(const item of snapshot.items){
   if(item.archiveId.toLowerCase()===normalizedId)addMatch(item.entityKey,"unprepared");
 }
 for(const record of snapshot.records){
   if(record.id.toLowerCase()!==normalizedId)continue;
   addMatch(record.entityKey,deliveryStatus(recordsByEntityKey.get(record.entityKey),completionEntityKeys.has(record.entityKey),now));
 }

 if(matchesByEntityKey.size===0)return [{entityKey:"unmatched",status:"unprepared"}];
 return [...matchesByEntityKey.values()];
}

const deliveryStatusLabels:Record<DeliveryStatus,string>={
 served:"提供済み",
 available:"提供可能",
 unavailable:"提供不可能",
 unprepared:"未準備",
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
 const [dataManagementOpen,setDataManagementOpen] = useState(false);
 const [backupDraft,setBackupDraft] = useState<ParsedLocalBoardBackup|null>(null);
 const [backupReading,setBackupReading] = useState(false);
 const [resetConfirmation,setResetConfirmation] = useState(false);
 const [legacyDoughResetConfirmation,setLegacyDoughResetConfirmation] = useState(false);
 const [deliverySearchIds,setDeliverySearchIds] = useState<string[]>([]);
 const [recallM,setRecallM] = useState(1);
 const [recallN,setRecallN] = useState(1);
 const servingEntityKeys=useRef(new Set<string>());
 const searching=useRef(false);
 const resetSubmitting=useRef(false);
 const contact = useRef<Contact|null>(null);
 const backupFileInput = useRef<HTMLInputElement|null>(null);
 useEffect(()=>()=>{
   const current=contact.current;
   if(current?.holdTimer!==null&&current?.holdTimer!==undefined)window.clearTimeout(current.holdTimer);
   contact.current=null;
 },[]);
 const [pressed,setPressed] = useState<string|null>(null);
 const [moveCue,setMoveCue] = useState<MoveCue|null>(null);
 const plateSvgs = useRef<Partial<Record<1|2,SVGSVGElement|null>>>({});
 const actions = useRef(kitchen);
 useEffect(()=>{actions.current=kitchen;},[kitchen]);
 const available = connection === "online" && !kitchen.backupBusy;
 const canRestoreBoard = !kitchen.legacyDoughResetRequired && Boolean(kitchen.recoveryAvailable || (snapshot && available));
 const observedGeneration = useRef<number|null>(snapshot?.generation ?? null);
 useEffect(()=>{
   const nextGeneration=snapshot?.generation ?? null;
   if(observedGeneration.current===nextGeneration&&available)return;
   observedGeneration.current=nextGeneration;
   cancelActiveContact();
 },[snapshot?.generation,available]);
 useEffect(()=>{
   const current=contact.current;
   if(!current?.itemEntityKey)return;
   const latest=snapshot?.items.find(item=>item.entityKey===current.itemEntityKey);
   if(!latest||latest.id!==current.itemId||latest.version!==current.itemVersion)cancelActiveContact();
 },[snapshot?.items]);
 const items = snapshot?.items ?? [];
 const gridBlocked = isGridOverCapacity(items);
 const completionItems = snapshot?.completionItems ?? [];
 const recallId = `${recallM}-${recallN}`;
 const doughBatch = __PAGES_MODE__ ? snapshot?.doughBatch ?? null : null;
 const doughStatus = doughBatchStatus(doughBatch,now);
 const nextDoughFirstOrdinal = (doughStatus==="expired"||doughStatus==="complete")&&doughBatch
   ? doughBatch.firstPancakeOrdinal+DOUGH_TIMER_BATCH_SIZE
   : snapshot ? nextDoughBatchFirstOrdinal(snapshot.nextPancakeOrdinal) : null;
 const canStartNextDoughBatch = nextDoughFirstOrdinal !== null && nextDoughFirstOrdinal + DOUGH_TIMER_BATCH_SIZE - 1 <= MAX_PANCAKE_IDS;
 const counts = {blank:0,running:0,done:0};
 items.forEach(item=>counts[timer(item,now).state]++);
  const records = snapshot?.records ?? [];
  const deliverySearchMatches = snapshot ? deliverySearchIds.flatMap(searchId=>findDeliverySearchMatches(snapshot,searchId,now).map(match=>({...match,searchId}))) : [];
  const isItemPending=(item:{id:string;entityKey:string})=>pendingIds.has(__PAGES_MODE__?item.entityKey:item.id);
  useScreenWakeLock(__PAGES_MODE__&&counts.running>0);

 useEffect(()=>{
   const context = (document as Document & {modelContext?:ModelContext}).modelContext;
   if (__PAGES_MODE__ || !context?.registerTool) return;
   const lifecycle = new AbortController();
   const register = (tool:Record<string,unknown>) => {
     try { void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{}); } catch {}
   };
   register({name:"read_kitchen",title:"鉄板の状態を確認",description:"共有されている2枚の鉄板、お好み焼きの位置・温度・固定90秒タイマー、内部で保管する完成品（isRecalledがtrueなら表示中）と30分期限、および実行記録を取得します。",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:async()=>{
     await actions.current.sync();
     return actions.current.getSnapshot();
   }});
   register({name:"operate_kitchen",title:"お好み焼きを操作",description:"楕円の追加(create)、固定90秒計測の開始(start)、温度を1℃変更(adjust)、同じ鉄板の下段から同じ列の空いた上段へのタップ移動(move)、両鉄板の空きマスへの長押し移動(reposition)、焼き上がり楕円の回収と内部30分計測開始(remove)、現在の画面IDの完成品タイマー呼び出し(recall)、表示した完成品の提供/提供不可確定(remove)、直近の配置・移動の取り消し(undo)を実行します。新規配置は下段の空きマスのみです。画面では下段の待機中楕円は、同じ列の上段が空いていれば最初のタップでタイマーを始めず上段へ移動し、上段でタップすると計測を開始します。上段が使用中なら下段でタップして計測を開始します。下段の調理中の楕円をタップすると同じ鉄板・同じ列の空いた上段へ移動します。上段は移動先専用で、新規配置はできません。短いタップのmoveは下段から同じ列の上段のみです。repositionは白・調理中・焼き上がりの楕円を両鉄板の空きマスへ移動でき、タイマー起点・温度区間・各識別子は維持します。取り消しは直近50件までで、タイマー開始・温度変更・完成ボックス移動・提供操作を行うと、それ以前の取り消し履歴は消えます。画面と同じ共有データを変更します。operationIdはUUID v4です。read_kitchenで取得したgenerationをexpectedGenerationに必ず指定してください。undoではread_kitchenのundoHistory末尾にあるoperationIdをexpectedUndoOperationIdへ指定します。createでは下段の座標を指定し、idは指定せず、配置順に採番します。他の操作には対象のidと取得したversionをexpectedVersionで指定します。repositionとrecallでは対象のentityKeyをexpectedEntityKeyへ必ず指定します。呼び出しはisRecalledだけを変更し、期限と提供状態は変えません。",inputSchema:{type:"object",properties:{operationId:{type:"string"},expectedGeneration:{type:"integer",minimum:0},type:{enum:["create","start","adjust","move","reposition","remove","recall","undo"]},id:{type:"string"},plate:{enum:[1,2]},x:{type:"number",minimum:0,maximum:1},y:{type:"number",minimum:0,maximum:1},expectedVersion:{type:"integer",minimum:1},expectedEntityKey:{type:"string"},expectedUndoOperationId:{type:"string"},delta:{enum:[-1,1]}},required:["operationId","type","expectedGeneration"],additionalProperties:false},annotations:{readOnlyHint:false},execute:async(input:unknown)=>{
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
   catch(error) { showKitchenError(error instanceof Error?error.message:"操作を保存できませんでした。"); return; }
   void operation.catch(()=>{}); };
 function serveCompletion(entityKey:string) {
   const controller=actions.current;
   const latest=controller.getSnapshot();
   const item=latest?.completionItems.find(item=>item.entityKey===entityKey);
   const record=latest?.records.find(record=>record.entityKey===entityKey);
   if(!latest||!item||controller.connection!=="online"||controller.backupBusy||servingEntityKeys.current.has(entityKey)
     ||controller.pendingIds.has(__PAGES_MODE__?entityKey:item.id)||deliveryStatus(record,true,controller.currentTime())!=="available")return;
   servingEntityKeys.current.add(entityKey);
   try {
     void controller.send({operationId:createUuid(),type:"remove",id:item.id,expectedVersion:item.version,expectedGeneration:latest.generation})
       .catch(()=>{}).finally(()=>servingEntityKeys.current.delete(entityKey));
   } catch(error) {
     servingEntityKeys.current.delete(entityKey);
     showKitchenError(error instanceof Error?error.message:"提供を保存できませんでした。");
   }
 }
 async function searchDelivery() {
   if(searching.current)return;
   searching.current=true;
   const searchId=recallId;
   const controller=actions.current;
   try {
     if(__PAGES_MODE__&&controller.prepareSnapshot){
       const latest=await controller.prepareSnapshot();
       const keys=findDeliverySearchMatches(latest,searchId,controller.currentTime()).map(match=>match.entityKey);
       for(const entityKey of keys){
         const current=controller.getSnapshot();
         const item=current?.completionItems.find(item=>item.entityKey===entityKey);
         const record=current?.records.find(record=>record.entityKey===entityKey);
         if(!current||!item||item.isRecalled!==false||deliveryStatus(record,true,controller.currentTime())!=="available")continue;
         try {
           await controller.send({operationId:createUuid(),type:"recall",id:item.id,expectedVersion:item.version,expectedGeneration:current.generation,expectedEntityKey:entityKey});
         } catch(error) {
           // The deadline may arrive while the recall waits in the save queue.
           // A confirmed automatic settlement is a valid search result.
           const settled=controller.getSnapshot()?.records.find(record=>record.entityKey===entityKey);
           if(settled?.servedAt===null||settled?.servedAt===undefined||controller.getSnapshot()?.completionItems.some(item=>item.entityKey===entityKey))throw error;
         }
       }
       await controller.prepareSnapshot();
     }
     setDeliverySearchIds(ids=>[searchId,...ids.filter(id=>id!==searchId)].slice(0,5));
   } catch(error) {
     showKitchenError(error instanceof Error?error.message:"検索履歴を保存できませんでした。");
   } finally { searching.current=false; }
 }
 async function exportRecords() {
    try {
      const current=kitchen.prepareExportSnapshot?await kitchen.prepareExportSnapshot():kitchen.getSnapshot();
      if (!current?.records.length) return;
      downloadExecutionRecords(current.records, kitchen.prepareExportSnapshot?current.serverNow:kitchen.currentTime());
    } catch(error) { showKitchenError(error instanceof Error?error.message:"実行記録を書き出せませんでした。"); }
  }
  async function exportBoardBackup() {
    try {
      const current=kitchen.prepareExportSnapshot?await kitchen.prepareExportSnapshot():kitchen.getSnapshot();
      if (!current) return;
      const content = createLocalBoardBackup(current, kitchen.prepareExportSnapshot?current.serverNow:kitchen.currentTime());
      const date = new Date(kitchen.currentTime()).toISOString().slice(0,10);
      const url = URL.createObjectURL(new Blob([content], {type:"application/json;charset=utf-8"}));
      const link = document.createElement("a");
      link.href = url;
      link.download = `teppan-timer-pages-backup-${date}.json`;
      link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch (error) {
      showKitchenError(error instanceof Error?error.message:"バックアップを書き出せませんでした。");
    }
  }
  function selectBackupFile(event:ChangeEvent<HTMLInputElement>) {
    const input=event.currentTarget;
    const file=input.files?.[0];
    input.value="";
    if(!file)return;
    setBackupDraft(null);
    if(file.size>10*1024*1024){showKitchenError("バックアップファイルは10MB以下を選んでください。現在の盤面は変更していません。");return;}
    setBackupReading(true);
    void file.text().then(parseLocalBoardBackup).then(backup=>{
      setBackupDraft(backup);
    }).catch(error=>{
      showKitchenError(error instanceof Error?error.message:"バックアップを読み込めませんでした。現在の盤面は変更していません。");
    }).finally(()=>setBackupReading(false));
  }
  function restoreBoardBackup() {
    if(!backupDraft||!canRestoreBoard||!kitchen.restoreBackup||pendingIds.size>0)return;
    const expectedRevision=kitchen.recoveryAvailable?null:snapshot?.revision??null;
    void kitchen.restoreBackup(backupDraft,expectedRevision).then(()=>{
      setBackupDraft(null);
      setDataManagementOpen(false);
    }).catch(()=>{});
  }
 function confirmReset() {
   if(!snapshot||!available||pendingIds.size>0||resetSubmitting.current)return;
   resetSubmitting.current=true;
   void send({operationId:createUuid(),type:"reset",expectedGeneration:snapshot.generation}).then(()=>{
     setResetConfirmation(false);
   }).catch(()=>{}).finally(()=>{resetSubmitting.current=false;});
 }
 function confirmLegacyDoughReset() {
   if(!kitchen.legacyDoughResetRequired||!kitchen.legacyDoughResetAvailable||!kitchen.resetLegacyDoughData||pendingIds.size>0||resetSubmitting.current)return;
   resetSubmitting.current=true;
   let operation:Promise<Snapshot>;
   try { operation=kitchen.resetLegacyDoughData(); }
   catch(error) { resetSubmitting.current=false; showKitchenError(error instanceof Error?error.message:"全体リセットを開始できませんでした。"); return; }
   void operation.then(()=>{
     setLegacyDoughResetConfirmation(false);
   }).catch(()=>{}).finally(()=>{resetSubmitting.current=false;});
 }
 function changeDoughBatch(type:"doughStart"|"doughReset"|"doughDiscardAndStart") {
   if(!snapshot||!available||pendingIds.size>0)return;
   const current=snapshot.doughBatch??null;
   if(type!=="doughStart"&&!current)return;
   const operationId=createUuid();
   if(type==="doughStart") run({operationId,type,expectedGeneration:snapshot.generation,expectedDoughBatchId:null,expectedNextPancakeOrdinal:snapshot.nextPancakeOrdinal});
   else if(current) run({operationId,type,expectedGeneration:snapshot.generation,expectedDoughBatchId:current.batchId,expectedNextPancakeOrdinal:snapshot.nextPancakeOrdinal});
 }
 function perform(item:Pancake, action:string, expectedGeneration?:number) {
   const current = timer(item,kitchen.currentTime());
   const base = {operationId:createUuid(),id:item.id,expectedVersion:item.version,...(expectedGeneration===undefined?{}:{expectedGeneration})};
   if (action==="tap" && current.state==="blank") {
     const source=nearestGridCell(item.x,item.y);
     if(source.row===GRID_ROWS-1) {
       const target=GRID_CELLS[source.index-GRID_COLUMNS];
       if(!target) { showKitchenError("真上の移動先を確認できませんでした。"); return; }
       if(isGridCellActuallyOccupied(items,item.plate,target.index,item.id)) { run({...base,type:"start"}); return; }
       const reason=gridMoveBlockReason(items,item.id,item.plate,target.index);
       if(reason) { showKitchenError(gridMoveBlockMessage(reason)); return; }
       run({...base,type:"move",plate:item.plate,x:target.x,y:target.y});
       return;
     }
     run({...base,type:"start"});
   }
   else if (action==="tap" && current.state==="running") {
     const source=nearestGridCell(item.x,item.y);
     if(source.row!==GRID_ROWS-1) { showKitchenError("短いタップでは上段から移動しません。長押しして空きマスへドラッグしてください。"); return; }
     const target=GRID_CELLS[source.index-GRID_COLUMNS];
     if(!target) { showKitchenError("真上の移動先を確認できませんでした。"); return; }
     const reason=gridMoveBlockReason(items,item.id,item.plate,target.index);
     if(reason) { showKitchenError(gridMoveBlockMessage(reason)); return; }
     run({...base,type:"move",plate:item.plate,x:target.x,y:target.y});
   }
   else if ((action==="left"||action==="right") && current.state!=="done") run({...base,type:"adjust",delta:action==="right"?1:-1});
   else if ((action==="tap"||action==="up") && current.state==="done") run({...base,type:"remove"});
 }
 function clearHoldTimer(current:Contact) {
   if(current.holdTimer!==null)window.clearTimeout(current.holdTimer);
   current.holdTimer=null;
 }
 function findDropTarget(clientX:number,clientY:number,entityKey:string):DropTarget|null {
   const latest=actions.current.getSnapshot();
   const item=latest?.items.find(candidate=>candidate.entityKey===entityKey);
   if(!latest||!item)return null;
   for(const plate of [1,2] as const) {
     const svg=plateSvgs.current[plate];
     if(!svg)continue;
     const bounds=svg.getBoundingClientRect();
     if(bounds.width<=0||bounds.height<=0||clientX<bounds.left||clientX>=bounds.right||clientY<bounds.top||clientY>=bounds.bottom)continue;
     const transform=svg.getScreenCTM();
     if(!transform)continue;
     const point=new DOMPoint(clientX,clientY).matrixTransform(transform.inverse());
     if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<0||point.x>=1600||point.y<0||point.y>=900)continue;
     const cell=gridCellAt(point.x/1600,point.y/900);
     return {plate,cellIndex:cell.index,reason:gridRepositionBlockReason(latest.items,item.id,plate,cell.index)};
   }
   return null;
 }
 function armLongPress(current:Contact) {
   if(!current.itemEntityKey||!current.itemId)return false;
   const controller=actions.current;
   const latest=controller.getSnapshot();
   const item=latest?.items.find(candidate=>candidate.entityKey===current.itemEntityKey);
   if(controller.connection!=="online"||controller.backupBusy||latest?.generation!==current.expectedGeneration
     ||(latest?.doughBatch?.batchId??null)!==current.expectedDoughBatchId
     ||latest?.nextPancakeOrdinal!==current.expectedNextPancakeOrdinal
     ||!item||item.id!==current.itemId||item.version!==current.itemVersion||(__PAGES_MODE__?controller.pendingIds.has(item.entityKey):controller.pendingIds.has(item.id)))return false;
   current.longPressArmed=true;
   setMoveCue({entityKey:current.itemEntityKey,dragging:false,target:null});
   return true;
 }
 function scheduleLongPress(current:Contact) {
   const remaining=Math.max(0,450-(performance.now()-current.startedAt));
   current.holdTimer=window.setTimeout(()=>{
     current.holdTimer=null;
     if(contact.current!==current||current.holdCancelled||current.max>=12||!current.itemEntityKey||!current.itemId)return;
     if(performance.now()-current.startedAt<450){scheduleLongPress(current);return;}
     armLongPress(current);
   },remaining);
 }
 function cancelActiveContact() {
   const current=contact.current;
   contact.current=null;
   if(current) {
     clearHoldTimer(current);
     for(const svg of Object.values(plateSvgs.current)) {
       if(svg?.hasPointerCapture(current.pointerId)) svg.releasePointerCapture(current.pointerId);
     }
   }
   setPressed(null);
   setMoveCue(null);
 }
 function down(event:PointerEvent<SVGSVGElement>,plate:1|2) {
   const expectedGeneration=snapshot?.generation;
   if (!available || expectedGeneration===undefined || !event.isPrimary || event.button!==0 || contact.current) return;
   const element = event.target as Element;
   const target = element.closest("[data-item-key]");
   const item = items.find(i=>i.entityKey===target?.getAttribute("data-item-key")) ?? null;
   if (item && isItemPending(item)) return;
   const action = element.closest("[data-item-action]")?.getAttribute("data-item-action");
   const bounds=event.currentTarget.getBoundingClientRect();
   const targetX=(event.clientX-bounds.left)/bounds.width,targetY=(event.clientY-bounds.top)/bounds.height;
   const current:Contact={pointerId:event.pointerId,expectedGeneration,expectedDoughBatchId:snapshot?.doughBatch?.batchId??null,expectedNextPancakeOrdinal:snapshot?.nextPancakeOrdinal??1,x:event.clientX,y:event.clientY,max:0,startedAt:performance.now(),item,itemEntityKey:item?.entityKey??null,itemId:item?.id??null,itemVersion:item?.version??null,action:action==="left"||action==="right"?action:null,plate,targetX,targetY,holdTimer:null,holdCancelled:false,longPressArmed:false,dragging:false};
   contact.current=current;
   setPressed(item?.entityKey??null);
   setMoveCue(null);
   event.currentTarget.setPointerCapture(event.pointerId);
   if(item&&!current.action)scheduleLongPress(current);
 }
 function move(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if(!c||c.pointerId!==event.pointerId) return;
   c.max=Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y));
   if(c.item&&!c.action) {
     if(!c.longPressArmed&&c.max>=12&&!c.holdCancelled) {
       const elapsed=performance.now()-c.startedAt;
       if(elapsed>=450)armLongPress(c);
       if(!c.longPressArmed){c.holdCancelled=true;clearHoldTimer(c);}
     }
     if(c.longPressArmed&&c.max>=12) {
       c.dragging=true;
       const target=findDropTarget(event.clientX,event.clientY,c.itemEntityKey!);
       setMoveCue(previous=>previous?.entityKey===c.itemEntityKey&&previous.dragging
         &&previous.target?.plate===target?.plate&&previous.target?.cellIndex===target?.cellIndex&&previous.target?.reason===target?.reason
         ? previous : {entityKey:c.itemEntityKey!,dragging:true,target});
     }
   }
 }
 function up(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if (!c || c.pointerId!==event.pointerId) return;
   c.max=Math.max(c.max,Math.hypot(event.clientX-c.x,event.clientY-c.y));
   const heldLongEnough=performance.now()-c.startedAt>=450;
   if(c.item&&!c.action&&!c.holdCancelled&&heldLongEnough&&!c.longPressArmed)armLongPress(c);
   const isLongPressGesture=Boolean(c.item&&!c.action&&(c.longPressArmed||(!c.holdCancelled&&heldLongEnough)));
   const dropTarget=isLongPressGesture&&c.dragging&&c.itemEntityKey ? findDropTarget(event.clientX,event.clientY,c.itemEntityKey) : null;
   contact.current=null; clearHoldTimer(c); setPressed(null); setMoveCue(null);
   if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
   const latestSnapshot=actions.current.getSnapshot();
   if(!available||latestSnapshot?.generation!==c.expectedGeneration
     || (latestSnapshot?.doughBatch?.batchId??null)!==c.expectedDoughBatchId
     || latestSnapshot?.nextPancakeOrdinal!==c.expectedNextPancakeOrdinal) return;
   if(c.itemEntityKey) {
     const latestItem=latestSnapshot?.items.find(item=>item.entityKey===c.itemEntityKey);
     if(!latestItem||latestItem.id!==c.itemId||latestItem.version!==c.itemVersion)return;
   }
   if(isLongPressGesture&&c.longPressArmed&&c.dragging&&dropTarget&&c.itemId&&c.itemEntityKey&&c.itemVersion!==null) {
     if(dropTarget.reason){
       showKitchenError(dropTarget.reason==="occupied"?"このマスは使用中です。元の位置に戻しました。":dropTarget.reason==="over_capacity"?"6マスを超える配置を保持しているため移動できません。":"移動するお好み焼きを確認できません。");
       return;
     }
     const destination=GRID_CELLS[dropTarget.cellIndex];
     const latestItem=latestSnapshot?.items.find(item=>item.entityKey===c.itemEntityKey);
     if(latestItem&&latestItem.plate===dropTarget.plate&&nearestGridCell(latestItem.x,latestItem.y).index===destination.index)return;
     run({operationId:createUuid(),type:"reposition",id:c.itemId,expectedEntityKey:c.itemEntityKey,expectedVersion:c.itemVersion,expectedGeneration:c.expectedGeneration,plate:dropTarget.plate,x:destination.x,y:destination.y});
     return;
   }
   if(isLongPressGesture)return;
   if(c.max>=12) return;
   if(c.item&&!c.action&&performance.now()-c.startedAt>=450) return;
   if(c.item) perform(c.item,c.action??"tap",c.expectedGeneration);
   else {
     const cell=gridCellAt(c.targetX,c.targetY);
     if(cell.row!==GRID_ROWS-1) { showKitchenError("上段は移動専用です。下段に配置するか、下段から同じ列の上段へ移動してください。"); return; }
     if(gridBlocked) { showKitchenError("各鉄板が6枚以下になるまで配置できません。"); return; }
     if(isGridCellOccupied(items,c.plate,cell.index)) { showKitchenError("このマスにはすでに楕円があります。空いているマスをタップしてください。"); return; }
     if(__PAGES_MODE__&&doughStatus!=="active") {
       showKitchenError(doughStatus==="not_started"?"配置前に生地欄をタップしてください。":doughStatus==="expired"?"生地期限切れ。生地欄をタップして廃棄・再開してください。":"生地欄をタップして次の6個を開始してください。");
       return;
     }
     run({operationId:createUuid(),expectedGeneration:c.expectedGeneration,type:"create",plate:c.plate,x:cell.x,y:cell.y,...(__PAGES_MODE__?{expectedDoughBatchId:c.expectedDoughBatchId,expectedNextPancakeOrdinal:c.expectedNextPancakeOrdinal}:{})});
   }
 }
 function cancel(event:PointerEvent<SVGSVGElement>) {
   const c=contact.current;
   if(!c||c.pointerId!==event.pointerId) return;
   contact.current=null; clearHoldTimer(c); setPressed(null); setMoveCue(null);
 }
 function keyboard(event:KeyboardEvent<SVGElement>,item:Pancake,controlAction?:"left"|"right") {
   if(!available||isItemPending(item))return;
   const action=controlAction
     ? (event.key==="Enter"||event.key===" "?controlAction:undefined)
     : ({"Enter":"tap"," ":"tap","ArrowLeft":"left","ArrowRight":"right","ArrowUp":"up"} as Record<string,string>)[event.key];
   if(action){event.preventDefault();perform(item,action);}
 }
  const latestUndo=snapshot?.undoHistory.at(-1);
  const doughRemainingSeconds=doughBatch?Math.ceil(Math.max(0,doughBatch.deadlineAt-(doughBatch.completedAt??now))/1000):20*60;
  const doughRemainingLabel=`${String(Math.floor(doughRemainingSeconds/60)).padStart(2,"0")}:${String(doughRemainingSeconds%60).padStart(2,"0")}`;
  const doughPlacedCount=doughBatch?.placedEntityKeys.length??0;
  return <main className={`kitchen${__PAGES_MODE__?" pages-kitchen":""}`}>
 <Toaster className="kitchen-notifications" position="bottom-right" theme="light" visibleToasts={1} duration={2500} offset={8} mobileOffset={8} toastOptions={{closeButton:false}}/>
 <div className="workspace-controls">
 <div className="control-left">
 <header className="topbar">
 <button className="update-button undo-button" aria-label="直前の操作を取り消す" title="戻る" disabled={!available||pendingIds.size>0||!latestUndo} onClick={()=>{if(latestUndo&&snapshot)run({operationId:createUuid(),type:"undo",expectedGeneration:snapshot.generation,expectedUndoOperationId:latestUndo.operationId});}}><Undo2 size={18}/></button>
 <div className="top-actions">
 {__PAGES_MODE__&&kitchen.updateReady&&<button className="update-button" aria-label="新しい版に更新" title="新しい版に更新" disabled={counts.running>0} onClick={()=>kitchen.applyUpdate?.()}><RefreshCw size={15}/></button>}
 <button className="update-button export-button" aria-label="実行記録をExcel用CSVに書き出す" title="実行記録CSV" disabled={!snapshot||records.length===0} onClick={exportRecords}><Download size={15}/></button>
  <Dialog open={resetConfirmation} onOpenChange={setResetConfirmation}>
    <DialogTrigger asChild><button className="update-button export-button reset-button" aria-label="全体リセット" title="全体リセット" disabled={!snapshot||!available||pendingIds.size>0}><RotateCcw size={15}/></button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>全体リセット</DialogTitle><DialogDescription>鉄板・完成品・記録・取り消し履歴{__PAGES_MODE__?"・生地タイマー":""}を消去し、IDを1-1から再開します。取り消せません。</DialogDescription></DialogHeader>
      <div className="reset-confirmation"><button className="update-button reset-confirm" disabled={!available||pendingIds.size>0||resetSubmitting.current} onClick={confirmReset}>初期化を確定</button><button className="reset-cancel" disabled={pendingIds.size>0||resetSubmitting.current} onClick={()=>setResetConfirmation(false)}>キャンセル</button></div>
    </DialogContent>
  </Dialog>
  {__PAGES_MODE__&&<Dialog open={dataManagementOpen} onOpenChange={open=>{setDataManagementOpen(open);if(!open){setBackupDraft(null);setBackupReading(false);}}}>
    <DialogTrigger asChild><button className="update-button export-button data-management-trigger" aria-label="データ管理" title="データ管理" disabled={!canRestoreBoard}><Database size={15}/></button></DialogTrigger>
    <DialogContent className="data-management-dialog">
      <DialogHeader><DialogTitle>データ管理</DialogTitle><DialogDescription className="sr-only">バックアップと記録の操作</DialogDescription></DialogHeader>
      <div className="data-management-actions">
        <button type="button" className="data-action-button" disabled={!snapshot||!available} onClick={exportBoardBackup}><Database size={18}/><span><strong>盤面バックアップを保存</strong></span></button>
        <button type="button" className="data-action-button" disabled={!snapshot||!available||records.length===0} onClick={exportRecords}><Download size={18}/><span><strong>実行記録CSVを書き出す</strong></span></button>
        <input ref={backupFileInput} className="backup-file-input" type="file" accept=".json,application/json" aria-label="JSONバックアップファイル" onChange={selectBackupFile}/>
        <button type="button" className="data-action-button" disabled={!canRestoreBoard||backupReading||pendingIds.size>0} onClick={()=>backupFileInput.current?.click()}><Download size={18}/><span><strong>{backupReading?"バックアップを確認中…":kitchen.recoveryAvailable?"JSONバックアップを選んで復旧":"JSONバックアップを選んで復元"}</strong></span></button>
      </div>
      {backupDraft&&<section className="backup-preview" aria-live="polite">
        <h3>復元するバックアップ</h3>
        <p>作成日時：{new Date(backupDraft.exportedAt).toLocaleString("ja-JP")}</p>
        <p>読み込み後：鉄板上の楕円 {backupDraft.snapshot.items.length}枚・完成ボックス {backupDraft.snapshot.completionItems.length}個・実行記録 {backupDraft.snapshot.records.length}件</p>
        <p>生地セット：{backupDraft.snapshot.doughBatch?`配置済み ${backupDraft.snapshot.doughBatch.placedEntityKeys.length}/${DOUGH_TIMER_BATCH_SIZE}個・期限 ${localClockLabel(backupDraft.snapshot.doughBatch.deadlineAt)}`:"未開始"}</p>
        {kitchen.recoveryAvailable
          ? <p>置き換え対象：現在の保存データを読み込めません（バックアップから復旧）</p>
          : <p>置き換え対象：鉄板上の楕円 {items.length}枚・完成ボックス {completionItems.length}個・実行記録 {records.length}件</p>}
        <p>現在の保存データをこの内容に置き換えます。内容を確認して確定してください。</p>
        <div><button type="button" className="reset-cancel" disabled={kitchen.backupBusy} onClick={()=>setBackupDraft(null)}>キャンセル</button><button type="button" className="backup-restore-button" disabled={!canRestoreBoard||pendingIds.size>0||kitchen.backupBusy} onClick={restoreBoardBackup}>{kitchen.recoveryAvailable?"このバックアップで復旧":"このデータに置き換える"}</button></div>
      </section>}
    </DialogContent>
  </Dialog>}
  <Dialog open={help} onOpenChange={setHelp}><DialogTrigger asChild><button className="icon-button" aria-label="使い方"><CircleHelp size={21}/></button></DialogTrigger><DialogContent className="help-dialog"><DialogHeader><DialogTitle>鉄板タイマーの使い方</DialogTitle><DialogDescription>{__PAGES_MODE__?"調理状態は、このスマートフォンのこのブラウザー内だけに保存されます。":"同じ画面を開いたスマホで、調理の状態を共有できます。"}</DialogDescription></DialogHeader>
  <ol className="help-list"><li>鉄板は縦2行・横3列の6マスです。新しい楕円は下段の空きマスをタップして配置します。上段は移動先専用で、新しい楕円は配置できません。</li><li>下段の待機中の楕円は、同じ鉄板・同じ列の上段が空いていればタップで上段へ移動します。上段が埋まっている場合は計測を始めます。移動できない配置の場合は元の場所に残り、理由を表示します。上段の待機中の楕円をタップすると固定90秒の計測が始まります。調理中の下段の楕円をタップすると、同じ鉄板・同じ列の真上にある空き上段マスへ移動します。移動先が使用中、または鉄板が過密の場合は移動せず、理由を表示します。上段の楕円は短いタップでは移動しません。</li><li>白・調理中・焼き上がりの楕円は、450ミリ秒以上長押ししてからドラッグすると、どちらの鉄板の空きマスにも移動できます。使用中のマス、鉄板間の隙間、鉄板の外で離すと元の場所に戻ります。長押し移動では計測を開始せず、焼き上がりも回収しません。移動は左上の戻る矢印で元に戻せます。楕円の削除機能はありません。</li><li>楕円の左右にある矢印をタップすると、待機中・計測中の温度を1℃ずつ変更できます。焼き上がり後は変更できません。初期値は96℃です。この温度は設定・記録用で、センサーの実測値ではありません。計測時間は常に90秒です。</li><li>残り0秒で楕円が赤くなります。赤い楕円をタップすると回収し、内部で30分の提供タイマーが始まります。上部の呼び出しエリアで、上の左右矢印でm、下の左右矢印でnを選び、中央のIDをタップすると完成ボックスに指定IDと提供状況を表示します。新しく呼び出したIDを上に、最大5件を縦に表示します。6件目からは最も古い表示を外します。同じIDの再呼び出しは重複せず先頭へ移ります。表示を外しても完成品や記録は消えません。矢印だけでは表示中の結果は変わりません。提供可能なら元の提供期限までの残り時間と「提供」ボタンが表示され、押すと提供済みになります。確認しても期限は延長されません。{__PAGES_MODE__?"30分間一度も検索されなかった完成品は期限時刻に提供済みになります。一度でも検索した完成品は期限切れで提供不可能になります。検索履歴は表示解除・再読込でも保持します。以前の保存データの保管品は検索履歴が不明なため、従来どおり期限切れで提供不可能になります。":"期限切れは提供不可能です。"}まだ回収していないIDや該当しないIDは未準備です。</li>{__PAGES_MODE__&&<li>生地欄は未使用の残数 n/6 と残り時間だけを表示します。未開始は6/6・20:00で、生地欄全体をタップすると20分計測を開始します。計測中は生地欄を押せません。鉄板への新規配置が保存された時だけ残数が減り、加熱開始や移動では減りません。20分を過ぎると新規配置できず、生地欄をタップすると残りを廃棄し次の6個を開始します。6個を置き切った後も生地欄をタップして次の6個分を開始します。24個のID区間は6個ずつ4回のタイマーで使い切ります。90秒の加熱タイマーとは別です。</li>}</ol>
  <p className="help-note">左上の戻る矢印では直近50件までの楕円配置・鉄板上の移動を操作順に戻せます。以前の保存データに残る削除履歴も復元できます。タイマー開始、温度変更、完成ボックスへの移動、提供・提供不可の確定を行うと、それ以前の取り消し履歴は消えます。過密な旧データは位置を保って表示し、新規配置とその鉄板にある楕円の移動はできません。</p>
  <p className="help-note">鉄板・呼び出し・完成ボックス・CSVのIDは同じ安定した番号です。提供や取り消しによって他のIDは詰め直しません。実行記録CSVはIDごとに1行、10列です。以前の保存データでUUID形式のIDが残る場合はCSVに保持されますが、数値のm/n呼び出しでは照会できません。鉄板投入時刻は配置の保存時、下段→上段移動時刻は移動の保存時に記録します。以前のデータなど時刻を取得できない場合は空欄です。移動を取り消すと移動前の時刻へ戻ります。「温度区間(℃・開始順)」は開始順のリストで、区切りは「 | 」です。温度不明の区間は「温度不明」として残ります。タイマー開始・回収・提供の時刻、30分タイマー停止時刻、最終ステータス、提供不可理由も記録ごとに1回出力します。</p>
  {__PAGES_MODE__?<>
    <p className="help-note">調理状態はこのスマートフォンのこのブラウザー内だけに保存され、PC版や別ブラウザーとは共有されません。サイトデータの削除、ブラウザー変更、端末交換で消えることがあります。定期的に「データ管理」からJSONバックアップを保存してください。CSVは完了した実行記録だけの書き出しで、盤面復元には使えません。</p>
    {kitchen.cacheState!=="ready"&&<p className="help-note">{kitchen.cacheState==="preparing"?"オフライン起動用の画面を準備しています。完了までインターネット接続を保ってください。":"オフライン起動用の保存を確認できません。必要に応じて再読み込みしてください。"}</p>}
    <p className="help-note">調理中は画面を表示してご利用ください。画面ロック中にタイマー通知やアラームを鳴らす保証はありません。上部に更新アイコンが表示されたら、調理を終えてから押してください。</p>
  </>:<>
    <p className="help-note">未接続の間は表示のみとなります。パソコンではTabで楕円を選択、Enterで計測開始・下段の調理中楕円の上段移動・焼き上がりの取り出し、左右キーで温度を1℃調整できます。</p>
    <p className="help-note">PC版は通常のブラウザーで利用します。画面ロック中の通知はありません。</p>
  </>}
  <button className="help-done" onClick={()=>setHelp(false)}>わかりました</button></DialogContent></Dialog>
  </div></header>
 {__PAGES_MODE__&&<button type="button" className={`dough-timer-card dough-${doughStatus}`} disabled={!snapshot||!available||pendingIds.size>0||doughStatus==="active"||!canStartNextDoughBatch} aria-label={`生地 残り${DOUGH_TIMER_BATCH_SIZE-doughPlacedCount}/${DOUGH_TIMER_BATCH_SIZE}、${doughRemainingLabel}。${doughStatus==="not_started"?"タップで20分計測を開始":doughStatus==="expired"?"期限切れ。タップで残りを廃棄し次の6個を開始":doughStatus==="complete"?"タップで次の6個を開始":"計測中"}`} onClick={()=>changeDoughBatch(doughStatus==="expired"?"doughDiscardAndStart":doughStatus==="complete"?"doughReset":"doughStart")}>
   <span className="dough-count">{DOUGH_TIMER_BATCH_SIZE-doughPlacedCount}/{DOUGH_TIMER_BATCH_SIZE}</span><strong className="dough-clock">{doughStatus==="not_started"?"20:00":doughRemainingLabel}</strong>
 </button>}
 </div>
   <div className="timer-recall" role="group" aria-label="提供状況の呼び出し">
     <div className="timer-recall-icon">
       <button className="timer-recall-center" type="button" disabled={!snapshot||(__PAGES_MODE__&&!available)} aria-label={`ID ${recallId} の提供状況を呼び出す`} onClick={searchDelivery}><strong>{recallId}</strong></button>
       <div className="timer-recall-arrows timer-recall-m">
         <button type="button" aria-label="IDのmを1減らす" disabled={!snapshot||recallM===1} onClick={()=>setRecallM(value=>Math.max(1,value-1))}><ArrowLeft size={18}/></button>
         <span>{recallM}</span>
         <button type="button" aria-label="IDのmを1増やす" disabled={!snapshot||recallM===MAX_PANCAKE_IDS/DOUGH_ID_BLOCK_SIZE} onClick={()=>setRecallM(value=>Math.min(MAX_PANCAKE_IDS/DOUGH_ID_BLOCK_SIZE,value+1))}><ArrowRight size={18}/></button>
       </div>
       <div className="timer-recall-arrows timer-recall-n">
         <button type="button" aria-label="IDのnを1減らす" disabled={!snapshot} onClick={()=>setRecallN(value=>value===1?DOUGH_ID_BLOCK_SIZE:value-1)}><ArrowLeft size={18}/></button>
         <span>{recallN}</span>
         <button type="button" aria-label="IDのnを1増やす" disabled={!snapshot} onClick={()=>setRecallN(value=>value===DOUGH_ID_BLOCK_SIZE?1:value+1)}><ArrowRight size={18}/></button>
       </div>
     </div>

   </div>
  <section id="completion-box" tabIndex={-1} className="completion-box" aria-label="完成ボックス">
   {deliverySearchIds.length>0&&<div className="delivery-search-results" role="status" aria-live="polite">
     {deliverySearchMatches.map(match=>{
       const record=records.find(record=>record.entityKey===match.entityKey);
       const remainingSeconds=match.status==="available"&&record?.serveDeadlineAt!==null&&record?.serveDeadlineAt!==undefined?Math.ceil(Math.max(0,record.serveDeadlineAt-now)/1000):0;
       const remainingLabel=`${String(Math.floor(remainingSeconds/60)).padStart(2,"0")}:${String(remainingSeconds%60).padStart(2,"0")}`;
       const completionItem=completionItems.find(item=>item.entityKey===match.entityKey);
       return <div key={`${match.searchId}:${match.entityKey}`} className={`delivery-search-result is-${match.status}`}>
         <span className="delivery-id">{match.searchId}</span>
         <strong>{deliveryStatusLabels[match.status]}</strong>
         {match.status==="available"&&completionItem&&<><time aria-label={`提供可能な残り時間 ${remainingLabel}`}>{remainingLabel}</time><button type="button" className="serve-button" disabled={!available||isItemPending(completionItem)} onClick={()=>serveCompletion(match.entityKey)}>提供</button></>}
         <button type="button" className="dismiss-delivery-button" aria-label={`ID ${match.searchId} の表示を提供ボックスから外す`} title="表示を外す" onClick={()=>setDeliverySearchIds(ids=>ids.filter(id=>id!==match.searchId))}>×</button>
       </div>;
     })}
   </div>}
  </section>
 </div>
 {__PAGES_MODE__&&kitchen.statusMessage&&<div className="status-banner" role="alert">{kitchen.statusMessage}</div>}
 {__PAGES_MODE__&&kitchen.legacyDoughResetRequired&&<section className="error-panel legacy-dough-reset-panel" role="alert">
   <strong>旧タイマーのため操作停止中</strong>
   <p>再開には全体リセットが必要です。</p>
   {!legacyDoughResetConfirmation
     ? <button type="button" disabled={!kitchen.legacyDoughResetAvailable||pendingIds.size>0||resetSubmitting.current} onClick={()=>setLegacyDoughResetConfirmation(true)}>全体リセットを確認</button>
     : <div className="reset-confirmation"><span>保存元を再確認して全データを消去します。この操作は取り消せません。</span><button type="button" className="update-button reset-confirm" disabled={!kitchen.legacyDoughResetAvailable||pendingIds.size>0||resetSubmitting.current} onClick={confirmLegacyDoughReset}>全体リセットを実行</button><button type="button" className="reset-cancel" disabled={pendingIds.size>0||resetSubmitting.current} onClick={()=>{if(!resetSubmitting.current)setLegacyDoughResetConfirmation(false);}}>キャンセル</button></div>}
   {!kitchen.legacyDoughResetAvailable&&<p>保存元を照合できないため、リセットを実行できません。画面を開き直して状態を確認してください。</p>}
 </section>}
 {__PAGES_MODE__&&kitchen.recoveryAvailable&&!kitchen.legacyDoughResetRequired&&<div className="status-banner" role="alert"><span>保存データを読み込めません。</span> <button className="update-button" onClick={()=>setDataManagementOpen(true)}>バックアップから復旧</button></div>}
 {gridBlocked&&<div className="grid-capacity-warning" role="status">鉄板が過密のため配置・移動できません。焼き上がりを回収してください。</div>}
 {!__PAGES_MODE__&&connection==="unauthorized" && <div className="status-banner">この端末は未登録か、利用期限が切れています。<a href="/register">登録画面を開いてください</a> 管理者から登録コードを受け取ってください。</div>}
 {!__PAGES_MODE__&&connection==="offline" && <div className="status-banner" role="status">接続を確認しています。現在は表示のみです。 <button onClick={()=>void sync()}>再接続</button></div>}

  <section className="plates" aria-label="鉄板の操作画面">{([1,2] as const).map(plate=>{
    const plateItems=items.filter(i=>i.plate===plate);
    return <article className="plate-card" key={plate}><header className="plate-heading"><h2>鉄板 {plate}</h2></header><div className={`plate ${!available?"disabled":""}`}>
   <svg ref={element=>{plateSvgs.current[plate]=element;}} viewBox="0 0 1600 900" preserveAspectRatio="none" role="group" aria-label={`鉄板${plate}。3列2行の6マスです。新しい楕円は下段の空きマスをタップして配置します。下段の待機中の楕円は、同じ列の上段が空いていればタップで移動し、移動後にタップすると計測を開始します。上段が使用中なら下段タップで計測を開始します。下段の調理中の楕円はタップすると同じ列の空いた上段へ移動します。上段は新規配置できません。短いタップの移動は下段から真上だけです。楕円を450ミリ秒以上長押ししてドラッグすると、どちらの鉄板の空きマスにも移動できます。使用中のマスや鉄板外で離すと元に戻ります。`} onPointerDown={e=>down(e,plate)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel} onContextMenu={e=>e.preventDefault()}>
   <rect width="1600" height="900" fill="transparent"/>
   <g className="plate-grid" pointerEvents="none" aria-hidden="true">
     {Array.from({length:GRID_COLUMNS-1},(_,index)=><line key={`column-${index}`} x1={(index+1)*1600/GRID_COLUMNS} y1="0" x2={(index+1)*1600/GRID_COLUMNS} y2="900"/>)}
     {Array.from({length:GRID_ROWS-1},(_,index)=><line key={`row-${index}`} x1="0" y1={(index+1)*900/GRID_ROWS} x2="1600" y2={(index+1)*900/GRID_ROWS}/>)}
     {GRID_CELLS.map(cell=><circle key={cell.index} cx={cell.x*1600} cy={cell.y*900} r="9" className={isGridCellOccupied(items,plate,cell.index)?"plate-grid-center occupied":"plate-grid-center"}/>)}
   </g>
   {moveCue?.target?.plate===plate&&<rect className={`move-target${moveCue.target.reason?" blocked":""}`} x={GRID_CELLS[moveCue.target.cellIndex].column*1600/GRID_COLUMNS+8} y={GRID_CELLS[moveCue.target.cellIndex].row*900/GRID_ROWS+8} width={1600/GRID_COLUMNS-16} height={900/GRID_ROWS-16} rx="22" pointerEvents="none" aria-hidden="true"/>}
   {plateItems.map(item=>{
     const t=timer(item,now); const cx=item.x*1600,cy=item.y*900,rx=OVAL_RX*1600,ry=OVAL_RY*900;
     const lowerRow=nearestGridCell(item.x,item.y).row===GRID_ROWS-1;
     const upperCell=lowerRow?GRID_CELLS[nearestGridCell(item.x,item.y).index-GRID_COLUMNS]:undefined;
     const upperCellOccupied=t.state==="blank"&&lowerRow&&upperCell?isGridCellActuallyOccupied(items,item.plate,upperCell.index,item.id):false;
     const blankMoveBlockReason=t.state==="blank"&&lowerRow&&upperCell?gridMoveBlockReason(items,item.id,item.plate,upperCell.index):null;
     const blankTapInstruction=t.state!=="blank"?"":!lowerRow?"タップで90秒の計測を開始":!upperCell?"上段の移動先を確認できません":upperCellOccupied?"上段使用中のためタップで計測開始":blankMoveBlockReason?`${gridMoveBlockMessage(blankMoveBlockReason)} 待機状態です`:"タップで上段へ移動。上段で再度タップすると計測開始";
     const timerY=cy+ry*(lowerRow?-0.68:0.68);
      const busy=isItemPending(item);
      const longPressArmed=moveCue?.entityKey===item.entityKey;
      const dragging=longPressArmed&&moveCue.dragging;
      return <g key={item.entityKey} data-item-key={item.entityKey} data-item-id={item.id} data-plate={plate} data-state={t.state} data-duration="90" data-temperature={item.temperature} data-version={item.version} className={`oval ${busy?"pending":""}${longPressArmed?" long-press-armed":""}${dragging?" move-dragging":""}`}>
       <title>{`ID: ${item.archiveId}`}</title>
        <defs><clipPath id={`clip-${item.entityKey}`}><ellipse cx={cx} cy={cy} rx={rx} ry={ry}/></clipPath></defs>
        <ellipse role="button" tabIndex={0} aria-disabled={!available||busy} aria-label={`お好み焼きID ${item.archiveId}、${t.state==="blank"?`待機中、温度${item.temperature}度、${blankTapInstruction}`:t.state==="done"?`焼き上がり、温度${item.temperature}度、タップで回収し30分の内部計測を開始`:lowerRow?`調理中、残り${t.remaining}秒、温度${item.temperature}度、タップで真上の空きマスへ移動`:`調理中、残り${t.remaining}秒、温度${item.temperature}度、上段の短いタップでは移動しません`}。450ミリ秒以上長押ししてドラッグすると、どちらの鉄板の空きマスにも移動できます。`} cx={cx} cy={cy} rx={rx} ry={ry} fill={t.state==="done"?"#e13b3b":t.state==="blank"?"#fff":"#0c0d0f"} stroke={pressed===item.entityKey?"#ffb276":"#92989f"} strokeWidth={pressed===item.entityKey?9:4} onKeyDown={e=>keyboard(e,item)}/>
        {t.state==="running"&&<rect x={cx-rx} y={cy-ry} width={rx*2} height={ry*2*t.progress} fill="#fff" clipPath={`url(#clip-${item.entityKey})`} pointerEvents="none"/>}
       {t.state!=="blank"&&<text x={cx} y={timerY} textAnchor="middle" className="oval-number" fontSize="66" fill={t.state==="done"?"#fff":t.progress>(lowerRow?0.16:0.84)?"#16191e":"#fff"} pointerEvents="none">{t.remaining}</text>}
       {t.state!=="done"&&<>
        <g role="button" tabIndex={0} aria-label="温度を1℃下げる" aria-disabled={!available||busy} data-item-action="left" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"left")}>
          <rect x={cx-rx-(__PAGES_MODE__?120:96)} y={cy-ry-22} width={__PAGES_MODE__?"120":"96"} height={ry*2+44} fill="transparent" pointerEvents="all"/>
           <rect x={cx-rx-84} y={cy-48} width="60" height="96" rx="18" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx-rx-45} ${cy-22} l -22 22 22 22`} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
         <g role="button" tabIndex={0} aria-label="温度を1℃上げる" aria-disabled={!available||busy} data-item-action="right" className="oval-arrow" onKeyDown={e=>keyboard(e,item,"right")}>
          <rect x={cx+rx} y={cy-ry-22} width={__PAGES_MODE__?"120":"96"} height={ry*2+44} fill="transparent" pointerEvents="all"/>
           <rect x={cx+rx+24} y={cy-48} width="60" height="96" rx="18" fill="#d94f16" pointerEvents="none"/>
           <path d={`M ${cx+rx+45} ${cy-22} l 22 22 -22 22`} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
         </g>
       </>}
       {busy&&<circle cx={cx+rx-20} cy={cy-ry+20} r="15" fill="#e6793e"/>}
     </g>;
   })}
   </svg>
    <div className="plate-label-overlay" aria-hidden={!__PAGES_MODE__}>
      {plateItems.map(item=>{
        const lowerRow=nearestGridCell(item.x,item.y).row===GRID_ROWS-1;
        return <div key={`label-${item.entityKey}`} className={`plate-label${lowerRow?" lower":""}`} style={{left:`${item.x*100}%`}}>
          <span className="oval-temperature">{item.temperature}℃</span>
          <span className="oval-id">{item.archiveId}</span>
       </div>;
     })}
   </div>

   </div></article>;
 })}</section>
 </main>;
}

export default function Kitchen() {
 return <KitchenView useController={useKitchen}/>;
}

export function PagesKitchen() {
 return <KitchenView useController={useKitchenLocal}/>;
}


