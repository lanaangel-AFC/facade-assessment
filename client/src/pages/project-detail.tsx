import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Plus, ChevronRight, Trash2, X,
  MapPin, Building, Eye, Layers, DollarSign,
  FileText, Calendar, Sparkles, Loader2,
} from "lucide-react";
import type { Project, FacadeSystem, Observation, Recommendation } from "@shared/schema";
import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const aiRequest = async (url: string, body: any) => {
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return res;
};

const COMMON_LIMITATIONS = [
  "Visual inspection only — no destructive or invasive testing",
  "Inspection performed from ground level and accessible areas only",
  "Weather conditions limited visibility during inspection",
  "Some areas inaccessible due to scaffolding/hoardings",
  "No testing of sealant adhesion or curtain wall pressure",
  "Heritage listing constraints limit intrusive investigation",
];

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: project, isLoading: projectLoading } = useQuery<Project>({
    queryKey: ["/api/projects", id],
  });

  const { data: systems } = useQuery<FacadeSystem[]>({
    queryKey: [`/api/projects/${id}/systems`],
  });

  const { data: observations } = useQuery<Observation[]>({
    queryKey: [`/api/projects/${id}/observations`],
  });

  const { data: allRecommendations } = useQuery<Recommendation[]>({
    queryKey: [`/api/projects/${id}/recommendations`],
  });

  // Editable project fields
  const [editForm, setEditForm] = useState<Partial<Project>>({});
  const [inspectionDates, setInspectionDates] = useState<string[]>([]);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [backgroundDocs, setBackgroundDocs] = useState<{ title: string; author: string; date: string }[]>([]);
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [originalAiSummary, setOriginalAiSummary] = useState<string | null>(null);

  useEffect(() => {
    if (project) {
      setEditForm(project);
      try { setInspectionDates(JSON.parse(project.inspectionDates || "[]")); } catch { setInspectionDates([]); }
      try { setLimitations(JSON.parse(project.limitations || "[]")); } catch { setLimitations([]); }
      try { setBackgroundDocs(JSON.parse(project.backgroundDocs || "[]")); } catch { setBackgroundDocs([]); }
    }
  }, [project]);

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<Project>) => {
      const res = await apiRequest("PATCH", `/api/projects/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
    },
  });

  const autoSave = useCallback((data: Partial<Project>) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateMutation.mutate(data);
    }, 800);
  }, [id]);

  const updateField = (field: string, value: string) => {
    const updated = { ...editForm, [field]: value };
    setEditForm(updated);
    autoSave({ [field]: value });
  };

  const saveDates = (dates: string[]) => {
    setInspectionDates(dates);
    autoSave({ inspectionDates: JSON.stringify(dates) } as any);
  };

  const saveLimitations = (lims: string[]) => {
    setLimitations(lims);
    autoSave({ limitations: JSON.stringify(lims) } as any);
  };

  const saveDocs = (docs: { title: string; author: string; date: string }[]) => {
    setBackgroundDocs(docs);
    autoSave({ backgroundDocs: JSON.stringify(docs) } as any);
  };

  const deleteSystemMutation = useMutation({
    mutationFn: async (sysId: number) => {
      await apiRequest("DELETE", `/api/systems/${sysId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/systems`] });
      toast({ title: "System deleted" });
    },
  });

  const deleteObservationMutation = useMutation({
    mutationFn: async (obsId: number) => {
      await apiRequest("DELETE", `/api/observations/${obsId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observations`] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/recommendations`] });
      toast({ title: "Observation deleted" });
    },
  });

  if (projectLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="h-8 w-48 bg-muted animate-pulse rounded mb-4" />
        <div className="h-64 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <p>Project not found</p>
        <Link href="/"><Button variant="ghost">Back to projects</Button></Link>
      </div>
    );
  }

  // Group observations by system
  const observationsBySystem: Record<number, Observation[]> = {};
  const unlinkedObservations: Observation[] = [];
  (observations || []).forEach(obs => {
    if (obs.systemId) {
      if (!observationsBySystem[obs.systemId]) observationsBySystem[obs.systemId] = [];
      observationsBySystem[obs.systemId].push(obs);
    } else {
      unlinkedObservations.push(obs);
    }
  });

  // Build CAPEX data
  const capexRows: {
    obsId: string;
    location: string;
    defect: string;
    action: string;
    timeframe: string;
    category: string;
    budget: string;
  }[] = [];
  if (allRecommendations && observations) {
    for (const rec of allRecommendations) {
      const obs = observations.find(o => o.id === rec.observationId);
      if (obs) {
        capexRows.push({
          obsId: obs.observationId,
          location: obs.location,
          defect: `${obs.defectCategory}${obs.fieldNote ? " — " + obs.fieldNote.substring(0, 60) : ""}`,
          action: rec.action,
          timeframe: rec.timeframe,
          category: rec.category,
          budget: rec.budgetEstimate || "",
        });
      }
    }
    capexRows.sort((a, b) => a.obsId.localeCompare(b.obsId));
  }

  const severityColor = (severity: string) => {
    switch (severity) {
      case "Safety/Risk": return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
      case "Essential": return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
      case "Desirable": return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
      case "Monitor": return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
      default: return "";
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <Link href="/">
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />
          Back to Projects
        </button>
      </Link>

      <h1 className="text-xl font-semibold tracking-tight mb-1">{project.name}</h1>
      <p className="text-sm text-muted-foreground mb-6">{project.address}</p>

      <Tabs defaultValue="overview">
        <TabsList className="mb-6">
          <TabsTrigger value="overview" className="gap-1.5">
            <FileText className="w-4 h-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="systems" className="gap-1.5">
            <Layers className="w-4 h-4" />
            Systems
          </TabsTrigger>
          <TabsTrigger value="observations" className="gap-1.5">
            <Eye className="w-4 h-4" />
            Observations
          </TabsTrigger>
          <TabsTrigger value="capex" className="gap-1.5">
            <DollarSign className="w-4 h-4" />
            CAPEX
          </TabsTrigger>
        </TabsList>

        {/* === OVERVIEW TAB === */}
        <TabsContent value="overview">
          <div className="space-y-6">
            {/* Executive Summary */}
            <Card className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Executive Summary</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={aiSummaryLoading}
                  onClick={async () => {
                    setAiSummaryLoading(true);
                    try {
                      const res = await aiRequest("/api/ai/generate-executive-summary", { projectId: Number(id) });
                      const data = await res.json();
                      updateField("executiveSummary", data.summary);
                      setOriginalAiSummary(data.summary);
                      toast({ title: "Executive summary generated — review and edit" });
                    } catch (err: any) {
                      toast({ title: err.message || "Summary generation failed", variant: "destructive" });
                    } finally {
                      setAiSummaryLoading(false);
                    }
                  }}
                >
                  {aiSummaryLoading ? (
                    <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating...</>
                  ) : (
                    <><Sparkles className="w-4 h-4 mr-1" /> Generate Summary</>
                  )}
                </Button>
              </div>
              <Textarea
                value={editForm.executiveSummary || ""}
                onChange={e => updateField("executiveSummary", e.target.value)}
                rows={8}
                placeholder="Click 'Generate Summary' after adding observations and recommendations to create an AI-drafted executive summary."
              />
            </Card>

            <Card className="p-4 space-y-4">
              <h3 className="text-sm font-medium">Project Details</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Project Name</Label>
                  <Input value={editForm.name || ""} onChange={e => updateField("name", e.target.value)} />
                </div>
                <div>
                  <Label>Address</Label>
                  <Input value={editForm.address || ""} onChange={e => updateField("address", e.target.value)} />
                </div>
                <div>
                  <Label>Client</Label>
                  <Input value={editForm.client || ""} onChange={e => updateField("client", e.target.value)} />
                </div>
                <div>
                  <Label>Inspector</Label>
                  <Input value={editForm.inspector || ""} onChange={e => updateField("inspector", e.target.value)} />
                </div>
                <div>
                  <Label>AFC Reference</Label>
                  <Input value={editForm.afcReference || ""} onChange={e => updateField("afcReference", e.target.value)} />
                </div>
                <div>
                  <Label>Revision</Label>
                  <Input value={editForm.revision || ""} onChange={e => updateField("revision", e.target.value)} />
                </div>
                <div>
                  <Label>Building Age</Label>
                  <Input value={editForm.buildingAge || ""} onChange={e => updateField("buildingAge", e.target.value)} />
                </div>
                <div>
                  <Label>Building Use</Label>
                  <Input value={editForm.buildingUse || ""} onChange={e => updateField("buildingUse", e.target.value)} />
                </div>
                <div>
                  <Label>Storey Count</Label>
                  <Input value={editForm.storeyCount || ""} onChange={e => updateField("storeyCount", e.target.value)} />
                </div>
              </div>
              <div>
                <Label>Refurbishment History</Label>
                <Textarea
                  value={editForm.refurbishmentHistory || ""}
                  onChange={e => updateField("refurbishmentHistory", e.target.value)}
                  rows={2}
                  placeholder="Known facade refurbishment history..."
                />
              </div>
              <div>
                <Label>Inspection Scope</Label>
                <Textarea
                  value={editForm.inspectionScope || ""}
                  onChange={e => updateField("inspectionScope", e.target.value)}
                  rows={2}
                  placeholder="Scope of facade inspection..."
                />
              </div>
            </Card>

            {/* Inspection Dates */}
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-medium">Inspection Dates</h3>
              {inspectionDates.map((date, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={date}
                    onChange={e => {
                      const updated = [...inspectionDates];
                      updated[idx] = e.target.value;
                      saveDates(updated);
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const updated = inspectionDates.filter((_, i) => i !== idx);
                      saveDates(updated);
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => saveDates([...inspectionDates, new Date().toISOString().split("T")[0]])}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Date
              </Button>
            </Card>

            {/* Limitations */}
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-medium">Limitations</h3>
              {limitations.map((lim, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={lim}
                    onChange={e => {
                      const updated = [...limitations];
                      updated[idx] = e.target.value;
                      saveLimitations(updated);
                    }}
                    placeholder="Limitation description"
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => {
                    saveLimitations(limitations.filter((_, i) => i !== idx));
                  }}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                {COMMON_LIMITATIONS.filter(l => !limitations.includes(l)).slice(0, 3).map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => saveLimitations([...limitations, suggestion])}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    {suggestion.length > 50 ? suggestion.substring(0, 50) + "..." : suggestion}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => saveLimitations([...limitations, ""])}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Custom Limitation
              </Button>
            </Card>

            {/* Background Documents */}
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-medium">Background Documents Register</h3>
              {backgroundDocs.map((doc, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    placeholder="Document title"
                    value={doc.title}
                    onChange={e => {
                      const updated = [...backgroundDocs];
                      updated[idx] = { ...updated[idx], title: e.target.value };
                      saveDocs(updated);
                    }}
                  />
                  <Input
                    placeholder="Author"
                    value={doc.author}
                    className="w-32"
                    onChange={e => {
                      const updated = [...backgroundDocs];
                      updated[idx] = { ...updated[idx], author: e.target.value };
                      saveDocs(updated);
                    }}
                  />
                  <Input
                    type="date"
                    value={doc.date}
                    className="w-40"
                    onChange={e => {
                      const updated = [...backgroundDocs];
                      updated[idx] = { ...updated[idx], date: e.target.value };
                      saveDocs(updated);
                    }}
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => {
                    saveDocs(backgroundDocs.filter((_, i) => i !== idx));
                  }}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => saveDocs([...backgroundDocs, { title: "", author: "", date: "" }])}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Document
              </Button>
            </Card>
          </div>
        </TabsContent>

        {/* === SYSTEMS TAB === */}
        <TabsContent value="systems">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium">Facade Systems</h2>
            <Link href={`/projects/${id}/systems/new`}>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Add System
              </Button>
            </Link>
          </div>
          {!systems?.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Layers className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No facade systems defined yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {systems.map((sys) => (
                <Card key={sys.id} className="group relative">
                  <Link href={`/projects/${id}/systems/${sys.id}`}>
                    <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-accent/50 rounded-lg transition-colors">
                      <div className="min-w-0 flex-1">
                        <h3 className="font-medium">{sys.name}</h3>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <MapPin className="w-3.5 h-3.5 shrink-0" />
                            {sys.location}
                          </span>
                          <span className="flex items-center gap-1.5">
                            <Building className="w-3.5 h-3.5 shrink-0" />
                            {sys.systemType}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0 ml-3" />
                    </div>
                  </Link>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this system and its photos?")) {
                        deleteSystemMutation.mutate(sys.id);
                      }
                    }}
                    className="absolute top-3 right-12 p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* === OBSERVATIONS TAB === */}
        <TabsContent value="observations">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium">Observations</h2>
            <Link href={`/projects/${id}/observations/new`}>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Add Observation
              </Button>
            </Link>
          </div>

          {!observations?.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Eye className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No observations recorded yet.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Grouped by system */}
              {systems?.map(sys => {
                const sysObs = observationsBySystem[sys.id] || [];
                if (!sysObs.length) return null;
                return (
                  <div key={sys.id}>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">{sys.name}</h3>
                    <div className="space-y-2">
                      {sysObs.map(obs => (
                        <Card key={obs.id} className="group relative">
                          <Link href={`/projects/${id}/observations/${obs.id}`}>
                            <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-accent/50 rounded-lg transition-colors">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="font-mono text-sm font-semibold">{obs.observationId}</span>
                                  <Badge variant="secondary" className="text-xs">{obs.defectCategory}</Badge>
                                  <Badge variant="secondary" className={`text-xs ${severityColor(obs.severity)}`}>{obs.severity}</Badge>
                                </div>
                                <p className="text-sm text-muted-foreground truncate">
                                  {obs.location}{obs.fieldNote ? ` — ${obs.fieldNote.substring(0, 80)}` : ""}
                                </p>
                              </div>
                              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />
                            </div>
                          </Link>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm("Delete this observation and its recommendations?")) {
                                deleteObservationMutation.mutate(obs.id);
                              }
                            }}
                            className="absolute top-2 right-10 p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </Card>
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* Unlinked observations */}
              {unlinkedObservations.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-2">Unlinked Observations</h3>
                  <div className="space-y-2">
                    {unlinkedObservations.map(obs => (
                      <Card key={obs.id} className="group relative">
                        <Link href={`/projects/${id}/observations/${obs.id}`}>
                          <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-accent/50 rounded-lg transition-colors">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-mono text-sm font-semibold">{obs.observationId}</span>
                                <Badge variant="secondary" className="text-xs">{obs.defectCategory}</Badge>
                                <Badge variant="secondary" className={`text-xs ${severityColor(obs.severity)}`}>{obs.severity}</Badge>
                              </div>
                              <p className="text-sm text-muted-foreground truncate">
                                {obs.location}{obs.fieldNote ? ` — ${obs.fieldNote.substring(0, 80)}` : ""}
                              </p>
                            </div>
                            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />
                          </div>
                        </Link>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm("Delete this observation?")) {
                              deleteObservationMutation.mutate(obs.id);
                            }
                          }}
                          className="absolute top-2 right-10 p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* === CAPEX TAB === */}
        <TabsContent value="capex">
          <h2 className="text-lg font-medium mb-4">Capital Expenditure Summary</h2>
          {!capexRows.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <DollarSign className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No recommendations recorded yet. Add observations with recommendations to populate this table.</p>
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">ID</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Defect / Issue</TableHead>
                    <TableHead>Actions</TableHead>
                    <TableHead className="w-24">Time</TableHead>
                    <TableHead className="w-24">Category</TableHead>
                    <TableHead className="w-28">Budget</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {capexRows.map((row, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-mono text-xs">{row.obsId}</TableCell>
                      <TableCell className="text-xs">{row.location}</TableCell>
                      <TableCell className="text-xs">{row.defect}</TableCell>
                      <TableCell className="text-xs">{row.action}</TableCell>
                      <TableCell className="text-xs">{row.timeframe}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">{row.category}</Badge>
                      </TableCell>
                      <TableCell className="text-xs font-medium">{row.budget}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
