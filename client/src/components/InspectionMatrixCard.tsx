import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X, ArrowUp, ArrowDown, ClipboardList } from "lucide-react";
import type { Project } from "@shared/schema";
import {
  ACCESS_METHODS, INSPECTION_TYPES, STANDARD_AREAS, ASSISTED_BY_PRESETS, DEFAULT_INSPECTOR,
  type InspectionMatrix, type InspectionRow,
  emptyMatrix, parseMatrix, getMethod, buildInspectionText, inspectionTextToPlain, matrixDates,
} from "@shared/inspectionMatrix";

const newRow = (): InspectionRow => ({
  id: Math.random().toString(36).slice(2, 10),
  day: "", area: "", method: "abseil", extent: "", inspectionType: "visual_tactile", notes: "",
});

function initialMatrix(project: Project): InspectionMatrix {
  const parsed = parseMatrix((project as any).inspectionMatrix);
  if (parsed) return parsed;
  // Older project: pre-fill from legacy fields (not saved until edited).
  const m = emptyMatrix();
  try {
    const dates: string[] = JSON.parse(project.inspectionDates || "[]").filter(Boolean).sort();
    if (dates.length) { m.startDate = dates[0]; m.finishDate = dates.length > 1 ? dates[dates.length - 1] : ""; }
    if (dates.length > 2) m.daysOnSite = String(dates.length);
  } catch {}
  m.inspectors = [(project.inspector || "").trim() || DEFAULT_INSPECTOR];
  return m;
}

