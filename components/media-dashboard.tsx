"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentState } from "@/lib/media/types";

type ActivityEvent = { step: string; label: string; status: "running" | "done"; detail?: string };

const EXAMPLE_QUERIES = [
  "What are the major developments affecting India's renewable energy sector?",
  "Compare how different sources reported the clean energy framework approval.",
  "What happened with the Rajasthan solar auction and what should we watch next?",
  "What is India's nuclear energy capacity target?",
];

const STEP_ORDER = ["understanding", "searching", "clustering", "context", "comparing", "impact", "brief", "verifying"];

async function readJson(response: Response) {
  const data: unknown = await response.json().catch(() => ({}));
  if (!data || typeof data !== "object") return {} as Record<string, unknown>;
  return data as Record<string, unknown>;
}

export default function MediaDashboard() {
  const [seedStatus, setSeedStatus] = useState("Preparing sample dataset…");
  const [datasetStats, setDatasetStats] = useState<{ topics: string[]; sources: string[]; count: number } | null>(null);
  const [pibStatus, setPibStatus] = useState<string | null>(null);
  const [pibBusy, setPibBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [state, setState] = useState<AgentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function refreshStats() {
    const response = await fetch("/api/media/stats", { cache: "no-store" });
    const data = await readJson(response);
    if (response.ok) setDatasetStats(data as { topics: string[]; sources: string[]; count: number });
  }

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/media/seed", { method: "POST" });
        const data = await readJson(response);
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not seed sample dataset.");
        setSeedStatus(typeof data.message === "string" ? data.message : "Sample dataset ready.");
        await refreshStats();
      } catch (err) {
        setSeedStatus(err instanceof Error ? err.message : "Could not prepare the sample dataset.");
      }
    })();
    return () => abortRef.current?.abort();
  }, []);

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

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setBusy(true);
    setError(null);
    setActivity([]);
    setState(null);
    setLastQuery(trimmed);

    try {
      const response = await fetch("/api/media/query", {
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
              return next.sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step));
            });
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
              Ask about developments in a sector. The agent searches, clusters coverage into events, compares sources,
              analyzes implications, and verifies every citation before showing you a brief.
            </p>
          </div>
          <div className="media-dataset-badge" title={datasetStats ? `Topics: ${datasetStats.topics.join(", ")}` : undefined}>
            <div>{seedStatus}</div>
            {datasetStats && <div className="muted">{datasetStats.count} indexed items · {datasetStats.topics.length} topics · {datasetStats.sources.length} sources</div>}
            <div className="muted sample-warning">Synthetic sample data — see data/sample-articles.json</div>
          </div>
        </header>

        <section className="media-panel pib-panel">
          <div className="panel-head"><h2>Live data: Press Information Bureau (Government of India)</h2></div>
          <div className="panel-body pib-panel-body">
            <p className="muted">
              Optional. Pulls yesterday&rsquo;s English PIB press releases (real government announcements, full text, free) into the same
              searchable index as the sample data below. Coverage is whatever the government actually published — it will not always include
              renewable-energy items, and since every release ultimately comes from one source (the Indian government), cross-outlet
              comparison only applies to the sample dataset, not PIB releases. Re-pulling on different days builds a real historical archive.
            </p>
            <div className="pib-panel-row">
              <button className="btn" type="button" disabled={pibBusy} onClick={() => void pullPibFeed()}>
                {pibBusy ? "Pulling…" : "Pull latest PIB releases"}
              </button>
              {pibStatus && <span className="muted small">{pibStatus}</span>}
            </div>
          </div>
        </section>

        <section className="media-query-bar">
          <form onSubmit={(e) => { e.preventDefault(); void ask(query); }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. What are the major developments affecting India's renewable energy sector?"
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
              {STEP_ORDER.map((stepId) => {
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
