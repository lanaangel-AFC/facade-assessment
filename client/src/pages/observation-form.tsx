import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { DictationButton } from "@/components/DictationButton";
import {
  ArrowLeft, Camera, Upload, X, ImageIcon, Save, Plus, Trash2, ChevronDown, ChevronUp, Sparkles, Loader2,
} from "lucide-react";
import type { FacadeSystem, Observation, Photo, Recommendation, Elevation, ElevationPin } from "@shared/schema";
import { useState, useRef, useEffect, useCallback } from "react";

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

const DEFECT_CATEGORIES = [
  "Gasket failure",
  "Sealant failure",
  "Corrosion",
  "Concrete spalling/cracking",
  "Membrane degradation",
  "Glass breakage/cracking",
  "Water ingress",
  "Safety/compliance",
  "Fixing/anchor failure",
  "Coating/paint failure",
  "Drainage deficiency",
  "Structural movement",
  "Biological growth",
  "Efflorescence",
  "Missing components",
  "Design deficiency",
  "Installation deficiency",
  "Other",
];

const SEVERITIES = ["Safety/Risk", "Essential", "Desirable", "Monitor"];
const EXTENTS = ["Isolated", "Localised", "Widespread", "Systemic"];

const INDICATORS = [
  "Water staining",
  "Corrosion products",
  "Displacement/movement",
  "Cracking",
  "Delamination",
  "Biological growth",
  "Efflorescence",
  "Ponding water",
  "Air leaks",
  "Debris accumulation",
  "Surface chalking",
  "Loss of adhesion",
  "Compression set",
  "Discolouration",
  "Missing material",
];

const PHOTO_SLOTS = [
  { key: "photo1", label: "Photo 1" },
  { key: "photo2", label: "Photo 2" },
  { key: "photo3", label: "Photo 3" },
  { key: "photo4", label: "Photo 4" },
  { key: "photo5", label: "Photo 5" },
  { key: "photo6", label: "Photo 6" },
] as const;

type SlotKey = typeof PHOTO_SLOTS[number]["key"];

const TIMEFRAMES = ["Now", "1 year", "2 years", "5 years", "Prior to leasing"];
const REC_CATEGORIES = ["Essential", "Desirable", "Monitor"];

