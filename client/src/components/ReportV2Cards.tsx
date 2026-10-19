import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X, ArrowUp, ArrowDown, Sparkles, Loader2, RotateCcw, FileText } from "lucide-react";
import {
  ASSESSMENT_TYPES, REPORT_TITLES, defaultTitleFor, REFERENCES_INTRO_PRESETS,
  STANDARD_LIMITATIONS, parseLimitations, type Limitation,
} from "@shared/reportV2";

type Form = Record<string, any>;
type Update = (field: string, value: string) => void;

/** Report type + title + engagement details (feeds the cover, footer and 2.1). */
export function ReportTypeCard({ form, updateField }: { form: Form; updateField: Update }) {
  const type = form.assessmentType || "condition";
  const titles = REPORT_TITLES[type] || [];
  return (
    <Card className="p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2"><FileText className="w-4 h-4 text-primary" />Report type</h3>
        <p className="text-xs text-muted-foreground mt-1">Sets the cover title, the page footer and how the report describes the engagement.</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Assessment type</Label>
          <Select
            value={type}
            onValueChange={(v) => { updateField("assessmentType", v); updateField("reportTitle", defaultTitleFor(v)); }}
          >
            <SelectTrigger data-testid="select-assessment-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ASSESSMENT_TYPES.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Report title (cover and footer)</Label>
          <Input
            list="report-title-options"
            value={form.reportTitle ?? defaultTitleFor(type)}
            onChange={e => updateField("reportTitle", e.target.value)}
            data-testid="input-report-title"
          />
          <datalist id="report-title-options">
            {titles.map(t => <option key={t} value={t} />)}
          </datalist>
        </div>
        <div>
          <Label>On behalf of (client's client)</Label>
          <Input
            value={form.clientOnBehalfOf || ""}
            onChange={e => updateField("clientOnBehalfOf", e.target.value)}
            placeholder="e.g. Quintessential Real Estate"
          />
        </div>
        <div>
          <Label>Purpose / specific aim</Label>
          <Input
            value={form.inspectionPurpose || ""}
            onChange={e => updateField("inspectionPurpose", e.target.value)}
            placeholder="e.g. understand cause and extent of louvre blade detachment at level 4"
          />
        </div>
      </div>
    </Card>
  );
}

/** 2.1 General, 3.1 General background, 3.2 Location — generated together, all editable. */
export function IntroBackgroundCard({
  form, updateField, onGenerate,
}: { form: Form; updateField: Update; onGenerate: () => Promise<any> }) {
  const [loading, setLoading] = useState(false);
  const has = !!(form.aiIntroduction || form.aiBackground);
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2"><Sparkles className="w-4 h-4 text-primary" />Introduction and background</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Written from Project Details, Report type and Project Context. 2.1 stays short; building history and the facility manager's input go in 3.1.
          </p>
        </div>
        <Button
          type="button" variant="outline" size="sm" disabled={loading}
          onClick={async () => { setLoading(true); try { await onGenerate(); } finally { setLoading(false); } }}
          data-testid="button-generate-intro-v2"
        >
          {loading ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating...</>
            : <><Sparkles className="w-4 h-4 mr-1" /> {has ? "Regenerate" : "Generate"}</>}
        </Button>
      </div>
      <div>
        <Label>2.1 General</Label>
        <Textarea rows={3} value={form.aiIntroduction || ""} onChange={e => updateField("aiIntroduction", e.target.value)}
          placeholder="Angel Façade Consulting (AFC) was engaged by … to carry out a condition assessment of the building envelope of … The purpose of the inspection was …" />
      </div>
      <div>
        <Label>3.1 General background</Label>
        <Textarea rows={6} value={form.aiBackground || ""} onChange={e => updateField("aiBackground", e.target.value)}
          placeholder="Building history, refurbishment, facility manager statement, known incidents or planned works." />
      </div>
      <div>
        <Label>3.2 Location (shown above the roof plan with drops)</Label>
        <Textarea rows={2} value={form.locationDescription || ""} onChange={e => updateField("locationDescription", e.target.value)}
          placeholder="The Property is located at … It is bounded by … to the north and … to the east." />
      </div>
    </Card>
  );
}

