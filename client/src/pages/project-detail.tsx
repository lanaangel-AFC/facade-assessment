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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Plus, ChevronRight, Trash2, X,
  MapPin, Building, Eye, Layers, DollarSign,
  FileText, Calendar, Sparkles, Loader2, Image as ImageIcon, Upload, CheckCircle2, ClipboardList, Download,
} from "lucide-react";
import type { Project, FacadeSystem, Observation, Recommendation, Elevation } from "@shared/schema";
import { useState, useEffect, useCallback, useRef } from "react";
import RoofPlanMarkup from "@/components/roof-plan-markup";

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

const VALID_TABS = ["overview", "systems", "elevations", "observations", "capex"] as const;
type TabValue = typeof VALID_TABS[number];

const readTabFromUrl = (): TabValue => {
  if (typeof window === "undefined") return "overview";
  const params = new URLSearchParams(window.location.search);
  const t = params.get("tab");
  return (VALID_TABS as readonly string[]).includes(t || "") ? (t as TabValue) : "overview";
};

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabValue>(() => readTabFromUrl());

  // Keep activeTab in sync when the route/search changes (e.g. navigating from
  // the observation form with ?tab=observations, or browser back/forward).
  useEffect(() => {
    setActiveTab(readTabFromUrl());
  }, [location]);

  const handleTabChange = (val: string) => {
    const next = (VALID_TABS as readonly string[]).includes(val) ? (val as TabValue) : "overview";
    setActiveTab(next);
    const params = new URLSearchParams(window.location.search);
    if (next === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", next);
    }
    const qs = params.toString();
    navigate(`/projects/${id}${qs ? `?${qs}` : ""}`, { replace: true });
  };

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

  const { data: elevations } = useQuery<Elevation[]>({
    queryKey: [`/api/projects/${id}/elevations`],
  });

  const [inspectionDialogOpen, setInspectionDialogOpen] = useState(false);
  const [groupingChoice, setGroupingChoice] = useState<string>("by_type");
  const [markingComplete, setMarkingComplete] = useState(false);

  const markInspectionComplete = async () => {
    setMarkingComplete(true);
    try {
      await apiRequest("PATCH", `/api/projects/${id}/status`, {
        inspectionStatus: "complete",
        observationGrouping: groupingChoice,
      });
      await apiRequest("POST", `/api/projects/${id}/observation-groups/rebuild`, { grouping: groupingChoice });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/observations`] });
      setInspectionDialogOpen(false);
      toast({ title: "Inspection marked complete — review groups" });
      navigate(`/projects/${id}/groups`);
    } catch (err: any) {
      toast({ title: err.message || "Failed to mark complete", variant: "destructive" });
    } finally {
      setMarkingComplete(false);
    }
  };

  const [elevationDialogOpen, setElevationDialogOpen] = useState(false);
  const [elevationFile, setElevationFile] = useState<File | null>(null);
  const [elevationName, setElevationName] = useState("");
  const [elevationType, setElevationType] = useState("elevation");
  const [elevationUploading, setElevationUploading] = useState(false);

  const uploadElevation = async () => {
    if (!elevationFile || !elevationName.trim()) {
      toast({ title: "File and name are required", variant: "destructive" });
      return;
    }
    setElevationUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", elevationFile);
      fd.append("name", elevationName.trim());
      fd.append("type", elevationType);
      const res = await fetch(`${API_BASE}/api/projects/${id}/elevations`, { method: "POST", body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Upload failed");
      }
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/elevations`] });
      setElevationDialogOpen(false);
      setElevationFile(null);
      setElevationName("");
      setElevationType("elevation");
      toast({ title: "Elevation uploaded" });
    } catch (err: any) {
      toast({ title: err.message || "Upload failed", variant: "destructive" });
    } finally {
      setElevationUploading(false);
    }
  };

  const deleteElevationMutation = useMutation({
    mutationFn: async (elevationId: number) => {
      await apiRequest("DELETE", `/api/elevations/${elevationId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/elevations`] });
      toast({ title: "Elevation deleted" });
    },
  });

  // Editable project fields
  const [editForm, setEditForm] = useState<Partial<Project>>({});
  const [inspectionDates, setInspectionDates] = useState<string[]>([]);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [backgroundDocs, setBackgroundDocs] = useState<{ title: string; author: string; date: string }[]>([]);
  const [projectElevations, setProjectElevations] = useState<string[]>([]);
  const [newElevationLabel, setNewElevationLabel] = useState("");
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [originalAiSummary, setOriginalAiSummary] = useState<string | null>(null);
  const [aiIntroLoading, setAiIntroLoading] = useState(false);

  useEffect(() => {
    if (project) {
      setEditForm(project);
      try { setInspectionDates(JSON.parse(project.inspectionDates || "[]")); } catch { setInspectionDates([]); }
      try { setLimitations(JSON.parse(project.limitations || "[]")); } catch { setLimitations([]); }
      try { setBackgroundDocs(JSON.parse(project.backgroundDocs || "[]")); } catch { setBackgroundDocs([]); }
      try {
        const elev = JSON.parse(project.projectElevations || "[]");
        setProjectElevations(elev.length > 0 ? elev : ["North", "East", "South", "West", "Roof"]);
      } catch { setProjectElevations(["North", "East", "South", "West", "Roof"]); }
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

  const saveProjectElevations = (elevs: string[]) => {
    setProjectElevations(elevs);
    autoSave({ projectElevations: JSON.stringify(elevs) } as any);
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

      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
        <div className="flex gap-2">
          {project.inspectionStatus === "complete" ? (
            <Link href={`/projects/${id}/groups`}>
              <Button variant="outline" size="sm">
                <ClipboardList className="w-4 h-4 mr-2" />
                Review Groups
              </Button>
            </Link>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInspectionDialogOpen(true)}
              disabled={!observations || observations.length === 0}
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Mark Inspection Complete
            </Button>
          )}
          <Link href={`/projects/${id}/capex`}>
            <Button variant="outline" size="sm">
              <DollarSign className="w-4 h-4 mr-2" />
              Edit CAPEX
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`${API_BASE}/api/export/word/${id}`, '_blank')}
          >
            <FileText className="w-4 h-4 mr-2" />
            Export Word
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`${API_BASE}/api/export/photos/${id}`, '_blank')}
          >
            <Download className="w-4 h-4 mr-2" />
            Download Photos
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`${API_BASE}/api/export/elevations/${id}`, '_blank')}
          >
            <Download className="w-4 h-4 mr-2" />
            Download Elevations
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {project.address}
        {project.inspectionStatus === "complete" && (
          <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800">Inspection complete</Badge>
        )}
      </p>

      {/* Mark Inspection Complete Dialog */}
      <Dialog open={inspectionDialogOpen} onOpenChange={setInspectionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Inspection Complete</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              How should the observations be grouped for the final report?
            </p>
            <div className="space-y-2">
              <label className="flex items-start gap-3 p-3 border rounded-md cursor-pointer hover:bg-accent/50">
                <input
                  type="radio"
                  name="grouping"
                  value="by_type"
                  checked={groupingChoice === "by_type"}
                  onChange={() => setGroupingChoice("by_type")}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-sm">By Type of Observation</p>
                  <p className="text-xs text-muted-foreground">Groups observations by defect category (e.g. Sealant Failure, Glazing Defect).</p>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 border rounded-md cursor-pointer hover:bg-accent/50">
                <input
                  type="radio"
                  name="grouping"
                  value="by_elevation"
                  checked={groupingChoice === "by_elevation"}
                  onChange={() => setGroupingChoice("by_elevation")}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-sm">By Elevation / Area</p>
                  <p className="text-xs text-muted-foreground">Groups by grid elevation (North, East, etc.) or location area.</p>
                </div>
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInspectionDialogOpen(false)} disabled={markingComplete}>Cancel</Button>
            <Button onClick={markInspectionComplete} disabled={markingComplete}>
              {markingComplete ? (<><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Grouping...</>) : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview" className="gap-1.5">
            <FileText className="w-4 h-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="systems" className="gap-1.5">
            <Layers className="w-4 h-4" />
            Systems
          </TabsTrigger>
          <TabsTrigger value="elevations" className="gap-1.5">
            <ImageIcon className="w-4 h-4" />
            Elevations
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

            {/* Project Context — free-form notes fed into all AI generation prompts */}
            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" />
                    Project Context (read by AI)
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Free-form notes about the building, ongoing or imminent works, client priorities, occupancy,
                    sensitivities, or anything else the AI should know when generating text. Recommendations,
                    narratives, and the executive summary will reference this context.
                  </p>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap ml-3">
                  {updateMutation.isPending ? "Saving..." : (editForm.projectContext ? "Saved" : "")}
                </span>
              </div>
              <Textarea
                value={editForm.projectContext || ""}
                onChange={e => {
                  updateField("projectContext", e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                rows={6}
                className="min-h-[140px] overflow-hidden resize-none"
                placeholder="e.g. Lobby, ground level forecourt and several roof and facade elements adjacent to the lobby are being replaced in a large upgrade due to commence in Q3. Recommendations for items in this area can reasonably be added to that scope. Building is occupied by tenants on Levels 2-12 — restrict invasive work outside business hours. Client priority: minimise temporary scaffolding."
                ref={(el) => {
                  if (el && el.scrollHeight > el.clientHeight) {
                    el.style.height = el.scrollHeight + "px";
                  }
                }}
              />
            </Card>

            {/* AI-Generated Introduction — polished Background/Introduction
                section, used in the Word export's section 2.1. */}
            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" />
                    AI-Generated Introduction (Background)
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    AFC-style rewrite of your Project Context above, for use as the
                    Background and Introduction in the Word export. Regenerate after
                    editing your notes. If empty, the export falls back to the raw
                    Project Context.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={aiIntroLoading}
                  onClick={async () => {
                    setAiIntroLoading(true);
                    try {
                      const res = await aiRequest("/api/ai/generate-introduction", { projectId: Number(id) });
                      const data = await res.json();
                      updateField("aiIntroduction", data.introduction);
                      toast({ title: "Introduction generated — review and edit" });
                    } catch (err: any) {
                      toast({ title: err.message || "Introduction generation failed", variant: "destructive" });
                    } finally {
                      setAiIntroLoading(false);
                    }
                  }}
                >
                  {aiIntroLoading ? (
                    <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating...</>
                  ) : (
                    <><Sparkles className="w-4 h-4 mr-1" /> {(editForm as any).aiIntroduction ? "Regenerate" : "Generate Introduction"}</>
                  )}
                </Button>
              </div>
              <Textarea
                value={(editForm as any).aiIntroduction || ""}
                onChange={e => updateField("aiIntroduction", e.target.value)}
                rows={8}
                placeholder="Click 'Generate Introduction' to have AI rewrite your Project Context above into a polished AFC-style Background/Introduction section."
              />
            </Card>

            {/* Building Elevations */}
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-medium">Building Elevations</h3>
              <p className="text-xs text-muted-foreground">Define which elevations/areas apply to this building. These appear in observation forms.</p>
              <div className="flex flex-wrap gap-2">
                {projectElevations.map((elev, idx) => (
                  <div key={idx} className="flex items-center gap-1 bg-accent/40 border rounded-full pl-3 pr-1 py-1 text-sm">
                    <span>{elev}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 rounded-full hover:bg-destructive/20"
                      onClick={() => saveProjectElevations(projectElevations.filter((_, i) => i !== idx))}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={newElevationLabel}
                  onChange={e => setNewElevationLabel(e.target.value)}
                  placeholder="e.g. Northeast, Podium, Area 1..."
                  className="max-w-[250px]"
                  onKeyDown={e => {
                    if (e.key === "Enter" && newElevationLabel.trim()) {
                      e.preventDefault();
                      if (!projectElevations.includes(newElevationLabel.trim())) {
                        saveProjectElevations([...projectElevations, newElevationLabel.trim()]);
                      }
                      setNewElevationLabel("");
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!newElevationLabel.trim()}
                  onClick={() => {
                    if (newElevationLabel.trim() && !projectElevations.includes(newElevationLabel.trim())) {
                      saveProjectElevations([...projectElevations, newElevationLabel.trim()]);
                    }
                    setNewElevationLabel("");
                  }}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add
                </Button>
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

            {/* Roof Plan */}
            {project && <RoofPlanMarkup project={project} />}
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

        {/* === ELEVATIONS TAB === */}
        <TabsContent value="elevations">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium">Elevation Drawings</h2>
            <Button onClick={() => setElevationDialogOpen(true)}>
              <Upload className="w-4 h-4 mr-2" />
              Upload Elevation
            </Button>
          </div>

          {!elevations?.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ImageIcon className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No elevation drawings uploaded yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Upload elevations or roof plans (JPG, PNG, PDF) to mark observation locations.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {elevations.map((elev) => {
                const pinCount = (observations || []).filter(o => o.elevationId === elev.id).length;
                return (
                  <Card key={elev.id} className="group relative overflow-hidden">
                    <Link href={`/projects/${id}/elevations/${elev.id}`}>
                      <div className="cursor-pointer">
                        <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                          <img
                            src={`${API_BASE}/api/elevations/${elev.id}/image`}
                            alt={elev.name}
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <div className="p-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium truncate">{elev.name}</p>
                            <Badge variant="secondary" className="text-xs shrink-0">
                              {elev.type === "roof_plan" ? "Roof Plan" : "Elevation"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {pinCount} pin{pinCount === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                    </Link>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (confirm("Delete this elevation and all its pins?")) {
                          deleteElevationMutation.mutate(elev.id);
                        }
                      }}
                      className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Card>
                );
              })}
            </div>
          )}

          <Dialog open={elevationDialogOpen} onOpenChange={setElevationDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Upload Elevation</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Name</Label>
                  <Input
                    placeholder="e.g. North Elevation, Roof Plan"
                    value={elevationName}
                    onChange={(e) => setElevationName(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={elevationType} onValueChange={setElevationType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="elevation">Elevation</SelectItem>
                      <SelectItem value="roof_plan">Roof Plan</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>File</Label>
                  <Input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.pdf"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      setElevationFile(f);
                      if (f && !elevationName) {
                        setElevationName(f.name.replace(/\.[^.]+$/, ""));
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground mt-1">Accepted: JPG, PNG, WebP, PDF (first page)</p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setElevationDialogOpen(false)} disabled={elevationUploading}>
                  Cancel
                </Button>
                <Button onClick={uploadElevation} disabled={elevationUploading || !elevationFile || !elevationName.trim()}>
                  {elevationUploading ? (
                    <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Uploading...</>
                  ) : (
                    "Upload"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium">Capital Expenditure Summary</h2>
            <Link href={`/projects/${id}/capex`}>
              <Button size="sm" variant="outline">
                <DollarSign className="w-4 h-4 mr-2" />
                Open editable schedule
              </Button>
            </Link>
          </div>
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
