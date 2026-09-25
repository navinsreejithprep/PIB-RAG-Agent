"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentState } from "@/lib/media/types";

type ActivityEvent = { step: string; label: string; status: "running" | "done"; detail?: string };
type TraceEvent =
  | { type: "round_start"; round: number }
  | { type: "tool_call"; round: number; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; round: number; tool: string; summary: string }
  | { type: "wrap_up"; reason: "round_cap" | "time_cap" };
type Mode = "fixed" | "autonomous";

const EXAMPLE_QUERIES = [
  "What are today's major government announcements?",
  "Summarize the latest developments from the Ministry of Power.",
  "What has the Prime Minister's Office announced recently?",
  "What is India's nuclear energy capacity target?",
];

const FIXED_STEP_ORDER = ["understanding", "searching", "clustering", "context", "comparing", "impact", "brief", "verifying"];
const AUTONOMOUS_STEP_ORDER = ["understanding", "research", "clustering", "comparing", "impact", "brief", "verifying"];

function toolLine(t: TraceEvent): string | null {
  if (t.type === "tool_call") {
    const argsText = Object.entries(t.args).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    return `${t.tool}(${argsText})`;
  }
  return null;
}

async function readJson(response: Response) {
  const data: unknown = await response.json().catch(() => ({}));
  if (!data || typeof data !== "object") return {} as Record<string, unknown>;
  return data as Record<string, unknown>;
}

