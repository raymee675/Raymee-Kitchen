import { useState, type FormEvent } from "react";
import { Flame } from "lucide-react";

export default function Enrollment() {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.toUpperCase().replaceAll("-", "").replaceAll(" ", ""), label }),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "登録できませんでした。");
      window.location.replace("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登録できませんでした。");
      setBusy(false);
    }
  }

  return <main className="signin-page"><form className="signin-card" onSubmit={submit}>
    <span className="brand-icon"><Flame /></span>
    <h1>このスマホを登録</h1>
    <p>管理者から受け取った一回限りの登録コードを入力してください。</p>
    <label className="pc-register-label" htmlFor="device-label">端末の名前</label>
    <input id="device-label" className="pc-register-input" autoComplete="off" maxLength={40} required value={label} onChange={event => setLabel(event.target.value)} placeholder="例：調理台スマホ1" />
    <label className="pc-register-label" htmlFor="device-code">登録コード</label>
    <input id="device-code" className="pc-register-input pc-register-code" autoComplete="one-time-code" autoCapitalize="characters" maxLength={24} required value={code} onChange={event => setCode(event.target.value)} placeholder="管理者に確認してください" />
    {error && <p className="pc-register-error" role="alert">{error}</p>}
    <button className="pc-register-submit" type="submit" disabled={busy}>{busy ? "登録しています…" : "この端末を登録"}</button>
    <p className="help-note">この登録コードは一度だけ使用でき、発行から15分で期限切れになります。</p>
  </form></main>;
}
