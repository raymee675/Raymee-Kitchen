import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../app/globals.css";

type Device = { id:string; label:string; created_at:number; expires_at:number; revoked_at:number|null; last_seen_at:number|null };
type Code = { id:string; created_at:number; expires_at:number; used_at:number|null; device_id:string|null; canceled_at:number|null; state:"pending"|"used"|"expired"|"canceled" };
type ConnectionType = "hotspot"|"wifi"|"ethernet"|"other";
type RegisterUrl = { interfaceName:string; connectionType?:ConnectionType; url:string };
type AdminData = { devices:Device[]; codes:Code[]; registerUrls:RegisterUrl[] };
type NewCode = { id:string; code:string; createdAt:number; expiresAt:number };

const date = (value:number|null) => value === null ? "—" : new Intl.DateTimeFormat("ja-JP", {dateStyle:"short",timeStyle:"short"}).format(value);

function networkUsage(connectionType:ConnectionType,interfaceName:string) {
  if (connectionType==="hotspot") {
    return {title:"PCホットスポット用",detail:"スマホをこのPCのモバイル ホットスポットに接続した場合に使います。"};
  }
  if (connectionType==="wifi") {
    return {title:"同じWi-Fiで使う場合",detail:"スマホとPCを同じWi-Fiに接続した場合の予備URLです。"};
  }
  if (connectionType==="ethernet") {
    return {title:"同じルーターで使う場合",detail:"PCが有線LAN、スマホが同じルーターのWi-Fiに接続している場合です。"};
  }
  return {title:`その他の接続（${interfaceName}）`,detail:"通常は使いません。スマホもこのネットワークに接続している場合だけ選んでください。"};
}

function getConnectionType(item:RegisterUrl):ConnectionType {
  if (item.connectionType) return item.connectionType;
  const name=item.interfaceName.normalize("NFKC").toLowerCase();
  let address="";
  try { address=new URL(item.url).hostname; } catch {}
  if (address==="192.168.137.1"||/local area connection|ローカル エリア接続|mobile hotspot|hotspot|wi.?fi direct/.test(name)) return "hotspot";
  if (/virtual|vpn|loopback|bluetooth|テザリング/.test(name)) return "other";
  if (/wi.?fi|wireless|wlan|無線/.test(name)) return "wifi";
  if (/ethernet|イーサネット|有線/.test(name)) return "ethernet";
  return "other";
}

