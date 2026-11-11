"use client";

import { useEffect, useState } from "react";

interface Model {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  source?: "openrouter" | "opencode";
  tools?: boolean | null;
}

interface Settings {
  hasKey: boolean;
  maskedKey: string | null;
  defaultModel: string | null;
  configPath: string;
  projectsRoot: string | null;
}

function price(entry: Model): string {
  if (entry.promptPrice === 0 || entry.id.endsWith(":free") || entry.id === "openrouter/free") {
    return "free";
  }
  if (entry.promptPrice === null) return "";
  const perMillion = entry.promptPrice * 1_000_000;
  if (perMillion < 0.01) return "$0";
  return `$${perMillion.toFixed(perMillion < 1 ? 3 : 2)}/M`;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [configResponse, modelsResponse] = await Promise.all([
        fetch("/api/config"),
        fetch("/api/models"),
      ]);
      const config = (await configResponse.json()) as Settings;
      setSettings(config);
      setModel(config.defaultModel ?? "");

      const catalogue = (await modelsResponse.json()) as { ok: boolean; models?: Model[] };
      if (catalogue.ok) setModels(catalogue.models ?? []);
    })();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, defaultModel: model }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!body.ok) throw new Error(body.error ?? "the settings could not be saved");
      setApiKey("");
      const refreshed = (await (await fetch("/api/config")).json()) as Settings;
      setSettings(refreshed);
      setNotice("saved");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const body = (await response.json()) as { ok: boolean; reply?: string; error?: string };
      if (!body.ok) throw new Error(body.error ?? "the model did not answer");
      setNotice(`reply: ${body.reply ?? ""}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Settings</h1>
      <p className="subtitle">
        One OpenRouter key. Slate shows only free models (OpenRouter and opencode) and falls back to
        another free model when one is rate-limited. The key stays on this machine.
      </p>

      <section className="card">
        <h2>OpenRouter</h2>
        <div className="meta">
          {settings?.hasKey === true ? (
            <span className="chip accent">key saved · {settings.maskedKey}</span>
          ) : (
            <span className="chip warn">no key</span>
          )}
          {settings?.defaultModel !== null && settings?.defaultModel !== undefined && (
            <span className="chip">{settings.defaultModel}</span>
          )}
        </div>

        <label className="field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            placeholder={settings?.maskedKey ?? "sk-or-v1-…"}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="field">
          <span>Default model</span>
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">choose a model…</option>
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.source === "opencode" ? "[opencode] " : ""}
                {entry.name} · {price(entry)}
                {entry.tools === false ? " · no tools" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          <button onClick={save} disabled={busy}>
            Save
          </button>
          <button onClick={test} disabled={busy || model === ""}>
            Send a test message
          </button>
        </div>

        {notice !== null && <p className="notice ok">{notice}</p>}
        {error !== null && <p className="notice bad">{error}</p>}
      </section>

      <section className="card">
        <h2>Where things are</h2>
        <div className="meta">
          <span>
            settings: <code>{settings?.configPath ?? "…"}</code>
          </span>
        </div>
        <div className="meta">
          <span>
            projects root: <code>{settings?.projectsRoot ?? "the default"}</code>
          </span>
        </div>
      </section>
    </main>
  );
}
