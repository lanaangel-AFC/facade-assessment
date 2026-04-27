import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, ArrowUpDown, ArrowUp, ArrowDown, Loader2, ExternalLink, DollarSign } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Observation, Recommendation, FacadeSystem } from "@shared/schema";

type SeverityCategory = "Safety/Risk" | "Essential" | "Desirable" | "Monitor";
const SEVERITY_OPTIONS: SeverityCategory[] = ["Safety/Risk", "Essential", "Desirable", "Monitor"];
const TIMEFRAME_OPTIONS = ["Immediate", "3 months", "1 year", "2 years", "5 years", "10 years"] as const;

type SortKey = "obsId" | "system" | "location" | "action" | "category" | "timeframe" | "budget";
type SortDir = "asc" | "desc";

const severityClasses = (cat: string): { bg: string; border: string; text: string; chip: string } => {
  switch (cat) {
    case "Safety/Risk":
      return {
        bg: "bg-red-50 dark:bg-red-900/20",
        border: "border-l-4 border-l-red-500",
        text: "text-red-800 dark:text-red-300",
        chip: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border-red-300",
      };
    case "Essential":
      return {
        bg: "bg-orange-50 dark:bg-orange-900/20",
        border: "border-l-4 border-l-orange-500",
        text: "text-orange-800 dark:text-orange-300",
        chip: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300 border-orange-300",
      };
    case "Desirable":
      return {
        bg: "bg-yellow-50 dark:bg-yellow-900/20",
        border: "border-l-4 border-l-yellow-500",
        text: "text-yellow-800 dark:text-yellow-300",
        chip: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-300",
      };
    case "Monitor":
      return {
        bg: "bg-green-50 dark:bg-green-900/20",
        border: "border-l-4 border-l-green-500",
        text: "text-green-800 dark:text-green-300",
        chip: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-green-300",
      };
    default:
      return { bg: "", border: "", text: "", chip: "" };
  }
};

// Parse a budget string (e.g. "$1,500", "AUD 12000", "12500") into a numeric value for totals.
const parseBudgetToNumber = (s: string | null | undefined): number => {
  if (!s) return 0;
  const cleaned = String(s).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
};

const formatCurrency = (n: number): string => {
  if (!Number.isFinite(n) || n === 0) return "$0";
  return n.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  });
};

type RowSaveState = "idle" | "saving" | "saved" | "error";

interface EditableCellState {
  action: string;
  budgetEstimate: string;
  category: string;
  timeframe: string;
}

