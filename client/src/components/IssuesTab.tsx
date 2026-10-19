import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sparkles, Loader2, Plus, ArrowUp, ArrowDown, Trash2, ChevronDown, ChevronRight,
  IndentIncrease, IndentDecrease, AlertTriangle,
} from "lucide-react";
import type { FacadeSystem, Observation, Recommendation, Photo, ReportIssue } from "@shared/schema";
import { TIMEFRAMES } from "@shared/reportV2";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const aiPost = async (url: string, body: any) => {
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
};
const ids = (raw: string | null | undefined): number[] => { try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; } };

/** Display order: top-level issues, each followed by its sub-issues. Numbering starts at 4.2 (4.1 is the Overview). */
export function orderIssues(issues: ReportIssue[]) {
  const top = issues.filter(i => !i.parentId || !issues.some(p => p.id === i.parentId));
  const out: { issue: ReportIssue; number: string; depth: number }[] = [];
  top.forEach((t, n) => {
    out.push({ issue: t, number: `4.${n + 2}`, depth: 0 });
    issues.filter(c => c.parentId === t.id).forEach((c, m) => out.push({ issue: c, number: `4.${n + 2}.${m + 1}`, depth: 1 }));
  });
  return out;
}

function useDebouncedSave(save: (v: string) => void, delay = 700) {
  const t = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return (v: string) => { if (t.current) clearTimeout(t.current); t.current = setTimeout(() => save(v), delay); };
}