/** 2.3 opening sentence; the numbered list comes from the documents register. */
export function ReferencesIntroField({ form, updateField }: { form: Form; updateField: Update }) {
  return (
    <div className="space-y-1">
      <Label>2.3 Opening sentence</Label>
      <Textarea rows={2} value={form.referencesIntro || ""} onChange={e => updateField("referencesIntro", e.target.value)} />
      <div className="flex flex-wrap gap-1">
        {REFERENCES_INTRO_PRESETS.map((p, i) => (
          <Button key={i} type="button" variant="outline" size="sm" className="text-xs h-auto py-1 whitespace-normal text-left"
            onClick={() => updateField("referencesIntro", p)}>
            {p.length > 70 ? p.slice(0, 70) + "…" : p}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Uploaded project documents and the register below are listed as numbered references.</p>
    </div>
  );
}

/** Highlights [bracketed] values that need checking. */
function BracketPreview({ text }: { text: string }) {
  if (!/\[[^\]]*\]/.test(text)) return null;
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <p className="text-xs text-muted-foreground mt-0.5">
      {parts.map((p, i) => p.startsWith("[") ? <mark key={i} className="bg-amber-200/70 dark:bg-amber-500/30 px-0.5 rounded">{p}</mark> : <span key={i}>{p}</span>)}
    </p>
  );
}

/** 2.4 Limitations: full standard list, editable, with sub-items. */
export function LimitationsV2Card({ raw, onSave }: { raw: string | null | undefined; onSave: (json: string) => void }) {
  const [items, setItems] = useState<Limitation[]>(() => parseLimitations(raw));
  const timer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const save = (next: Limitation[]) => {
    setItems(next);
    onSave(JSON.stringify(next));
  };
  const upd = (i: number, patch: Partial<Limitation>) => save(items.map((it, j) => j === i ? { ...it, ...patch } : it));
  const move = (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= items.length) return;
    const next = [...items]; [next[i], next[j]] = [next[j], next[i]]; save(next);
  };
  const unresolved = items.reduce((n, it) => n + [it.text, ...it.subs].filter(t => /\[[^\]]*\]/.test(t)).length, 0);

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">2.4 Limitations</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Edit values in [square brackets] for this project; the brackets are removed in the export.
            {unresolved > 0 && <span className="text-amber-600 dark:text-amber-400"> {unresolved} item{unresolved > 1 ? "s" : ""} with bracketed values to check.</span>}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => {
          if (!items.length || confirm("Replace the current limitations with the standard list?")) save(STANDARD_LIMITATIONS.map(l => ({ text: l.text, subs: [...l.subs] })));
        }}>
          <RotateCcw className="w-4 h-4 mr-1" /> Load standard list
        </Button>
      </div>
      <ol className="space-y-3">
        {items.map((it, i) => (
          <li key={i} className="border rounded-md p-2 space-y-2">
            <div className="flex items-start gap-2">
              <span className="text-xs text-muted-foreground w-5 pt-2">{i + 1}.</span>
              <div className="flex-1">
                <Textarea rows={2} value={it.text} onChange={e => upd(i, { text: e.target.value })} className="text-sm" />
                <BracketPreview text={it.text} />
              </div>
              <div className="flex flex-col">
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => move(i, -1)}><ArrowUp className="w-3 h-3" /></Button>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => move(i, 1)}><ArrowDown className="w-3 h-3" /></Button>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => save(items.filter((_, j) => j !== i))}><X className="w-3 h-3" /></Button>
              </div>
            </div>
            {it.subs.map((sub, k) => (
              <div key={k} className="flex items-start gap-2 pl-7">
                <span className="text-xs text-muted-foreground w-4 pt-2">{String.fromCharCode(97 + k)}.</span>
                <div className="flex-1">
                  <Textarea rows={sub.length > 90 ? 2 : 1} value={sub} className="text-sm min-h-0" onChange={e => upd(i, { subs: it.subs.map((s, m) => m === k ? e.target.value : s) })} />
                  <BracketPreview text={sub} />
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => upd(i, { subs: it.subs.filter((_, m) => m !== k) })}><X className="w-3 h-3" /></Button>
              </div>
            ))}
            <div className="pl-7">
              <Button type="button" variant="ghost" size="sm" className="text-xs h-7" onClick={() => upd(i, { subs: [...it.subs, ""] })}>
                <Plus className="w-3 h-3 mr-1" /> Sub-item
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <Button type="button" variant="outline" size="sm" onClick={() => save([...items, { text: "", subs: [] }])}>
        <Plus className="w-4 h-4 mr-1" /> Add limitation
      </Button>
    </Card>
  );
}