export default function CapexPage() {
  const { projectId: projectIdStr } = useParams<{ projectId: string }>();
  const projectId = Number(projectIdStr);
  const { toast } = useToast();

  const { data: project } = useQuery<Project>({
    queryKey: ["/api/projects", projectId],
    enabled: !Number.isNaN(projectId),
  });
  const { data: observations } = useQuery<Observation[]>({
    queryKey: [`/api/projects/${projectId}/observations`],
    enabled: !Number.isNaN(projectId),
  });
  const { data: systems } = useQuery<FacadeSystem[]>({
    queryKey: [`/api/projects/${projectId}/systems`],
    enabled: !Number.isNaN(projectId),
  });
  const { data: recommendations } = useQuery<Recommendation[]>({
    queryKey: [`/api/projects/${projectId}/recommendations`],
    enabled: !Number.isNaN(projectId),
  });

  // Local edit buffer per recommendation id (so debounce doesn't fight react-query refetches)
  const [drafts, setDrafts] = useState<Record<number, EditableCellState>>({});
  const [rowState, setRowState] = useState<Record<number, RowSaveState>>({});
  const debounceTimers = useRef<Record<number, number>>({});

  // Keep drafts in sync with server data when not actively editing
  useEffect(() => {
    if (!recommendations) return;
    setDrafts(prev => {
      const next: Record<number, EditableCellState> = { ...prev };
      for (const rec of recommendations) {
        if (!next[rec.id]) {
          next[rec.id] = {
            action: rec.action || "",
            budgetEstimate: rec.budgetEstimate || "",
            category: rec.category || "Essential",
            timeframe: rec.timeframe || "1 year",
          };
        }
      }
      // Drop drafts for recs that no longer exist
      for (const idStr of Object.keys(next)) {
        const id = Number(idStr);
        if (!recommendations.find(r => r.id === id)) delete next[id];
      }
      return next;
    });
  }, [recommendations]);

  const patchMutation = useMutation({
    mutationFn: async (vars: { id: number; patch: Partial<Recommendation>; observationId: number }) => {
      const res = await apiRequest("PATCH", `/api/recommendations/${vars.id}`, vars.patch);
      return res.json();
    },
    onMutate: async (vars) => {
      setRowState(s => ({ ...s, [vars.id]: "saving" }));
    },
    onSuccess: (_data, vars) => {
      setRowState(s => ({ ...s, [vars.id]: "saved" }));
      // Reset to idle after a moment
      window.setTimeout(() => {
        setRowState(s => ({ ...s, [vars.id]: "idle" }));
      }, 1500);
      // Invalidate caches that depend on recommendation data
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/recommendations`] });
      queryClient.invalidateQueries({ queryKey: [`/api/observations/${vars.observationId}/recommendations`] });
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations", vars.id] });
    },
    onError: (err: any, vars) => {
      setRowState(s => ({ ...s, [vars.id]: "error" }));
      toast({
        title: "Save failed",
        description: err?.message || "Could not save change",
        variant: "destructive" as any,
      });
    },
  });

  // Schedule a debounced save of the current draft for a given rec id
  const scheduleSave = (rec: Recommendation, delayMs: number) => {
    const existing = debounceTimers.current[rec.id];
    if (existing) window.clearTimeout(existing);
    debounceTimers.current[rec.id] = window.setTimeout(() => {
      const draft = drafts[rec.id];
      if (!draft) return;
      const patch: Partial<Recommendation> = {};
      if (draft.action !== (rec.action || "")) patch.action = draft.action;
      if (draft.budgetEstimate !== (rec.budgetEstimate || "")) patch.budgetEstimate = draft.budgetEstimate;
      if (draft.category !== (rec.category || "")) patch.category = draft.category;
      if (draft.timeframe !== (rec.timeframe || "")) patch.timeframe = draft.timeframe;
      if (Object.keys(patch).length === 0) return;
      patchMutation.mutate({ id: rec.id, patch, observationId: rec.observationId });
    }, delayMs);
  };

  // Force-save immediately (used on blur and on Select change)
  const flushSave = (rec: Recommendation) => {
    const existing = debounceTimers.current[rec.id];
    if (existing) window.clearTimeout(existing);
    const draft = drafts[rec.id];
    if (!draft) return;
    const patch: Partial<Recommendation> = {};
    if (draft.action !== (rec.action || "")) patch.action = draft.action;
    if (draft.budgetEstimate !== (rec.budgetEstimate || "")) patch.budgetEstimate = draft.budgetEstimate;
    if (draft.category !== (rec.category || "")) patch.category = draft.category;
    if (draft.timeframe !== (rec.timeframe || "")) patch.timeframe = draft.timeframe;
    if (Object.keys(patch).length === 0) return;
    patchMutation.mutate({ id: rec.id, patch, observationId: rec.observationId });
  };

  // Build display rows by joining recs with observations + systems
  const obsById = useMemo(() => {
    const m: Record<number, Observation> = {};
    (observations || []).forEach(o => { m[o.id] = o; });
    return m;
  }, [observations]);
  const systemById = useMemo(() => {
    const m: Record<number, FacadeSystem> = {};
    (systems || []).forEach(s => { m[s.id] = s; });
    return m;
  }, [systems]);

  type Row = {
    rec: Recommendation;
    obs: Observation | undefined;
    system: FacadeSystem | undefined;
    obsLabel: string;
    systemName: string;
    location: string;
  };

  const rows: Row[] = useMemo(() => {
    if (!recommendations) return [];
    return recommendations.map(rec => {
      const obs = obsById[rec.observationId];
      const system = obs?.systemId ? systemById[obs.systemId] : undefined;
      return {
        rec,
        obs,
        system,
        obsLabel: obs?.observationId || "—",
        systemName: system?.name || "—",
        location: obs?.location || "",
      };
    });
  }, [recommendations, obsById, systemById]);

  // Filtering by severity (the rec.category, with the convention that Safety/Risk
  // is allowed as a CAPEX-level severity and is also derived from observation.severity)
  const [filter, setFilter] = useState<SeverityCategory | "All">("All");
  const filteredRows = useMemo(() => {
    if (filter === "All") return rows;
    return rows.filter(r => {
      const draft = drafts[r.rec.id];
      const cat = draft?.category || r.rec.category;
      // Safety/Risk filter also matches observations marked Safety/Risk even if rec.category is Essential
      if (filter === "Safety/Risk") {
        return cat === "Safety/Risk" || r.obs?.severity === "Safety/Risk";
      }
      return cat === filter;
    });
  }, [rows, filter, drafts]);

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>("obsId");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const sortedRows = useMemo(() => {
    const out = [...filteredRows];
    out.sort((a, b) => {
      const draftA = drafts[a.rec.id];
      const draftB = drafts[b.rec.id];
      let av: any;
      let bv: any;
      switch (sortKey) {
        case "obsId":
          av = a.obsLabel; bv = b.obsLabel; break;
        case "system":
          av = a.systemName; bv = b.systemName; break;
        case "location":
          av = a.location; bv = b.location; break;
        case "action":
          av = draftA?.action ?? a.rec.action; bv = draftB?.action ?? b.rec.action; break;
        case "category":
          av = draftA?.category ?? a.rec.category; bv = draftB?.category ?? b.rec.category; break;
        case "timeframe":
          av = draftA?.timeframe ?? a.rec.timeframe; bv = draftB?.timeframe ?? b.rec.timeframe; break;
        case "budget":
          av = parseBudgetToNumber(draftA?.budgetEstimate ?? a.rec.budgetEstimate);
          bv = parseBudgetToNumber(draftB?.budgetEstimate ?? b.rec.budgetEstimate);
          break;
      }
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const sa = String(av || "");
      const sb = String(bv || "");
      return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
    return out;
  }, [filteredRows, sortKey, sortDir, drafts]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // Totals
  const totals = useMemo(() => {
    const buckets: Record<string, number> = {
      "Safety/Risk": 0, "Essential": 0, "Desirable": 0, "Monitor": 0,
    };
    let grand = 0;
    for (const row of rows) {
      const draft = drafts[row.rec.id];
      const cat = draft?.category || row.rec.category || "";
      const amount = parseBudgetToNumber(draft?.budgetEstimate ?? row.rec.budgetEstimate);
      grand += amount;
      if (cat in buckets) buckets[cat] += amount;
      // Treat Safety/Risk on the observation as overriding for subtotal grouping
      if (row.obs?.severity === "Safety/Risk" && cat !== "Safety/Risk") {
        // do nothing here - keep cat-derived grouping
      }
    }
    return { buckets, grand };
  }, [rows, drafts]);

  if (Number.isNaN(projectId)) {
    return <div className="max-w-4xl mx-auto p-8">Invalid project</div>;
  }
  if (!project) {
    return (
      <div className="max-w-4xl mx-auto p-8 text-center text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
        Loading project…
      </div>
    );
  }

  const SortHeader = ({ label, k, className }: { label: string; k: SortKey; className?: string }) => (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {sortKey === k ? (
          sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );

  const renderRowSaveStatus = (id: number) => {
    const s = rowState[id] || "idle";
    if (s === "saving") return <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving…</span>;
    if (s === "saved") return <span className="text-xs text-green-600 dark:text-green-400">Saved</span>;
    if (s === "error") return <span className="text-xs text-red-600">Error</span>;
    return <span className="text-xs text-muted-foreground/40">—</span>;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <Link href={`/projects/${projectId}`}>
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />
          Back to {project.name}
        </button>
      </Link>

      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-muted-foreground" />
            CAPEX Schedule
          </h1>
          <p className="text-sm text-muted-foreground">
            Edit cost, recommendation text, severity, and timeline. Changes save automatically and flow to the source observations and Word export.
          </p>
        </div>
      </div>

      {/* Severity filter chips + totals */}
      <div className="flex items-center justify-between mt-6 mb-4 flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Filter</span>
          <Button
            type="button"
            size="sm"
            variant={filter === "All" ? "default" : "outline"}
            onClick={() => setFilter("All")}
          >
            All ({rows.length})
          </Button>
          {SEVERITY_OPTIONS.map(s => {
            const cls = severityClasses(s);
            const count = rows.filter(r => {
              const cat = drafts[r.rec.id]?.category || r.rec.category;
              if (s === "Safety/Risk") return cat === s || r.obs?.severity === "Safety/Risk";
              return cat === s;
            }).length;
            const active = filter === s;
            return (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => setFilter(s)}
                className={active ? "" : cls.chip + " border"}
              >
                {s} ({count})
              </Button>
            );
          })}
        </div>
        <div className="text-sm text-right">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Total CAPEX</div>
          <div className="text-lg font-semibold">{formatCurrency(totals.grand)}</div>
        </div>
      </div>

      {/* Subtotals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
        {SEVERITY_OPTIONS.map(s => {
          const cls = severityClasses(s);
          return (
            <div key={s} className={`rounded-md border ${cls.bg} px-3 py-2`}>
              <div className={`text-xs uppercase tracking-wide ${cls.text}`}>{s}</div>
              <div className="text-base font-semibold">{formatCurrency(totals.buckets[s] || 0)}</div>
            </div>
          );
        })}
      </div>

      {sortedRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center border rounded-md">
          <DollarSign className="w-10 h-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            {rows.length === 0
              ? "No recommendations recorded yet. Add observations with recommendations to populate this schedule."
              : "No rows match the current filter."}
          </p>
        </div>
      ) : (
        <>
          {/* DESKTOP TABLE */}
          <div className="hidden md:block rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <SortHeader label="Obs" k="obsId" className="w-20" />
                  <SortHeader label="System" k="system" className="w-32" />
                  <SortHeader label="Location" k="location" className="w-40" />
                  <SortHeader label="Recommendation" k="action" />
                  <SortHeader label="Severity" k="category" className="w-36" />
                  <SortHeader label="Timeline" k="timeframe" className="w-28" />
                  <SortHeader label="Cost" k="budget" className="w-32" />
                  <TableHead className="w-20">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((row, idx) => {
                  const draft = drafts[row.rec.id];
                  if (!draft) return null;
                  const cls = severityClasses(draft.category);
                  return (
                    <TableRow key={row.rec.id} className={cls.bg}>
                      <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.obs ? (
                          <Link href={`/projects/${projectId}/observations/${row.obs.id}`}>
                            <a className="text-primary hover:underline inline-flex items-center gap-0.5">
                              {row.obsLabel}
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </Link>
                        ) : (
                          <span>{row.obsLabel}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{row.systemName}</TableCell>
                      <TableCell className="text-xs">{row.location}</TableCell>
                      <TableCell className={`align-top ${cls.border}`}>
                        <Textarea
                          value={draft.action}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], action: v } }));
                            scheduleSave(row.rec, 700);
                          }}
                          onBlur={() => flushSave(row.rec)}
                          className="min-h-[60px] text-xs"
                          rows={2}
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={draft.category}
                          onValueChange={(v) => {
                            setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], category: v } }));
                            // Defer flush so state is committed first
                            window.setTimeout(() => flushSave(row.rec), 0);
                          }}
                        >
                          <SelectTrigger className={`text-xs ${cls.chip} border`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SEVERITY_OPTIONS.map(s => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={draft.timeframe}
                          onValueChange={(v) => {
                            setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], timeframe: v } }));
                            window.setTimeout(() => flushSave(row.rec), 0);
                          }}
                        >
                          <SelectTrigger className="text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TIMEFRAME_OPTIONS.map(t => (
                              <SelectItem key={t} value={t}>{t}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={draft.budgetEstimate}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], budgetEstimate: v } }));
                            scheduleSave(row.rec, 700);
                          }}
                          onBlur={() => flushSave(row.rec)}
                          placeholder="$"
                          className="text-xs"
                        />
                      </TableCell>
                      <TableCell>{renderRowSaveStatus(row.rec.id)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* MOBILE CARDS */}
          <div className="md:hidden space-y-3">
            {sortedRows.map((row, idx) => {
              const draft = drafts[row.rec.id];
              if (!draft) return null;
              const cls = severityClasses(draft.category);
              return (
                <div key={row.rec.id} className={`rounded-md border ${cls.bg} ${cls.border} p-3 space-y-2`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{idx + 1}</span>
                      {row.obs ? (
                        <Link href={`/projects/${projectId}/observations/${row.obs.id}`}>
                          <a className="font-mono text-xs text-primary hover:underline inline-flex items-center gap-0.5">
                            {row.obsLabel}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </Link>
                      ) : (
                        <span className="font-mono text-xs">{row.obsLabel}</span>
                      )}
                      <Badge variant="outline" className="text-[10px]">{row.systemName}</Badge>
                    </div>
                    {renderRowSaveStatus(row.rec.id)}
                  </div>
                  <div className="text-xs text-muted-foreground">{row.location}</div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Recommendation</label>
                    <Textarea
                      value={draft.action}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], action: v } }));
                        scheduleSave(row.rec, 700);
                      }}
                      onBlur={() => flushSave(row.rec)}
                      className="min-h-[60px] text-xs"
                      rows={3}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Severity</label>
                      <Select
                        value={draft.category}
                        onValueChange={(v) => {
                          setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], category: v } }));
                          window.setTimeout(() => flushSave(row.rec), 0);
                        }}
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SEVERITY_OPTIONS.map(s => (
                            <SelectItem key={s} value={s}>{s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Timeline</label>
                      <Select
                        value={draft.timeframe}
                        onValueChange={(v) => {
                          setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], timeframe: v } }));
                          window.setTimeout(() => flushSave(row.rec), 0);
                        }}
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TIMEFRAME_OPTIONS.map(t => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Cost</label>
                      <Input
                        value={draft.budgetEstimate}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDrafts(d => ({ ...d, [row.rec.id]: { ...d[row.rec.id], budgetEstimate: v } }));
                          scheduleSave(row.rec, 700);
                        }}
                        onBlur={() => flushSave(row.rec)}
                        placeholder="$"
                        className="text-xs"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
