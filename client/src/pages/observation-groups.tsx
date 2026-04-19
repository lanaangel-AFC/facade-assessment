import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, ChevronDown, ChevronRight, Sparkles, Loader2, Edit, Merge, Trash2, Save, Undo2 } from "lucide-react";
import type { Project, Photo } from "@shared/schema";
import { useState } from "react";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type GroupedObservation = {
  id: number;
  observationId: string;
  defectCategory: string;
  location: string;
  severity: string;
  extent: string;
  fieldNote: string | null;
  indicators: string;
  aiNarrative: string | null;
  groupId: number | null;
  photos: Photo[];
};

type GroupWithObs = {
  id: number;
  projectId: number;
  name: string;
  groupKey: string;
  sortOrder: number | null;
  combinedNarrative: string | null;
  observations: GroupedObservation[];
};

const severityColor = (s: string) => {
  switch (s) {
    case "Safety/Risk": return "bg-red-100 text-red-800";
    case "Essential": return "bg-amber-100 text-amber-800";
    case "Desirable": return "bg-blue-100 text-blue-800";
    case "Monitor": return "bg-green-100 text-green-800";
    default: return "";
  }
};

export default function ObservationGroupsPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: project } = useQuery<Project>({ queryKey: ["/api/projects", id] });
  const { data: groups, refetch } = useQuery<GroupWithObs[]>({
    queryKey: [`/api/projects/${id}/observation-groups`],
  });

  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [narratives, setNarratives] = useState<Record<number, string>>({});
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState<number | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string>("");
  const [moveObsDialogOpen, setMoveObsDialogOpen] = useState(false);
  const [movingObsId, setMovingObsId] = useState<number | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [generating, setGenerating] = useState(false);

  const toggle = (gid: number) => setExpanded(prev => ({ ...prev, [gid]: !prev[gid] }));

  const rebuildMutation = useMutation({
    mutationFn: async (grouping: string) => {
      const res = await apiRequest("POST", `/api/projects/${id}/observation-groups/rebuild`, { grouping });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observation-groups`] });
      toast({ title: "Groups rebuilt" });
    },
  });

  const saveNarrative = async (groupId: number) => {
    const text = narratives[groupId] ?? "";
    try {
      await apiRequest("PATCH", `/api/observation-groups/${groupId}`, { combinedNarrative: text });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observation-groups`] });
      toast({ title: "Narrative saved" });
    } catch (err: any) {
      toast({ title: err.message || "Failed to save", variant: "destructive" });
    }
  };

  const renameGroup = async () => {
    if (!renameId || !renameValue.trim()) return;
    try {
      await apiRequest("PATCH", `/api/observation-groups/${renameId}`, { name: renameValue.trim() });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observation-groups`] });
      setRenameId(null);
      setRenameValue("");
      toast({ title: "Group renamed" });
    } catch (err: any) {
      toast({ title: err.message || "Rename failed", variant: "destructive" });
    }
  };

  const doMerge = async () => {
    if (!mergeSource || !mergeTarget) return;
    try {
      await apiRequest("POST", `/api/observation-groups/merge`, {
        sourceId: mergeSource,
        targetId: Number(mergeTarget),
      });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observation-groups`] });
      setMergeDialogOpen(false);
      setMergeSource(null);
      setMergeTarget("");
      toast({ title: "Groups merged" });
    } catch (err: any) {
      toast({ title: err.message || "Merge failed", variant: "destructive" });
    }
  };

  const moveObservation = async () => {
    if (!movingObsId || !moveTarget) return;
    try {
      await apiRequest("PATCH", `/api/observations/${movingObsId}/group`, {
        groupId: Number(moveTarget),
      });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observation-groups`] });
      setMoveObsDialogOpen(false);
      setMovingObsId(null);
      setMoveTarget("");
      toast({ title: "Observation moved" });
    } catch (err: any) {
      toast({ title: err.message || "Move failed", variant: "destructive" });
    }
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${id}/observation-groups/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed");
      }
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observation-groups`] });
      toast({ title: "Combined narratives generated" });
    } catch (err: any) {
      toast({ title: err.message || "Generation failed", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const revertInProgress = async () => {
    if (!confirm("Revert this project back to in-progress? Groups will be kept but can be rebuilt.")) return;
    try {
      await apiRequest("PATCH", `/api/projects/${id}/status`, { inspectionStatus: "in_progress" });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      toast({ title: "Reverted to in-progress" });
      navigate(`/projects/${id}`);
    } catch (err: any) {
      toast({ title: err.message || "Revert failed", variant: "destructive" });
    }
  };

  const groupingLabel = project?.observationGrouping === "by_elevation"
    ? "By Elevation / Area"
    : project?.observationGrouping === "by_type"
    ? "By Type of Observation"
    : "";

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 pb-24">
      <Link href={`/projects/${id}`}>
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Project
        </button>
      </Link>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Review Observation Groups</h1>
          {groupingLabel && (
            <Badge variant="secondary" className="mt-1">{groupingLabel}</Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={revertInProgress}>
            <Undo2 className="w-4 h-4 mr-1" /> Revert to In-Progress
          </Button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => rebuildMutation.mutate("by_type")}
          disabled={rebuildMutation.isPending}
        >
          Rebuild by Type
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => rebuildMutation.mutate("by_elevation")}
          disabled={rebuildMutation.isPending}
        >
          Rebuild by Elevation
        </Button>
      </div>

      {(!groups || groups.length === 0) ? (
        <div className="text-sm text-muted-foreground text-center py-12">
          No groups yet. Choose a grouping method above to rebuild.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const isOpen = !!expanded[g.id];
            return (
              <Card key={g.id} className="overflow-hidden">
                <div className="flex items-center justify-between p-4 bg-accent/30 cursor-pointer" onClick={() => toggle(g.id)}>
                  <div className="flex items-center gap-2">
                    {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <h3 className="font-medium">{g.name}</h3>
                    <Badge variant="secondary">{g.observations.length}</Badge>
                  </div>
                  <div className="flex gap-1 items-center" onClick={(e) => e.stopPropagation()}>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setRenameId(g.id); setRenameValue(g.name); }}>
                      <Edit className="w-3.5 h-3.5 mr-1" /> Rename
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setMergeSource(g.id); setMergeDialogOpen(true); }}>
                      <Merge className="w-3.5 h-3.5 mr-1" /> Merge
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="p-4 space-y-3">
                    {g.observations.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No observations in this group.</p>
                    ) : g.observations.map((o) => (
                      <div key={o.id} className="border rounded-md p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm font-semibold">{o.observationId}</span>
                            <Badge variant="secondary" className="text-xs">{o.defectCategory}</Badge>
                            <Badge variant="secondary" className={`text-xs ${severityColor(o.severity)}`}>{o.severity}</Badge>
                            <span className="text-xs text-muted-foreground">{o.location}</span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => { setMovingObsId(o.id); setMoveObsDialogOpen(true); }}
                          >
                            Move
                          </Button>
                        </div>
                        {o.fieldNote && (
                          <p className="text-xs text-muted-foreground">{o.fieldNote.slice(0, 200)}</p>
                        )}
                        {o.photos && o.photos.length > 0 && (
                          <div className="flex gap-2 flex-wrap">
                            {o.photos.slice(0, 6).map((p) => (
                              <img
                                key={p.id}
                                src={`${API_BASE}/api/uploads/${p.filename}`}
                                alt={p.caption || ""}
                                className="w-16 h-16 object-cover rounded border"
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}

                    <div className="pt-2">
                      <Label className="text-xs">Combined Narrative</Label>
                      <Textarea
                        rows={6}
                        value={narratives[g.id] ?? (g.combinedNarrative || "")}
                        onChange={(e) => setNarratives(prev => ({ ...prev, [g.id]: e.target.value }))}
                        placeholder="Click 'Generate' below to produce a combined narrative, or write your own."
                      />
                      <div className="flex justify-end mt-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => saveNarrative(g.id)}>
                          <Save className="w-3.5 h-3.5 mr-1" /> Save Narrative
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t z-10">
        <div className="max-w-4xl mx-auto flex gap-2">
          <Button className="flex-1" onClick={generate} disabled={generating || !groups || groups.length === 0}>
            {generating ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>) : (<><Sparkles className="w-4 h-4 mr-2" /> Confirm Grouping & Generate Summaries</>)}
          </Button>
        </div>
      </div>

      {/* Rename dialog */}
      <Dialog open={renameId !== null} onOpenChange={(open) => { if (!open) setRenameId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label>Name</Label>
            <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameId(null)}>Cancel</Button>
            <Button onClick={renameGroup}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge dialog */}
      <Dialog open={mergeDialogOpen} onOpenChange={setMergeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge Group Into</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label>Target Group</Label>
            <Select value={mergeTarget} onValueChange={setMergeTarget}>
              <SelectTrigger>
                <SelectValue placeholder="Choose target" />
              </SelectTrigger>
              <SelectContent>
                {(groups || []).filter(g => g.id !== mergeSource).map(g => (
                  <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeDialogOpen(false)}>Cancel</Button>
            <Button onClick={doMerge} disabled={!mergeTarget}>Merge</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move observation dialog */}
      <Dialog open={moveObsDialogOpen} onOpenChange={setMoveObsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move Observation to Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label>Target Group</Label>
            <Select value={moveTarget} onValueChange={setMoveTarget}>
              <SelectTrigger>
                <SelectValue placeholder="Choose group" />
              </SelectTrigger>
              <SelectContent>
                {(groups || []).map(g => (
                  <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveObsDialogOpen(false)}>Cancel</Button>
            <Button onClick={moveObservation} disabled={!moveTarget}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