export default function MediaDashboard() {
  const [datasetStats, setDatasetStats] = useState<{ topics: string[]; sources: string[]; count: number } | null>(null);
  const [pibStatus, setPibStatus] = useState("Pulling live PIB press releases…");
  const [pibBusy, setPibBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("fixed");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [state, setState] = useState<AgentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function refreshStats() {
    const response = await fetch("/api/media/stats", { cache: "no-store" });
    const data = await readJson(response);
    if (response.ok) setDatasetStats(data as { topics: string[]; sources: string[]; count: number });
  }

  async function pullPibFeed() {
    if (pibBusy) return;
    setPibBusy(true);
    setPibStatus("Pulling live PIB press releases…");
    try {
      const response = await fetch("/api/media/ingest-pib", { method: "POST" });
      const data = await readJson(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not pull the PIB feed.");
      setPibStatus(typeof data.message === "string" ? data.message : "PIB feed pulled.");
      await refreshStats();
    } catch (err) {
      setPibStatus(err instanceof Error ? err.message : "Could not pull the PIB feed.");
    } finally {
      setPibBusy(false);
    }
  }

  useEffect(() => {
    void pullPibFeed();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setBusy(true);
    setError(null);
    setActivity([]);
    setTrace([]);
    setState(null);
    setLastQuery(trimmed);

    try {
      const response = await fetch(mode === "autonomous" ? "/api/media/agent" : "/api/media/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const data = await readJson(response);
        throw new Error(typeof data.error === "string" ? data.error : "The agent request failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; [key: string]: unknown };
          if (event.type === "status") {
            const { step, label, status, detail } = event as unknown as ActivityEvent;
            setActivity((prev) => {
              const next = prev.filter((e) => e.step !== step);
              next.push({ step, label, status, detail });
              const order = mode === "autonomous" ? AUTONOMOUS_STEP_ORDER : FIXED_STEP_ORDER;
              return next.sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
            });
          } else if (event.type === "trace") {
            setTrace((prev) => [...prev, event.event as TraceEvent]);
          } else if (event.type === "result") {
            setState(event.state as AgentState);
          } else if (event.type === "error") {
            throw new Error(typeof event.error === "string" ? event.error : "The agent request failed.");
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "The agent request failed.");
    } finally {
      setBusy(false);
    }
  }

  const citationSummary = state?.citations
    ? `${state.citations.checks.length - state.citations.unsupportedCount - state.citations.fabricatedCitationCount}/${state.citations.checks.length} claims verified`
    : null;

  return (
    <main className="media-shell">
      <div className="media-container">
        <nav className="media-nav">
          <a href="/">← DocQuery (V1 chatbot)</a>
          <span>Executive Media Intelligence Agent</span>
        </nav>

        <header className="media-hero">
          <div>
            <div className="eyebrow">Agentic RAG · Prototype</div>
            <h1>Executive Media Intelligence</h1>
            <p className="subtitle">
              Ask about developments in India&rsquo;s central government. The agent searches real Press Information Bureau (PIB) releases,
              clusters coverage into events, analyzes implications, and verifies every citation before showing you a brief.
            </p>
          </div>
          <div className="media-dataset-badge" title={datasetStats ? `Topics: ${datasetStats.topics.join(", ")}` : undefined}>
            <div>{pibStatus}</div>
            {datasetStats && <div className="muted">{datasetStats.count} indexed release{datasetStats.count === 1 ? "" : "s"} · {datasetStats.sources.length} ministries/offices</div>}
            <div className="muted live-data-label">Live data — Press Information Bureau, Government of India</div>
            <button className="btn ghost" type="button" disabled={pibBusy} onClick={() => void pullPibFeed()}>
              {pibBusy ? "Pulling…" : "Pull latest releases"}
            </button>
          </div>
        </header>

        <p className="pib-caption muted small">
          Source: Press Information Bureau (Government of India), previous day&rsquo;s English releases, full text, free and keyless.
          Coverage is whatever the government actually published — it will not always include a given topic, and since every release
          ultimately comes from one source, cross-outlet comparison has nothing to compare against yet.
        </p>

        <section className="media-mode-toggle" role="radiogroup" aria-label="Agent mode">
          <button type="button" className={`mode-btn ${mode === "fixed" ? "active" : ""}`} disabled={busy} onClick={() => setMode("fixed")} aria-pressed={mode === "fixed"}>
            Fixed pipeline
          </button>
          <button type="button" className={`mode-btn ${mode === "autonomous" ? "active" : ""}`} disabled={busy} onClick={() => setMode("autonomous")} aria-pressed={mode === "autonomous"}>
            Autonomous agent
          </button>
          <span className="muted small mode-caption">
            {mode === "fixed"
              ? "Same 8 steps run every time, in the same order — predictable, fully evaluated."
              : "The model decides which searches to run and when it has enough evidence — bounded to 8 rounds / 90s of research."}
          </span>
        </section>

        <section className="media-query-bar">
          <form onSubmit={(e) => { e.preventDefault(); void ask(query); }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. What are today's major government announcements?"
              disabled={busy}
              aria-label="Research question"
            />
            <button className="btn" type="submit" disabled={busy || !query.trim()}>{busy ? "Researching…" : "Ask"}</button>
          </form>
          <div className="media-examples">
            {EXAMPLE_QUERIES.map((example) => (
              <button key={example} type="button" className="chip" disabled={busy} onClick={() => { setQuery(example); void ask(example); }}>
                {example}
              </button>
            ))}
          </div>
        </section>

        {(activity.length > 0 || busy) && (
          <section className="media-panel activity-panel" aria-label="Research status">
            <div className="panel-head"><h2>Research status</h2></div>
            <ol className="activity-log">
              {(mode === "autonomous" ? AUTONOMOUS_STEP_ORDER : FIXED_STEP_ORDER).map((stepId) => {
                const event = activity.find((e) => e.step === stepId);
                if (!event) return null;
                return (
                  <li key={stepId} className={event.status}>
                    <span className="activity-icon">{event.status === "done" ? "✓" : "…"}</span>
                    <span className="activity-label">{event.label}</span>
                    {event.detail && <span className="activity-detail">{event.detail}</span>}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {mode === "autonomous" && trace.length > 0 && (
          <section className="media-panel trace-panel" aria-label="Agent research trace">
            <div className="panel-head"><h2>Agent's live decisions</h2></div>
            <div className="panel-body trace-log">
              {trace.map((t, i) => {
                if (t.type === "round_start") return <div className="trace-round" key={i}>Round {t.round}</div>;
                if (t.type === "tool_call") return <div className="trace-call" key={i}>→ {toolLine(t)}</div>;
                if (t.type === "tool_result") return <div className="trace-result" key={i}>← {t.summary}</div>;
                if (t.type === "wrap_up") return <div className="trace-wrapup" key={i}>⏱ Research limit reached ({t.reason.replace(/_/g, " ")}) — wrapping up</div>;
                return null;
              })}
            </div>
          </section>
        )}

        {error && <div className="media-error" role="alert">{error}</div>}

        {state && (
          <div className="media-results">
            <div className="media-meta-row">
              <span className="pill">Intent: {state.intent.replace(/_/g, " ")}</span>
              {state.entities.length > 0 && <span className="pill">{state.entities.slice(0, 4).join(", ")}</span>}
              {state.confidence !== null && (
                <span className={`pill confidence conf-${state.confidence >= 0.7 ? "high" : state.confidence >= 0.4 ? "mid" : "low"}`}>
                  Confidence: {Math.round(state.confidence * 100)}%
                </span>
              )}
              {citationSummary && <span className="pill">{citationSummary}</span>}
            </div>

            {!state.brief ? (
              <section className="media-panel">
                <div className="panel-head"><h2>No brief generated</h2></div>
                <div className="panel-body">
                  <p>Evidence insufficient to establish an answer for &ldquo;{lastQuery}&rdquo; from the indexed dataset.</p>
                  {state.confidenceNotes.map((note, i) => <p className="muted" key={i}>{note}</p>)}
                </div>
              </section>
            ) : (
              <>
                <section className="media-panel brief-panel">
                  <div className="panel-head"><h2>Executive brief</h2></div>
                  <div className="panel-body">
                    <h3 className="brief-headline">{state.brief.headline}</h3>
                    <p className="brief-summary">{state.brief.executiveSummary}</p>
                    <div className="brief-grid">
                      <div>
                        <h4>What happened</h4>
                        <p>{state.brief.whatHappened}</p>
                      </div>
                      <div>
                        <h4>Why it matters</h4>
                        <p>{state.brief.whyItMatters}</p>
                      </div>
                    </div>
                    <h4>Potential implications</h4>
                    <ul>{state.brief.potentialImplications.map((item, i) => <li key={i}>{item}</li>)}</ul>
                    <h4>Risks / uncertainties</h4>
                    <ul>{state.brief.risksAndUncertainties.map((item, i) => <li key={i}>{item}</li>)}</ul>
                    <h4>What to watch</h4>
                    <ul>{state.brief.whatToWatch.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  </div>
                </section>

                <section className="media-panel">
                  <div className="panel-head"><h2>Key developments ({state.clusters.length})</h2></div>
                  <div className="panel-body cluster-grid">
                    {state.clusters.map((cluster) => (
                      <div className="cluster-card" key={cluster.id}>
                        <div className="cluster-head">
                          <strong>{cluster.headline}</strong>
                          <span className="pill small">{cluster.sourceCount} source{cluster.sourceCount === 1 ? "" : "s"}</span>
                        </div>
                        <div className="muted small">
                          {cluster.dateRange.earliest}{cluster.dateRange.earliest !== cluster.dateRange.latest ? ` – ${cluster.dateRange.latest}` : ""}
                        </div>
                        <ul className="cluster-sources">
                          {cluster.sources.map((s) => (
                            <li key={s.id}>
                              [{s.id}] {s.source}{s.date ? ` · ${s.date}` : ""} — {s.title}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>

                {state.comparisons.length > 0 && (
                  <section className="media-panel">
                    <div className="panel-head"><h2>Source comparison</h2></div>
                    <div className="panel-body">
                      {state.comparisons.map((comparison) => {
                        const cluster = state.clusters.find((c) => c.id === comparison.clusterId);
                        return (
                          <div className="comparison-block" key={comparison.clusterId}>
                            <strong>{cluster?.headline ?? comparison.clusterId}</strong>
                            {comparison.commonFacts.length > 0 && (
                              <div><span className="tag agree">Agree</span><ul>{comparison.commonFacts.map((f, i) => <li key={i}>{f}</li>)}</ul></div>
                            )}
                            {comparison.conflicts.length > 0 && (
                              <div><span className="tag conflict">Conflict</span>
                                <ul>{comparison.conflicts.map((c, i) => (
                                  <li key={i}>{c.issue}: {c.positions.map((p) => `[${p.sourceId}] ${p.claim}`).join(" vs. ")}</li>
                                ))}</ul>
                              </div>
                            )}
                            {comparison.differences.length > 0 && (
                              <div><span className="tag differ">Only some report</span><ul>{comparison.differences.map((f, i) => <li key={i}>{f}</li>)}</ul></div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                <section className="media-panel">
                  <div className="panel-head"><h2>Evidence &amp; sources ({state.retrievedSources.length})</h2></div>
                  <div className="panel-body evidence-list">
                    {state.retrievedSources.map((s) => (
                      <div className="evidence-row" key={s.id}>
                        <span className="pill small">{s.id}</span>
                        <span>{s.title}</span>
                        <span className="muted small">{s.source}{s.date ? ` · ${s.date}` : ""}</span>
                      </div>
                    ))}
                    {state.backgroundContext.map((s) => (
                      <div className="evidence-row" key={s.id}>
                        <span className="pill small bg">{s.id}</span>
                        <span>{s.title}</span>
                        <span className="muted small">background reference</span>
                      </div>
                    ))}
                  </div>
                </section>

                {state.confidenceNotes.length > 0 && (
                  <section className="media-panel">
                    <div className="panel-head"><h2>Confidence notes</h2></div>
                    <div className="panel-body"><ul>{state.confidenceNotes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
