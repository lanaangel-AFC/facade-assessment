import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowUp, ArrowDown, ChevronRight, Trash2, ImageIcon, MapPin, Building } from "lucide-react";
import type { FacadeSystem, Photo } from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Photo strip for one system: tick photos to include at the end of 3.3. */
function SystemPhotoPicker({ systemId }: { systemId: number }) {
  const key = [`/api/systems/${systemId}/photos`];
  const { data: photos } = useQuery<Photo[]>({ queryKey: key });
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => (await apiRequest("PATCH", `/api/photos/${id}`, body)).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  if (!photos?.length) return <p className="text-xs text-muted-foreground">No system photos yet.</p>;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {photos.map(ph => {
        const on = !!(ph as any).includeInReport;
        return (
          <div key={ph.id} className={`shrink-0 w-36 rounded-md border p-1 ${on ? "border-primary ring-1 ring-primary" : "opacity-70"}`}>
            <button type="button" className="block w-full" onClick={() => patch.mutate({ id: ph.id, body: { includeInReport: !on } })}
              title={on ? "Included in 3.3 — click to remove" : "Click to include in 3.3"}>
              <img src={`${API_BASE}/api/uploads/${ph.filename}`} alt={ph.caption || ""} className="w-full h-24 object-cover rounded" loading="lazy" />
            </button>
            <label className="flex items-center gap-1 text-xs mt-1">
              <input type="checkbox" checked={on} onChange={() => patch.mutate({ id: ph.id, body: { includeInReport: !on } })} />
              In report
            </label>
            {on && (
              <CaptionInput initial={ph.caption || ""} onSave={(caption) => patch.mutate({ id: ph.id, body: { caption } })} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CaptionInput({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  const t = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => setV(initial), [initial]);
  return (
    <Input value={v} placeholder="Caption" className="h-7 text-xs mt-1"
      onChange={e => {
        setV(e.target.value);
        if (t.current) clearTimeout(t.current);
        const val = e.target.value;
        t.current = setTimeout(() => onSave(val), 800);
      }} />
  );
}

function HeadingInput({ sys }: { sys: FacadeSystem }) {
  const [v, setV] = useState((sys as any).reportHeading || "");
  const t = useRef<NodeJS.Timeout | null>(null);
  return (
    <Input value={v} list="system-heading-options" placeholder={`Report heading (default: ${sys.name})`} className="h-8 text-sm"
      onChange={e => {
        setV(e.target.value);
        const val = e.target.value;
        if (t.current) clearTimeout(t.current);
        t.current = setTimeout(async () => {
          await apiRequest("PATCH", `/api/systems/${sys.id}`, { reportHeading: val });
          queryClient.invalidateQueries({ queryKey: [`/api/projects/${sys.projectId}/systems`] });
        }, 800);
      }} />
  );
}

export default function SystemsReportList({
  projectId, systems, onDelete,
}: { projectId: number; systems: FacadeSystem[]; onDelete: (id: number) => void }) {
  const [openPhotos, setOpenPhotos] = useState<number | null>(null);
  const move = async (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= systems.length) return;
    const ids = systems.map(s => s.id); [ids[i], ids[j]] = [ids[j], ids[i]];
    queryClient.setQueryData([`/api/projects/${projectId}/systems`], ids.map(id => systems.find(s => s.id === id)));
    await apiRequest("POST", `/api/projects/${projectId}/systems/reorder`, { order: ids });
    queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/systems`] });
  };
  const headings = Array.from(new Set(systems.map(s => ((s as any).reportHeading || "").trim()).filter(Boolean)));

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        The order here is the order of the façade description (3.3). Give systems the same report heading to combine them into one item.
        Tick the photos to show at the end of 3.3.
      </p>
      <datalist id="system-heading-options">{headings.map(h => <option key={h} value={h} />)}</datalist>
      {systems.map((sys, i) => (
        <Card key={sys.id} className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-6">{i + 1}.</span>
            <div className="flex flex-col">
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="w-3 h-3" /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={i === systems.length - 1} onClick={() => move(i, 1)}><ArrowDown className="w-3 h-3" /></Button>
            </div>
            <Link href={`/projects/${projectId}/systems/${sys.id}`} className="min-w-0 flex-1 hover:underline">
              <div className="font-medium truncate">{sys.name}</div>
              <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{sys.location}</span>
                <span className="flex items-center gap-1"><Building className="w-3 h-3" />{sys.systemType}</span>
              </div>
            </Link>
            <div className="w-64 hidden sm:block"><HeadingInput sys={sys} /></div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpenPhotos(openPhotos === sys.id ? null : sys.id)}>
              <ImageIcon className="w-4 h-4 mr-1" /> Photos
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => { if (confirm("Delete this system and its photos?")) onDelete(sys.id); }}>
              <Trash2 className="w-4 h-4" />
            </Button>
            <Link href={`/projects/${projectId}/systems/${sys.id}`}><ChevronRight className="w-5 h-5 text-muted-foreground" /></Link>
          </div>
          <div className="sm:hidden"><HeadingInput sys={sys} /></div>
          {openPhotos === sys.id && <SystemPhotoPicker systemId={sys.id} />}
        </Card>
      ))}
    </div>
  );
}