export default function ObservationForm() {
  const { projectId, observationId: obsIdParam } = useParams<{ projectId: string; observationId?: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const isEdit = !!obsIdParam;

  const [form, setForm] = useState({
    systemId: "",
    observationId: "",
    location: "",
    defectCategory: "",
    severity: "",
    extent: "",
    fieldNote: "",
    aiNarrative: "",
  });

  const [indicators, setIndicators] = useState<string[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [aiNarrativeLoading, setAiNarrativeLoading] = useState(false);
  const [aiRecLoading, setAiRecLoading] = useState(false);
  const [originalAiNarrative, setOriginalAiNarrative] = useState<string | null>(null);

  // Recommendations state
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [showRecForm, setShowRecForm] = useState(false);
  const [recForm, setRecForm] = useState({
    action: "",
    timeframe: "",
    category: "",
    budgetEstimate: "",
    budgetBasis: "",
  });
  const [editingRecId, setEditingRecId] = useState<number | null>(null);

  // Fetch systems for this project
  const { data: systems } = useQuery<FacadeSystem[]>({
    queryKey: [`/api/projects/${projectId}/systems`],
  });

  // Elevations and existing pin
  const { data: elevations } = useQuery<Elevation[]>({
    queryKey: [`/api/projects/${projectId}/elevations`],
  });
  const { data: existingPin } = useQuery<ElevationPin | { pin: null }>({
    queryKey: [`/api/observations/${obsIdParam}/pin`],
    enabled: isEdit,
  });
  const [selectedElevationId, setSelectedElevationId] = useState<string>("");
  const [pinPos, setPinPos] = useState<{ x: number; y: number } | null>(null);
  const miniPreviewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (existingPin && "id" in existingPin) {
      setSelectedElevationId(String(existingPin.elevationId));
      setPinPos({ x: existingPin.x, y: existingPin.y });
    }
  }, [existingPin]);

  const savePin = async (elevationIdNum: number, x: number, y: number) => {
    if (!obsIdParam) return;
    try {
      await apiRequest("PUT", `/api/observations/${obsIdParam}/pin`, {
        elevationId: elevationIdNum, x, y,
      });
      queryClient.invalidateQueries({ queryKey: [`/api/observations/${obsIdParam}/pin`] });
      queryClient.invalidateQueries({ queryKey: [`/api/elevations/${elevationIdNum}/pins`] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/observations`] });
    } catch (err: any) {
      toast({ title: err.message || "Failed to save pin", variant: "destructive" });
    }
  };

  const removePin = async () => {
    if (!obsIdParam) return;
    try {
      await apiRequest("DELETE", `/api/observations/${obsIdParam}/pin`);
      setPinPos(null);
      setSelectedElevationId("");
      queryClient.invalidateQueries({ queryKey: [`/api/observations/${obsIdParam}/pin`] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/observations`] });
    } catch (err: any) {
      toast({ title: err.message || "Failed to remove pin", variant: "destructive" });
    }
  };

  const onPreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedElevationId || !miniPreviewRef.current) return;
    const rect = miniPreviewRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 10000);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 10000);
    setPinPos({ x, y });
    savePin(Number(selectedElevationId), x, y);
  };

  // Fetch existing observation if editing
  const { data: existingObs } = useQuery<Observation>({
    queryKey: ["/api/observations", obsIdParam],
    enabled: isEdit,
  });

  // Fetch photos for existing observation
  const { data: existingPhotos } = useQuery<Photo[]>({
    queryKey: [`/api/observations/${obsIdParam}/photos`],
    enabled: isEdit,
  });

  // Fetch recommendations for existing observation
  const { data: existingRecs } = useQuery<Recommendation[]>({
    queryKey: [`/api/observations/${obsIdParam}/recommendations`],
    enabled: isEdit,
  });

  // Fetch next observation ID when system changes (new only)
  const selectedSystemId = form.systemId ? Number(form.systemId) : null;
  const { data: nextIdData } = useQuery<{ observationId: string }>({
    queryKey: [`/api/projects/${projectId}/next-observation-id`, selectedSystemId],
    queryFn: async () => {
      if (!selectedSystemId) return { observationId: "" };
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/next-observation-id?systemId=${selectedSystemId}`);
      if (!res.ok) throw new Error("Failed to fetch next ID");
      return res.json();
    },
    enabled: !isEdit && !!selectedSystemId,
  });

  useEffect(() => {
    if (nextIdData?.observationId && !isEdit) {
      setForm(prev => ({ ...prev, observationId: nextIdData.observationId }));
    }
  }, [nextIdData, isEdit]);

  useEffect(() => {
    if (existingObs) {
      setForm({
        systemId: existingObs.systemId ? String(existingObs.systemId) : "",
        observationId: existingObs.observationId,
        location: existingObs.location,
        defectCategory: existingObs.defectCategory,
        severity: existingObs.severity,
        extent: existingObs.extent,
        fieldNote: existingObs.fieldNote || "",
        aiNarrative: existingObs.aiNarrative || "",
      });
      try { setIndicators(JSON.parse(existingObs.indicators || "[]")); } catch { setIndicators([]); }
    }
  }, [existingObs]);

  useEffect(() => {
    if (existingPhotos) setPhotos(existingPhotos);
  }, [existingPhotos]);

  useEffect(() => {
    if (existingRecs) setRecs(existingRecs);
  }, [existingRecs]);

  const getPhotoForSlot = (slot: SlotKey): Photo | undefined => {
    return photos.find((p) => p.slot === slot);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        systemId: form.systemId ? Number(form.systemId) : null,
        indicators: JSON.stringify(indicators),
        createdAt: new Date().toISOString(),
      };
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/observations/${obsIdParam}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", `/api/projects/${projectId}/observations`, payload);
        return res.json();
      }
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/observations`] });
      toast({ title: isEdit ? "Observation updated" : "Observation created" });
      
      // Save training data if AI narrative was used
      if (originalAiNarrative) {
        try {
          await aiRequest("/api/ai/training-data", {
            taskType: "observation_narrative",
            inputData: JSON.stringify({ observationId: obsIdParam, defectCategory: form.defectCategory, severity: form.severity }),
            aiOutput: originalAiNarrative,
            userCorrected: form.aiNarrative !== originalAiNarrative ? form.aiNarrative : "",
            accepted: form.aiNarrative === originalAiNarrative,
          });
        } catch {}
        setOriginalAiNarrative(null);
      }
      
      if (!isEdit) {
        navigate(`/projects/${projectId}/observations/${data.id}`, { replace: true });
      }
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to save", variant: "destructive" });
    },
  });

  const handlePhotoUpload = async (file: File, slot: SlotKey) => {
    if (!obsIdParam) {
      toast({ title: "Save the observation first before adding photos", variant: "destructive" });
      return;
    }
    setUploading(slot);
    try {
      const formData = new FormData();
      formData.append("photo", file);
      formData.append("slot", slot);

      const res = await fetch(`${API_BASE}/api/observations/${obsIdParam}/photos`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error("Upload failed");
      const photo = await res.json();
      setPhotos((prev) => {
        const filtered = prev.filter((p) => p.slot !== slot);
        return [...filtered, photo];
      });
      queryClient.invalidateQueries({ queryKey: [`/api/observations/${obsIdParam}/photos`] });
      toast({ title: `Photo added` });
    } catch {
      toast({ title: "Failed to upload photo", variant: "destructive" });
    } finally {
      setUploading(null);
    }
  };

  const handleDeletePhoto = async (photoId: number) => {
    try {
      await apiRequest("DELETE", `/api/photos/${photoId}`);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      queryClient.invalidateQueries({ queryKey: [`/api/observations/${obsIdParam}/photos`] });
      toast({ title: "Photo removed" });
    } catch {
      toast({ title: "Failed to remove photo", variant: "destructive" });
    }
  };

  // Recommendation handlers
  const saveRecMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...recForm,
        projectId: Number(projectId),
        createdAt: new Date().toISOString(),
      };
      if (editingRecId) {
        const res = await apiRequest("PATCH", `/api/recommendations/${editingRecId}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", `/api/observations/${obsIdParam}/recommendations`, payload);
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/observations/${obsIdParam}/recommendations`] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/recommendations`] });
      setShowRecForm(false);
      setEditingRecId(null);
      setRecForm({ action: "", timeframe: "", category: "", budgetEstimate: "", budgetBasis: "" });
      toast({ title: editingRecId ? "Recommendation updated" : "Recommendation added" });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to save recommendation", variant: "destructive" });
    },
  });

  const deleteRecMutation = useMutation({
    mutationFn: async (recId: number) => {
      await apiRequest("DELETE", `/api/recommendations/${recId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/observations/${obsIdParam}/recommendations`] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/recommendations`] });
      toast({ title: "Recommendation deleted" });
    },
  });

  const startEditRec = (rec: Recommendation) => {
    setEditingRecId(rec.id);
    setRecForm({
      action: rec.action,
      timeframe: rec.timeframe,
      category: rec.category,
      budgetEstimate: rec.budgetEstimate || "",
      budgetBasis: rec.budgetBasis || "",
    });
    setShowRecForm(true);
  };

  const toggleIndicator = (indicator: string) => {
    setIndicators(prev =>
      prev.includes(indicator)
        ? prev.filter(i => i !== indicator)
        : [...prev, indicator]
    );
  };

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-24">
      <Link href={`/projects/${projectId}`}>
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />
          Back to Project
        </button>
      </Link>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold tracking-tight">
          {isEdit ? "Edit Observation" : "New Observation"}
        </h1>
        {form.observationId && (
          <span className="font-mono text-sm font-semibold text-primary">{form.observationId}</span>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveMutation.mutate();
        }}
        className="space-y-6"
      >
        {/* System Selector */}
        <div>
          <Label>Linked System</Label>
          <Select
            value={form.systemId}
            onValueChange={(val) => setForm({ ...form, systemId: val })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a facade system" />
            </SelectTrigger>
            <SelectContent>
              {(systems || []).map((sys) => (
                <SelectItem key={sys.id} value={String(sys.id)}>
                  {sys.name} — {sys.location}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Observation ID (auto-generated) */}
        <Card className="p-4 bg-accent/30">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">Observation ID</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Auto-generated from system section number</p>
            </div>
            <span className="font-mono text-sm font-semibold text-primary">
              {form.observationId || "Select a system first"}
            </span>
          </div>
        </Card>

        {/* Location */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Label htmlFor="location">Location Detail</Label>
            <DictationButton
              onTranscript={(text) => setForm(prev => ({ ...prev, location: prev.location + (prev.location ? " " : "") + text }))}
            />
          </div>
          <Input
            id="location"
            placeholder="e.g. Level 5, northwest corner"
            value={form.location}
            onChange={set("location")}
            required
          />
        </div>

        {/* Location on Elevation */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Location on Elevation</h3>
            {pinPos && selectedElevationId && (
              <Button type="button" variant="outline" size="sm" onClick={removePin}>
                <X className="w-3.5 h-3.5 mr-1" />
                Remove Pin
              </Button>
            )}
          </div>
          {!isEdit ? (
            <p className="text-xs text-muted-foreground">Save the observation first to place it on an elevation.</p>
          ) : !elevations || elevations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No elevation drawings uploaded yet.{" "}
              <Link href={`/projects/${projectId}`}>
                <span className="text-primary underline">Upload an elevation</span>
              </Link>{" "}
              to mark locations.
            </p>
          ) : (
            <>
              <div>
                <Label>Elevation</Label>
                <Select
                  value={selectedElevationId}
                  onValueChange={(val) => {
                    setSelectedElevationId(val);
                    // If already had a pin, move it to this elevation at existing position
                    if (pinPos) savePin(Number(val), pinPos.x, pinPos.y);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an elevation drawing" />
                  </SelectTrigger>
                  <SelectContent>
                    {elevations.map((e) => (
                      <SelectItem key={e.id} value={String(e.id)}>
                        {e.name} ({e.type === "roof_plan" ? "Roof Plan" : "Elevation"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedElevationId && (
                <div
                  ref={miniPreviewRef}
                  className="relative w-full bg-muted/30 border rounded-md overflow-hidden cursor-crosshair"
                  style={{ aspectRatio: "16 / 9" }}
                  onClick={onPreviewClick}
                >
                  <img
                    src={`${API_BASE}/api/elevations/${selectedElevationId}/image`}
                    alt="Elevation preview"
                    className="w-full h-full object-contain pointer-events-none"
                    draggable={false}
                  />
                  {pinPos && (
                    <div
                      className="absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 border-2 border-white shadow-md pointer-events-none flex items-center justify-center"
                      style={{ left: `${pinPos.x / 100}%`, top: `${pinPos.y / 100}%` }}
                    >
                      <div className="w-1.5 h-1.5 rounded-full bg-white" />
                    </div>
                  )}
                </div>
              )}
              {selectedElevationId && (
                <p className="text-xs text-muted-foreground">
                  {pinPos ? "Tap the preview to move the pin." : "Tap the preview to drop a pin at the observation location."}
                </p>
              )}
            </>
          )}
        </Card>

        {/* Defect Category */}
        <div>
          <Label>Defect Category</Label>
          <Select value={form.defectCategory} onValueChange={(val) => setForm({ ...form, defectCategory: val })}>
            <SelectTrigger>
              <SelectValue placeholder="Select defect category" />
            </SelectTrigger>
            <SelectContent>
              {DEFECT_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Severity & Extent */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Severity</Label>
            <Select value={form.severity} onValueChange={(val) => setForm({ ...form, severity: val })}>
              <SelectTrigger>
                <SelectValue placeholder="Select severity" />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Extent</Label>
            <Select value={form.extent} onValueChange={(val) => setForm({ ...form, extent: val })}>
              <SelectTrigger>
                <SelectValue placeholder="Select extent" />
              </SelectTrigger>
              <SelectContent>
                {EXTENTS.map((e) => (
                  <SelectItem key={e} value={e}>{e}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Field Note */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Label htmlFor="fieldNote">Field Note</Label>
            <DictationButton
              onTranscript={(text) => setForm(prev => ({ ...prev, fieldNote: prev.fieldNote + (prev.fieldNote ? " " : "") + text }))}
            />
          </div>
          <Textarea
            id="fieldNote"
            placeholder="Brief description of what was observed..."
            value={form.fieldNote}
            onChange={set("fieldNote")}
            rows={3}
          />
        </div>

        {/* Indicators */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-medium">Indicators Observed</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {INDICATORS.map((indicator) => (
              <label key={indicator} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={indicators.includes(indicator)}
                  onCheckedChange={() => toggleIndicator(indicator)}
                />
                {indicator}
              </label>
            ))}
          </div>
        </Card>

        {/* Photos */}
        <Card className="p-4 space-y-4">
          <h3 className="text-sm font-medium">Photos (up to 6)</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {PHOTO_SLOTS.map((slot) => {
              const photo = getPhotoForSlot(slot.key);
              return (
                <div key={slot.key} className="space-y-1">
                  <Label className="text-xs">{slot.label}</Label>
                  {photo ? (
                    <div className="relative group">
                      <img
                        src={`${API_BASE}/api/uploads/${photo.filename}`}
                        alt={slot.label}
                        className="w-full h-24 object-cover rounded-lg border"
                      />
                      <button
                        type="button"
                        onClick={() => handleDeletePhoto(photo.id)}
                        className="absolute top-1 right-1 p-1 rounded-full bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <div className="h-24 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1 text-muted-foreground">
                      <ImageIcon className="w-6 h-6 opacity-40" />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => cameraInputRefs.current[slot.key]?.click()}
                          className="p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          disabled={!isEdit || uploading === slot.key}
                        >
                          <Camera className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputRefs.current[slot.key]?.click()}
                          className="p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          disabled={!isEdit || uploading === slot.key}
                        >
                          <Upload className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    ref={(el) => { cameraInputRefs.current[slot.key] = el; }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handlePhotoUpload(file, slot.key);
                      e.target.value = "";
                    }}
                  />
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    ref={(el) => { fileInputRefs.current[slot.key] = el; }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handlePhotoUpload(file, slot.key);
                      e.target.value = "";
                    }}
                  />
                </div>
              );
            })}
          </div>
          {!isEdit && <p className="text-xs text-muted-foreground">Save the observation first to add photos</p>}
        </Card>

        {/* AI Narrative */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label htmlFor="aiNarrative">Observation Narrative</Label>
            {isEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={aiNarrativeLoading}
                onClick={async () => {
                  setAiNarrativeLoading(true);
                  try {
                    const res = await aiRequest("/api/ai/generate-observation-narrative", { observationId: Number(obsIdParam) });
                    const data = await res.json();
                    setForm(prev => ({ ...prev, aiNarrative: data.narrative }));
                    setOriginalAiNarrative(data.narrative);
                    toast({ title: "Narrative generated — review and edit as needed" });
                  } catch (err: any) {
                    toast({ title: err.message || "Narrative generation failed", variant: "destructive" });
                  } finally {
                    setAiNarrativeLoading(false);
                  }
                }}
              >
                {aiNarrativeLoading ? (
                  <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="w-4 h-4 mr-1" /> Generate Narrative</>
                )}
              </Button>
            )}
          </div>
          <Textarea
            id="aiNarrative"
            placeholder={isEdit ? "Click 'Generate Narrative' to create AI-generated text" : "Save the observation first, then generate a narrative"}
            value={form.aiNarrative}
            onChange={set("aiNarrative")}
            rows={6}
          />
        </div>

        {/* Save button */}
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t z-10">
          <div className="max-w-2xl mx-auto">
            <Button type="submit" className="w-full" disabled={saveMutation.isPending}>
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? "Saving..." : isEdit ? "Update Observation" : "Create Observation"}
            </Button>
          </div>
        </div>
      </form>

      {/* Recommendations Section (only visible when editing) */}
      {isEdit && (
        <div className="mt-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Recommendations</h2>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={aiRecLoading}
                onClick={async () => {
                  setAiRecLoading(true);
                  try {
                    const res = await aiRequest("/api/ai/generate-recommendation", { observationId: Number(obsIdParam) });
                    const data = await res.json();
                    setEditingRecId(null);
                    setRecForm({
                      action: data.action || "",
                      timeframe: data.timeframe || "",
                      category: data.category || "",
                      budgetEstimate: data.budgetEstimate || "",
                      budgetBasis: data.budgetBasis || "",
                    });
                    setShowRecForm(true);
                    toast({ title: "Recommendation generated — review and save" });
                  } catch (err: any) {
                    toast({ title: err.message || "Recommendation generation failed", variant: "destructive" });
                  } finally {
                    setAiRecLoading(false);
                  }
                }}
              >
                {aiRecLoading ? (
                  <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="w-4 h-4 mr-1" /> AI Suggest</>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingRecId(null);
                  setRecForm({ action: "", timeframe: "", category: "", budgetEstimate: "", budgetBasis: "" });
                  setShowRecForm(!showRecForm);
                }}
              >
                {showRecForm && !editingRecId ? (
                  <><ChevronUp className="w-4 h-4 mr-1" /> Cancel</>
                ) : (
                  <><Plus className="w-4 h-4 mr-1" /> Add Recommendation</>
                )}
              </Button>
            </div>
          </div>

          {/* Existing recommendations */}
          {recs.length > 0 && (
            <div className="space-y-2">
              {recs.map((rec) => (
                <Card key={rec.id} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{rec.action}</p>
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        <span className="text-xs px-2 py-0.5 bg-muted rounded-full">{rec.timeframe}</span>
                        <span className="text-xs px-2 py-0.5 bg-muted rounded-full">{rec.category}</span>
                        {rec.budgetEstimate && (
                          <span className="text-xs px-2 py-0.5 bg-muted rounded-full font-medium">{rec.budgetEstimate}</span>
                        )}
                      </div>
                      {rec.budgetBasis && (
                        <p className="text-xs text-muted-foreground mt-1">{rec.budgetBasis}</p>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button type="button" variant="ghost" size="sm" onClick={() => startEditRec(rec)}>
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => {
                          if (confirm("Delete this recommendation?")) {
                            deleteRecMutation.mutate(rec.id);
                          }
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Add/Edit recommendation form */}
          {showRecForm && (
            <Card className="p-4 space-y-4 border-primary/30">
              <h3 className="text-sm font-medium">{editingRecId ? "Edit Recommendation" : "New Recommendation"}</h3>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Label htmlFor="recAction">Action</Label>
                  <DictationButton
                    onTranscript={(text) => setRecForm(prev => ({ ...prev, action: prev.action + (prev.action ? " " : "") + text }))}
                  />
                </div>
                <Textarea
                  id="recAction"
                  placeholder="Describe the recommended action..."
                  value={recForm.action}
                  onChange={e => setRecForm({ ...recForm, action: e.target.value })}
                  rows={2}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Timeframe</Label>
                  <Select value={recForm.timeframe} onValueChange={(val) => setRecForm({ ...recForm, timeframe: val })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select timeframe" />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEFRAMES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Category</Label>
                  <Select value={recForm.category} onValueChange={(val) => setRecForm({ ...recForm, category: val })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {REC_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="budgetEstimate">Budget Estimate</Label>
                  <Input
                    id="budgetEstimate"
                    placeholder="e.g. $50,000"
                    value={recForm.budgetEstimate}
                    onChange={e => setRecForm({ ...recForm, budgetEstimate: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="budgetBasis">Budget Basis</Label>
                  <Input
                    id="budgetBasis"
                    placeholder="e.g. $80-$120 per lineal m"
                    value={recForm.budgetBasis}
                    onChange={e => setRecForm({ ...recForm, budgetBasis: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={() => saveRecMutation.mutate()}
                  disabled={saveRecMutation.isPending || !recForm.action || !recForm.timeframe || !recForm.category}
                >
                  {saveRecMutation.isPending ? "Saving..." : editingRecId ? "Update" : "Add Recommendation"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowRecForm(false);
                    setEditingRecId(null);
                    setRecForm({ action: "", timeframe: "", category: "", budgetEstimate: "", budgetBasis: "" });
                  }}
                >
                  Cancel
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