function SavedText({ value, onSave, rows, placeholder, input }: { value: string; onSave: (v: string) => void; rows?: number; placeholder?: string; input?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = useDebouncedSave(onSave);
  const props = { value: v, placeholder, onChange: (e: any) => { setV(e.target.value); save(e.target.value); } };
  return input ? <Input {...props} /> : <Textarea rows={rows || 3} {...props} />;
}

export default function IssuesTab({
  projectId, systems, observations, recommendations, overview,
}: {
  projectId: number; systems: FacadeSystem[]; observations: Observation[]; recommendations: Recommendation[]; overview: string;
}) {
  const { toast } = useToast();
  const key = [`/api/projects/${projectId}/issues`];
  const { data: issues = [] } = useQuery<ReportIssue[]>({ queryKey: key });
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ordered = useMemo(() => orderIssues(issues), [issues]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const assigned = new Map<number, string>();
  for (const { issue, number } of ordered) for (const oid of ids(issue.observationIds)) if (!assigned.has(oid)) assigned.set(oid, number);
  const unassigned = observations.filter(o => !assigned.has(o.id));

  const patch = async (id: number, body: any) => { await apiRequest("PATCH", `/api/issues/${id}`, body); refresh(); };
  const sendOrder = async (list: { id: number; parentId: number | null }[]) => {
    await apiRequest("POST", `/api/projects/${projectId}/issues/reorder`, { order: list }); refresh();
  };
  const flat = () => ordered.map(o => ({ id: o.issue.id, parentId: o.issue.parentId ?? null }));

  const move = (idx: number, dir: number) => {
    const me = ordered[idx];
    const siblings = ordered.filter(o => (o.issue.parentId ?? null) === (me.issue.parentId ?? null));
    const si = siblings.findIndex(s => s.issue.id === me.issue.id);
    const other = siblings[si + dir];
    if (!other) return;
    // Rebuild: swap the two sibling blocks (a top-level block includes its children).
    const blocks: { id: number; parentId: number | null }[][] = [];
    if (!me.issue.parentId) {
      for (const o of ordered) {
        if (o.depth === 0) blocks.push([{ id: o.issue.id, parentId: null }]);
        else blocks[blocks.length - 1].push({ id: o.issue.id, parentId: o.issue.parentId ?? null });
      }
      const a = blocks.findIndex(b => b[0].id === me.issue.id), b = blocks.findIndex(b2 => b2[0].id === other.issue.id);
      [blocks[a], blocks[b]] = [blocks[b], blocks[a]];
      sendOrder(blocks.flat());
    } else {
      const list = flat();
      const a = list.findIndex(x => x.id === me.issue.id), b = list.findIndex(x => x.id === other.issue.id);
      [list[a], list[b]] = [list[b], list[a]];
      sendOrder(list);
    }
  };
  const indent = (idx: number) => {
    const me = ordered[idx];
    if (me.depth === 1 || ordered.some(o => o.issue.parentId === me.issue.id)) return;
    const prevTop = [...ordered.slice(0, idx)].reverse().find(o => o.depth === 0);
    if (!prevTop) return;
    sendOrder(flat().map(x => x.id === me.issue.id ? { ...x, parentId: prevTop.issue.id } : x));
  };
  const outdent = (idx: number) => {
    const me = ordered[idx];
    if (!me.issue.parentId) return;
    // Becomes a top-level issue placed after its former parent's block.
    const list = flat().filter(x => x.id !== me.issue.id);
    let insertAt = list.findIndex(x => x.id === me.issue.parentId) + 1;
    while (insertAt < list.length && list[insertAt].parentId === me.issue.parentId) insertAt++;
    list.splice(insertAt, 0, { id: me.issue.id, parentId: null });
    sendOrder(list);
  };

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Section 4 – Observations by issue</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Rank the issues in priority order. Each issue becomes a heading with a brief summary, numbered key observations and its photos.
              Observations can come from any system.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" disabled={!!busy || !observations.length} data-testid="button-suggest-issues"
              onClick={async () => {
                setBusy("suggest");
                try {
                  const created = await aiPost("/api/ai/suggest-issues", { projectId });
                  refresh();
                  toast({ title: `${created.length} issue${created.length === 1 ? "" : "s"} suggested — review the order and grouping` });
                } catch (e: any) { toast({ title: e.message, variant: "destructive" }); } finally { setBusy(null); }
              }}>
              {busy === "suggest" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
              Suggest issues
            </Button>
            <Button size="sm" data-testid="button-add-issue" onClick={async () => {
              const res = await apiRequest("POST", `/api/projects/${projectId}/issues`, { title: "New issue" });
              const iss = await res.json(); refresh(); setOpen(iss.id);
            }}>
              <Plus className="w-4 h-4 mr-1" /> Add issue
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <Label>4.1 Overview</Label>
          <Button variant="ghost" size="sm" disabled={!!busy || !issues.length} onClick={async () => {
            setBusy("overview");
            try { await aiPost("/api/ai/write-observations-overview", { projectId }); queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId)] }); }
            catch (e: any) { toast({ title: e.message, variant: "destructive" }); } finally { setBusy(null); }
          }}>
            {busy === "overview" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />} Write overview
          </Button>
        </div>
        <SavedText value={overview} rows={3} placeholder="Overall condition and the key items, in priority order."
          onSave={(v) => apiRequest("PATCH", `/api/projects/${projectId}`, { observationsOverview: v })} />
      </Card>

      {ordered.map((o, idx) => (
        <IssueCard key={o.issue.id} entry={o} isOpen={open === o.issue.id} toggle={() => setOpen(open === o.issue.id ? null : o.issue.id)}
          systems={systems} observations={observations} recommendations={recommendations} assigned={assigned}
          onPatch={(b) => patch(o.issue.id, b)}
          onMove={(d) => move(idx, d)} onIndent={() => indent(idx)} onOutdent={() => outdent(idx)}
          onDelete={async () => { if (confirm(`Delete issue ${o.number}? Its observations are kept.`)) { await apiRequest("DELETE", `/api/issues/${o.issue.id}`); refresh(); queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/recommendations`] }); } }}
          projectId={projectId}
        />
      ))}

      {unassigned.length > 0 && (
        <Card className="p-4 space-y-2 border-amber-300 dark:border-amber-700">
          <h3 className="text-sm font-medium flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" />
            {unassigned.length} observation{unassigned.length === 1 ? "" : "s"} not in any issue (left out of Section 4)</h3>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {unassigned.map(ob => <li key={ob.id}><span className="font-mono">{ob.observationId}</span> {ob.defectCategory} — {ob.location} ({ob.severity})</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}

function IssueCard({
  entry, isOpen, toggle, systems, observations, recommendations, assigned, onPatch, onMove, onIndent, onOutdent, onDelete, projectId,
}: {
  entry: { issue: ReportIssue; number: string; depth: number }; isOpen: boolean; toggle: () => void;
  systems: FacadeSystem[]; observations: Observation[]; recommendations: Recommendation[]; assigned: Map<number, string>;
  onPatch: (b: any) => Promise<void>; onMove: (d: number) => void; onIndent: () => void; onOutdent: () => void; onDelete: () => void; projectId: number;
}) {
  const { toast } = useToast();
  const { issue, number, depth } = entry;
  const linked = ids(issue.observationIds);
  const photoSel = ids(issue.photoIds);
  const [writing, setWriting] = useState(false);
  const linkedObs = observations.filter(o => linked.includes(o.id));
  const photoQs = useQueries({ queries: (isOpen ? linked : []).map(oid => ({ queryKey: [`/api/observations/${oid}/photos`] })) });
  const photos = photoQs.flatMap(q => (q.data as Photo[] | undefined) || []);
  const issueRecs = recommendations.filter(r => (r as any).issueId === issue.id);
  const sevs = Array.from(new Set(linkedObs.map(o => o.severity)));
  const [rec, setRec] = useState({ action: "", timeframe: "Within 1 year", budgetEstimate: "", category: "Essential" });

  const toggleObs = (oid: number) => onPatch({ observationIds: linked.includes(oid) ? linked.filter(x => x !== oid) : [...linked, oid] });
  const togglePhoto = (pid: number) => onPatch({ photoIds: photoSel.includes(pid) ? photoSel.filter(x => x !== pid) : [...photoSel, pid] });

  return (
    <Card className={`p-3 space-y-3 ${depth ? "ml-8" : ""}`} data-testid={`card-issue-${issue.id}`}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggle}>{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</Button>
        <span className="font-mono text-sm w-12">{number}</span>
        <div className="flex-1"><SavedText input value={issue.title} onSave={(v) => onPatch({ title: v })} /></div>
        {sevs.map(s => <Badge key={s} variant={s === "Safety/Risk" ? "destructive" : "secondary"} className="hidden md:inline-flex">{s}</Badge>)}
        <span className="text-xs text-muted-foreground w-14 text-right">{linked.length} obs</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onMove(-1)} title="Move up"><ArrowUp className="w-3 h-3" /></Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onMove(1)} title="Move down"><ArrowDown className="w-3 h-3" /></Button>
        {depth === 0
          ? <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onIndent} title="Make sub-issue of the issue above"><IndentIncrease className="w-3 h-3" /></Button>
          : <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onOutdent} title="Make a main issue"><IndentDecrease className="w-3 h-3" /></Button>}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDelete} title="Delete issue"><Trash2 className="w-3 h-3" /></Button>
      </div>

      {isOpen && (
        <div className="space-y-4 pl-9">
          <div>
            <Label>Your steer for the AI (optional)</Label>
            <SavedText input value={issue.steer || ""} placeholder="e.g. lead with the safety risk above the Level 3 terrace; cause likely failed fixings" onSave={(v) => onPatch({ steer: v })} />
          </div>

          <div>
            <Label>Observations in this issue</Label>
            <div className="mt-1 max-h-64 overflow-y-auto border rounded-md p-2 space-y-2">
              {systems.map(sy => {
                const list = observations.filter(o => o.systemId === sy.id);
                if (!list.length) return null;
                return (
                  <div key={sy.id}>
                    <div className="text-xs font-medium text-muted-foreground">{sy.name}</div>
                    {list.map(o => {
                      const other = assigned.get(o.id);
                      return (
                        <label key={o.id} className="flex items-start gap-2 text-sm py-0.5">
                          <input type="checkbox" className="mt-1" checked={linked.includes(o.id)} onChange={() => toggleObs(o.id)} />
                          <span><span className="font-mono text-xs">{o.observationId}</span> {o.defectCategory} — {o.location}
                            <span className="text-xs text-muted-foreground"> ({o.severity}){other && !linked.includes(o.id) ? ` · in ${other}` : ""}</span></span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Summary (3–5 sentences, with severity)</Label>
              <Button variant="outline" size="sm" disabled={writing || !linked.length} data-testid={`button-write-issue-${issue.id}`}
                onClick={async () => {
                  setWriting(true);
                  try { await aiPost("/api/ai/write-issue", { issueId: issue.id }); queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/issues`] }); }
                  catch (e: any) { toast({ title: e.message, variant: "destructive" }); } finally { setWriting(false); }
                }}>
                {writing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                {issue.summary ? "Rewrite" : "Write"}
              </Button>
            </div>
            <SavedText value={issue.summary || ""} rows={4} onSave={(v) => onPatch({ summary: v })} />
            <Label>Key observations (numbered)</Label>
            <SavedText value={issue.keyObservations || ""} rows={10} placeholder={"1. Heading:\n   a. What and where\n   b. Cause / consequence where relevant"} onSave={(v) => onPatch({ keyObservations: v })} />
          </div>

          <div>
            <Label>Photos (shown at the end of the issue, in this order)</Label>
            {!linked.length ? <p className="text-xs text-muted-foreground">Link observations to choose photos.</p> :
              !photos.length ? <p className="text-xs text-muted-foreground">No photos on the linked observations.</p> : (
              <div className="flex flex-wrap gap-2 mt-1">
                {photos.map(ph => {
                  const pos = photoSel.indexOf(ph.id);
                  return (
                    <button key={ph.id} type="button" onClick={() => togglePhoto(ph.id)} title={ph.caption || ""}
                      className={`relative w-28 rounded border p-0.5 ${pos >= 0 ? "border-primary ring-1 ring-primary" : "opacity-60"}`}>
                      <img src={`${API_BASE}/api/uploads/${ph.filename}`} alt={ph.caption || ""} className="w-full h-20 object-cover rounded" loading="lazy" />
                      {pos >= 0 && <span className="absolute top-1 left-1 bg-primary text-primary-foreground text-xs rounded px-1">{pos + 1}</span>}
                      <span className="block text-[10px] truncate text-left">{ph.caption || "(no caption)"}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Issue-level recommendations (optional, e.g. one combined action)</Label>
            {issueRecs.map(r => (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{r.action}</span>
                <span className="text-xs text-muted-foreground">{r.timeframe} · {r.budgetEstimate || "no budget"}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={async () => {
                  await apiRequest("DELETE", `/api/recommendations/${r.id}`);
                  queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/recommendations`] });
                }}><Trash2 className="w-3 h-3" /></Button>
              </div>
            ))}
            <div className="grid grid-cols-12 gap-2">
              <Input className="col-span-6" placeholder="Action" value={rec.action} onChange={e => setRec({ ...rec, action: e.target.value })} />
              <div className="col-span-3">
                <Select value={rec.timeframe} onValueChange={v => setRec({ ...rec, timeframe: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{TIMEFRAMES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Input className="col-span-2" placeholder="Budget" value={rec.budgetEstimate} onChange={e => setRec({ ...rec, budgetEstimate: e.target.value })} />
              <Button className="col-span-1" size="icon" variant="outline" disabled={!rec.action.trim() || !linked.length} onClick={async () => {
                try {
                  await apiRequest("POST", `/api/issues/${issue.id}/recommendations`, rec);
                  setRec({ ...rec, action: "", budgetEstimate: "" });
                  queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/recommendations`] });
                } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
              }}><Plus className="w-4 h-4" /></Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