export default function InspectionMatrixCard({ project }: { project: Project }) {
  const projectId = project.id;
  const [m, setM] = useState<InspectionMatrix>(() => initialMatrix(project));
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedFor = useRef<number>(projectId);

  useEffect(() => {
    if (loadedFor.current !== projectId) { loadedFor.current = projectId; setM(initialMatrix(project)); }
  }, [projectId, project]);

  const { data: drops } = useQuery<{ id: number }[]>({ queryKey: [`/api/projects/${projectId}/drops`] });
  const roofPlanDrops = drops?.length || 0;

  const save = (next: InspectionMatrix) => {
    setM(next);
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await apiRequest("PATCH", `/api/projects/${projectId}`, {
          inspectionMatrix: JSON.stringify(next),
          inspectionDates: JSON.stringify(matrixDates(next)),
        });
        queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId)] });
        setSaveState("saved");
      } catch { setSaveState(""); }
    }, 700);
  };
  const set = (patch: Partial<InspectionMatrix>) => save({ ...m, ...patch });
  const setRow = (idx: number, patch: Partial<InspectionRow>) => {
    const rows = m.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    save({ ...m, rows });
  };
  const moveRow = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= m.rows.length) return;
    const rows = [...m.rows];
    [rows[idx], rows[j]] = [rows[j], rows[idx]];
    save({ ...m, rows });
  };

  const multiDay = !!m.finishDate && !!m.startDate && m.finishDate > m.startDate;
  const dayCount = useMemo(() => {
    if (!multiDay) return 1;
    const n = parseInt(m.daysOnSite, 10);
    if (n > 0) return n;
    return Math.round((Date.parse(m.finishDate) - Date.parse(m.startDate)) / 86400000) + 1;
  }, [m.startDate, m.finishDate, m.daysOnSite, multiDay]);

  const preview = useMemo(() => inspectionTextToPlain(buildInspectionText(m)), [m]);

  return (
    <Card className="p-4 space-y-5" data-testid="card-inspection-matrix">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-primary" /> Inspection (report section 2.2)
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Each row in the matrix becomes one numbered item under "The inspection covered:". The wording is generated
            automatically in AFC's standard format — check the preview at the bottom.
          </p>
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : ""}
        </span>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs">Start date</Label>
          <Input type="date" value={m.startDate} onChange={e => set({ startDate: e.target.value })} data-testid="input-insp-start" />
        </div>
        <div>
          <Label className="text-xs">Finish date (if more than one day)</Label>
          <Input type="date" value={m.finishDate} min={m.startDate || undefined} onChange={e => set({ finishDate: e.target.value })} data-testid="input-insp-finish" />
        </div>
        {multiDay && (
          <div>
            <Label className="text-xs">Days on site (if not every day)</Label>
            <Input type="number" min={1} value={m.daysOnSite} placeholder="All days" onChange={e => set({ daysOnSite: e.target.value })} />
          </div>
        )}
      </div>

      {/* Inspector(s) */}
      <div className="space-y-1 max-w-xl">
        <Label className="text-xs">Inspector(s)</Label>
        <Input value={m.inspectors.join("")} placeholder="e.g. Lana Angel, or Lana Angel and Peter Cauchois"
          onChange={e => set({ inspectors: [e.target.value] })} data-testid="input-insp-inspectors" />
        <p className="text-xs text-muted-foreground">Written as "by [name(s)] of AFC". The cover page uses the Inspector field in Project Details.</p>
      </div>

      {/* Assisted by */}
      <div className="space-y-2">
        <Label className="text-xs">With the assistance of</Label>
        <datalist id="assisted-by-presets">
          {ASSISTED_BY_PRESETS.map(p => <option key={p} value={p} />)}
        </datalist>
        {m.assistedBy.map((a, idx) => (
          <div key={idx} className="flex gap-2">
            <Input list="assisted-by-presets" value={a}
              placeholder="e.g. a rope access contractor, or Jack Gallett of GDP to drive the BMU"
              onChange={e => set({ assistedBy: m.assistedBy.map((x, i) => (i === idx ? e.target.value : x)) })} />
            <Button type="button" variant="ghost" size="icon" onClick={() => set({ assistedBy: m.assistedBy.filter((_, i) => i !== idx) })}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {ASSISTED_BY_PRESETS.filter(p => !m.assistedBy.includes(p)).map(p => (
            <Button key={p} type="button" variant="outline" size="sm" className="text-xs" onClick={() => set({ assistedBy: [...m.assistedBy, p] })}>
              <Plus className="w-3 h-3 mr-1" />{p}
            </Button>
          ))}
          <Button type="button" variant="outline" size="sm" className="text-xs" onClick={() => set({ assistedBy: [...m.assistedBy, ""] })}>
            <Plus className="w-3 h-3 mr-1" /> Custom
          </Button>
        </div>
      </div>

      {/* Matrix */}
      <div className="space-y-2">
        <Label className="text-xs">Inspection areas — one row per area and access method</Label>
        <datalist id="inspection-area-presets">
          {STANDARD_AREAS.map(a => <option key={a} value={a} />)}
        </datalist>
        {m.rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No areas yet. Add a row for each area inspected (e.g. Tower façade via abseil in 5 drops; Roof on foot).</p>
        )}
        {m.rows.map((row, idx) => {
          const def = getMethod(row.method);
          return (
            <div key={row.id} className="border rounded-md p-3 space-y-2 bg-muted/20" data-testid={`row-inspection-${idx}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Item {idx + 1}</span>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={idx === 0} onClick={() => moveRow(idx, -1)}><ArrowUp className="w-4 h-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={idx === m.rows.length - 1} onClick={() => moveRow(idx, 1)}><ArrowDown className="w-4 h-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => save({ ...m, rows: m.rows.filter((_, i) => i !== idx) })}><X className="w-4 h-4" /></Button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                <div className="md:col-span-4">
                  <Label className="text-xs">Area</Label>
                  <Input list="inspection-area-presets" value={row.area} placeholder="e.g. Tower façade, Roof, Level 3 terrace"
                    onChange={e => setRow(idx, { area: e.target.value })} />
                </div>
                <div className="md:col-span-3">
                  <Label className="text-xs">Access method</Label>
                  <Select value={row.method} onValueChange={v => setRow(idx, { method: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ACCESS_METHODS.map(am => <SelectItem key={am.key} value={am.key}>{am.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className={def?.key === "on_foot" ? "md:col-span-2 md:row-span-1" : "md:col-span-2"}>
                  <Label className="text-xs">{def?.unit ? `Extent (${def.unit})` : "Extent"}</Label>
                  <Input value={row.extent} disabled={!def?.unit}
                    placeholder={def?.key === "on_foot" ? "e.g. roofs; balconies at Levels 3 and 5" : def?.unit ? "e.g. 6, 5 full-height" : "—"}
                    onChange={e => setRow(idx, { extent: e.target.value })} />
                  {def?.unit === "drops" && roofPlanDrops > 0 && !row.extent && (
                    <button type="button" className="text-xs text-primary mt-1 underline" onClick={() => setRow(idx, { extent: String(roofPlanDrops) })}>
                      Use roof plan ({roofPlanDrops})
                    </button>
                  )}
                </div>
                <div className="md:col-span-3">
                  <Label className="text-xs">Day</Label>
                  <Select value={row.day || "none"} onValueChange={v => setRow(idx, { day: v === "none" ? "" : v })} disabled={!multiDay}>
                    <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not specified</SelectItem>
                      {Array.from({ length: dayCount }, (_, i) => String(i + 1)).map(d => <SelectItem key={d} value={d}>Day {d}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-5">
                  <Label className="text-xs">Inspection type</Label>
                  <Select value={INSPECTION_TYPES.some(t => t.key === row.inspectionType) ? row.inspectionType : "visual"} onValueChange={v => setRow(idx, { inspectionType: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INSPECTION_TYPES.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-7">
                  <Label className="text-xs">Sub-points (one per line, optional)</Label>
                  <Textarea rows={2} value={row.notes} placeholder={"e.g. Pin locations 4, 9, 11, 17 and 22\nRefer roof plan"}
                    onChange={e => setRow(idx, { notes: e.target.value })} />
                </div>
              </div>
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" onClick={() => save({ ...m, rows: [...m.rows, newRow()] })} data-testid="button-add-inspection-row">
          <Plus className="w-4 h-4 mr-1" /> Add area
        </Button>
      </div>

      {/* Preview */}
      <div className="space-y-1">
        <Label className="text-xs">Report preview — 2.2 Inspection</Label>
        <pre className="whitespace-pre-wrap text-sm bg-muted/40 border rounded-md p-3 font-sans" data-testid="text-inspection-preview">{preview}</pre>
      </div>
    </Card>
  );
}