function Admin() {
  const [data,setData] = useState<AdminData|null>(null);
  const [issued,setIssued] = useState<NewCode|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const [now,setNow] = useState<number|null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/status", {cache:"no-store",signal:AbortSignal.timeout(5000)});
      const result = await response.json() as AdminData & {error?:string};
      if (!response.ok) throw new Error(result.error || "管理情報を取得できませんでした。");
      setData(result);
      setNow(Date.now());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "管理情報を取得できませんでした。");
    }
  },[]);

  useEffect(() => {
    const initial = window.setTimeout(()=>void refresh(),0);
    const timer = setInterval(()=>void refresh(),15000);
    return ()=>{window.clearTimeout(initial);clearInterval(timer);};
  },[refresh]);

  async function issueCode() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/enrollment-codes", {method:"POST",headers:{"Content-Type":"application/json"},body:"{}",cache:"no-store",signal:AbortSignal.timeout(5000)});
      const result = await response.json() as NewCode & {error?:string};
      if (!response.ok) throw new Error(result.error || "コードを発行できませんでした。");
      setIssued(result); setNotice("コードを発行しました。この画面を閉じる前にスマホへ入力してください。");
      await refresh();
    } catch(caught) {
      setError(caught instanceof Error ? caught.message : "コードを発行できませんでした。");
    } finally { setBusy(false); }
  }

  async function postAction(url:string,method:"POST"|"DELETE",confirmMessage?:string) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response=await fetch(url,{method,headers:{"Content-Type":"application/json"},body:method==="POST"?"{}":undefined,cache:"no-store",signal:AbortSignal.timeout(5000)});
      const result=await response.json() as {error?:string;canceled?:boolean;revoked?:boolean};
      if(!response.ok) throw new Error(result.error||"操作を完了できませんでした。");
      if(result.canceled===false||result.revoked===false) throw new Error("対象が使用済み、期限切れ、または見つかりません。");
      setNotice("変更を保存しました。"); await refresh();
    } catch(caught) { setError(caught instanceof Error?caught.message:"操作を完了できませんでした。"); }
    finally { setBusy(false); }
  }

  async function copy(value:string,label:string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label}をコピーしました。`); }
    catch { setError("コピーできませんでした。表示された内容を長押ししてコピーしてください。"); }
  }

  const registerUrls=data?.registerUrls??[];
  const hotspotUrls=registerUrls.filter(item=>getConnectionType(item)==="hotspot");
  const alternateUrls=registerUrls.filter(item=>getConnectionType(item)!=="hotspot");

  return <main className="admin-page">
    <header className="admin-header"><div><p className="admin-eyebrow">TEPPAN TIMER / PC</p><h1>端末管理</h1><p>この管理画面は、このPCのlocalhostからのみ利用できます。</p></div><a className="admin-kitchen-link" href="/kitchen">調理画面を開く</a></header>
    {error&&<p className="admin-alert" role="alert">{error}</p>}
    {notice&&<p className="admin-notice" role="status">{notice}</p>}

    <section className="admin-card">
      <div className="admin-section-heading"><div><h2>スマホを登録</h2><p>コードはスマホ1台につき1つ発行します。発行から15分以内に登録してください。</p></div><button className="admin-primary" onClick={()=>void issueCode()} disabled={busy}>登録コードを発行</button></div>
      {issued&&<div className="issued-code"><div><span>今回発行したコード</span><strong>{issued.code}</strong><small>有効期限：{date(issued.expiresAt)}</small></div><button className="admin-secondary" onClick={()=>void copy(issued.code,"登録コード")}>コードをコピー</button></div>}
      <ol className="admin-steps"><li>PCのモバイル ホットスポットをオンにし、スマホをそのホットスポットへ接続します。</li><li>下の「PCホットスポット用URL」をスマホのブラウザーで開き、コードと端末名を入力します。</li><li>コードは一度だけ使えます。使用後はこの画面のコード一覧に「登録済み」と表示されます。</li></ol>
      <div className="admin-url-list"><h3>スマホで開く登録URL</h3><section className="admin-hotspot-panel"><h4>PCホットスポット用URL（メイン）</h4><p className="admin-url-help">まずPCのモバイル ホットスポットをオンにし、スマホをそのネットワークへ接続してください。下のURLをスマホで開きます。</p>{data===null?<p>ホットスポットのURLを確認中です。</p>:hotspotUrls.length?<ul>{hotspotUrls.map((item,index)=><li key={`${item.url}-${index}`}><div className="admin-network-info"><strong>このPCのホットスポット</strong><span>PC側アダプター：{item.interfaceName}</span></div><code>{item.url}</code><button className="admin-secondary" onClick={()=>void copy(item.url,"ホットスポット用URL")}>コピー</button></li>)}</ul>:<p className="admin-hotspot-missing" role="status">ホットスポット用URLが見つかりません。Windowsの「モバイル ホットスポット」をオンにしてから、この画面を更新してください。</p>}</section>{alternateUrls.length>0&&<details className="admin-url-alternatives"><summary>同じWi-Fiで使う場合（予備）</summary><p>PCとスマホを同じWi-Fiまたは同じルーターへ接続して使うときのURLです。通常は上のホットスポット用URLを使ってください。</p><ul>{alternateUrls.map((item,index)=>{const usage=networkUsage(getConnectionType(item),item.interfaceName);return <li key={`${item.url}-${index}`}><div className="admin-network-info"><strong>{usage.title}</strong><span>PC側アダプター：{item.interfaceName}</span><small>{usage.detail}</small></div><code>{item.url}</code><button className="admin-secondary" onClick={()=>void copy(item.url,"予備の登録URL")}>コピー</button></li>;})}</ul></details>}</div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>発行日時</th><th>期限</th><th>状態</th><th></th></tr></thead><tbody>{data?.codes.length?data.codes.map(code=><tr key={code.id}><td>{date(code.created_at)}</td><td>{date(code.expires_at)}</td><td>{({pending:"未使用",used:"登録済み",expired:"期限切れ",canceled:"取消済み"})[code.state]}{code.device_id?`（${data.devices.find(d=>d.id===code.device_id)?.label||"端末"}）`:""}</td><td>{code.state==="pending"&&<button className="admin-text-button" disabled={busy} onClick={()=>void postAction(`/api/admin/enrollment-codes/${code.id}`,"DELETE","この未使用コードを取り消しますか？")}>取り消す</button>}</td></tr>):<tr><td colSpan={4}>発行済みコードはありません。</td></tr>}</tbody></table></div>
    </section>

    <section className="admin-card">
      <div className="admin-section-heading"><div><h2>端末の状況</h2><p>オンラインは直近45秒以内にサーバーへ接続した端末です。</p></div><button className="admin-secondary" onClick={()=>void refresh()} disabled={busy}>更新</button></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>端末名</th><th>状態</th><th>最終接続</th><th>登録期限</th><th></th></tr></thead><tbody>{data?.devices.length?data.devices.map(device=>{
        const local=device.id==="localhost";
        const state=local?"このPC（自動登録）":device.revoked_at?"停止":now!==null&&device.expires_at<=now?"期限切れ":now!==null&&device.last_seen_at&&now-device.last_seen_at<=45_000?"オンライン":now===null?"確認中":"オフライン";
        return <tr key={device.id}><td>{device.label}</td><td><span className={`admin-state ${state==="オンライン"||local?"is-online":""}`}>{state}</span></td><td>{date(device.last_seen_at)}</td><td>{local?"期限なし":date(device.expires_at)}</td><td>{!local&&!device.revoked_at&&now!==null&&device.expires_at>now&&<button className="admin-danger-button" disabled={busy} onClick={()=>void postAction(`/api/admin/devices/${device.id}/revoke`,"POST",`「${device.label}」を停止しますか？この操作後、そのスマホから再接続できなくなります。`)}>停止</button>}</td></tr>;
      }):<tr><td colSpan={5}>端末情報を読み込んでいます。</td></tr>}</tbody></table></div>
    </section>
    <footer className="admin-footer">localhostは登録コードなしで利用できます。スマホなど他の端末は登録コードが必要です。</footer>
  </main>;
}

const element=document.getElementById("root");
if(!element) throw new Error("管理画面の表示先がありません。");
createRoot(element).render(<Admin/>);
