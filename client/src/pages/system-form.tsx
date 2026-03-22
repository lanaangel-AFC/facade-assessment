import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Camera, Upload, X, ImageIcon, Save, Plus, Trash2, Sparkles, Loader2 } from "lucide-react";
import type { FacadeSystem, Photo } from "@shared/schema";
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

const SYSTEM_TYPES = [
  "Curtain wall - stick system",
  "Curtain wall - unitised",
  "Concrete wall",
  "Render/plaster",
  "Cladding - metal",
  "Cladding - composite",
  "Cladding - fibre cement",
  "Masonry/brick",
  "Glazed shopfront",
  "Roof membrane",
  "Roof metal deck",
  "Balustrade/handrail",
  "Waterproofing membrane",
  "Stone/tile cladding",
  "Louvre system",
  "Other",
];

const PHOTO_SLOTS = [
  { key: "context1", label: "Context 1" },
  { key: "context2", label: "Context 2" },
  { key: "context3", label: "Context 3" },
  { key: "context4", label: "Context 4" },
] as const;

type SlotKey = typeof PHOTO_SLOTS[number]["key"];

export default function SystemForm() {
  const { projectId, systemId } = useParams<{ projectId: string; systemId?: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const isEdit = !!systemId;

  const [form, setForm] = useState({
    name: "",
    location: "",
    systemType: "",
    estimatedAge: "",
    relatedSystems: "",
    aiDescription: "",
  });

  const [materials, setMaterials] = useState<{ name: string; detail: string }[]>([]);
  const [keyFeatures, setKeyFeatures] = useState<string[]>([]);
  const [featureInput, setFeatureInput] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [aiIdentifying, setAiIdentifying] = useState(false);
  const [aiDescribing, setAiDescribing] = useState(false);
  const [originalAiDescription, setOriginalAiDescription] = useState<string | null>(null);
  const [originalAiIdentification, setOriginalAiIdentification] = useState<string | null>(null);

  // Fetch existing system if editing
  const { data: existingSystem } = useQuery<FacadeSystem>({
    queryKey: ["/api/systems", systemId],
    enabled: isEdit,
  });

  // Fetch photos for existing system
  const { data: existingPhotos } = useQuery<Photo[]>({
    queryKey: [`/api/systems/${systemId}/photos`],
    enabled: isEdit,
  });

  useEffect(() => {
    if (existingSystem) {
      setForm({
        name: existingSystem.name,
        location: existingSystem.location,
        systemType: existingSystem.systemType,
        estimatedAge: existingSystem.estimatedAge || "",
        relatedSystems: existingSystem.relatedSystems || "",
        aiDescription: existingSystem.aiDescription || "",
      });
      try { setMaterials(JSON.parse(existingSystem.materials || "[]")); } catch { setMaterials([]); }
      try { setKeyFeatures(JSON.parse(existingSystem.keyFeatures || "[]")); } catch { setKeyFeatures([]); }
    }
  }, [existingSystem]);

  useEffect(() => {
    if (existingPhotos) setPhotos(existingPhotos);
  }, [existingPhotos]);

  const getPhotoForSlot = (slot: SlotKey): Photo | undefined => {
    return photos.find((p) => p.slot === slot);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        materials: JSON.stringify(materials),
        keyFeatures: JSON.stringify(keyFeatures),
        createdAt: new Date().toISOString(),
      };
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/systems/${systemId}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", `/api/projects/${projectId}/systems`, payload);
        return res.json();
      }
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/systems`] });
      toast({ title: isEdit ? "System updated" : "System created" });
      
      // Save training data if AI was used
      if (originalAiDescription) {
        try {
          await aiRequest("/api/ai/training-data", {
            taskType: "system_description",
            inputData: JSON.stringify({ systemId, name: form.name, systemType: form.systemType }),
            aiOutput: originalAiDescription,
            userCorrected: form.aiDescription !== originalAiDescription ? form.aiDescription : "",
            accepted: form.aiDescription === originalAiDescription,
          });
        } catch {} // Don't fail the save if training data fails
        setOriginalAiDescription(null);
      }
      if (originalAiIdentification) {
        try {
          await aiRequest("/api/ai/training-data", {
            taskType: "system_photo_id",
            inputData: JSON.stringify({ systemId, photoCount: photos.length }),
            aiOutput: originalAiIdentification,
            userCorrected: JSON.stringify({ systemType: form.systemType, materials, keyFeatures, estimatedAge: form.estimatedAge }),
            accepted: false, // Always save corrected version for identification
          });
        } catch {}
        setOriginalAiIdentification(null);
      }
      
      if (!isEdit) {
        navigate(`/projects/${projectId}/systems/${data.id}`, { replace: true });
      }
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to save", variant: "destructive" });
    },
  });

  const handlePhotoUpload = async (file: File, slot: SlotKey) => {
    if (!systemId) {
      toast({ title: "Save the system first before adding photos", variant: "destructive" });
      return;
    }
    setUploading(slot);
    try {
      const formData = new FormData();
      formData.append("photo", file);
      formData.append("slot", slot);

      const res = await fetch(`${API_BASE}/api/systems/${systemId}/photos`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error("Upload failed");
      const photo = await res.json();
      setPhotos((prev) => {
        const filtered = prev.filter((p) => p.slot !== slot);
        return [...filtered, photo];
      });
      queryClient.invalidateQueries({ queryKey: [`/api/systems/${systemId}/photos`] });
      toast({ title: `Photo added to ${slot}` });
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
      queryClient.invalidateQueries({ queryKey: [`/api/systems/${systemId}/photos`] });
      toast({ title: "Photo removed" });
    } catch {
      toast({ title: "Failed to remove photo", variant: "destructive" });
    }
  };

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const addFeature = () => {
    const trimmed = featureInput.trim();
    if (trimmed && !keyFeatures.includes(trimmed)) {
      setKeyFeatures([...keyFeatures, trimmed]);
      setFeatureInput("");
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-24">
      <Link href={`/projects/${projectId}`}>
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />
          Back to Project
        </button>
      </Link>

      <h1 className="text-xl font-semibold tracking-tight mb-6">
        {isEdit ? "Edit System" : "New Facade System"}
      </h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveMutation.mutate();
        }}
        className="space-y-6"
      >
        {/* Basic Fields */}
        <div>
          <Label htmlFor="name">System Name</Label>
          <Input
            id="name"
            placeholder="e.g. Tower curtain wall"
            value={form.name}
            onChange={set("name")}
            required
          />
        </div>

        <div>
          <Label htmlFor="location">Location</Label>
          <Input
            id="location"
            placeholder="e.g. Northwest elevation, Levels 2-17"
            value={form.location}
            onChange={set("location")}
            required
          />
        </div>

        <div>
          <Label htmlFor="systemType">System Type</Label>
          <Select value={form.systemType} onValueChange={(val) => setForm({ ...form, systemType: val })}>
            <SelectTrigger>
              <SelectValue placeholder="Select system type" />
            </SelectTrigger>
            <SelectContent>
              {SYSTEM_TYPES.map((st) => (
                <SelectItem key={st} value={st}>{st}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Materials */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-medium">Materials</h3>
          {materials.map((mat, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                placeholder="Material name (e.g. Framing)"
                value={mat.name}
                onChange={e => {
                  const updated = [...materials];
                  updated[idx] = { ...updated[idx], name: e.target.value };
                  setMaterials(updated);
                }}
              />
              <Input
                placeholder="Detail (e.g. Bronze anodised aluminium)"
                value={mat.detail}
                onChange={e => {
                  const updated = [...materials];
                  updated[idx] = { ...updated[idx], detail: e.target.value };
                  setMaterials(updated);
                }}
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => {
                setMaterials(materials.filter((_, i) => i !== idx));
              }}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMaterials([...materials, { name: "", detail: "" }])}
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Material
          </Button>
        </Card>

        {/* Key Features */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-medium">Key Features</h3>
          <div className="flex flex-wrap gap-2">
            {keyFeatures.map((feat, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                {feat}
                <button type="button" onClick={() => setKeyFeatures(keyFeatures.filter((_, i) => i !== idx))}>
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Add a feature (e.g. butt-jointed corners)"
              value={featureInput}
              onChange={e => setFeatureInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addFeature();
                }
              }}
            />
            <Button type="button" variant="outline" size="sm" onClick={addFeature}>
              Add
            </Button>
          </div>
        </Card>

        <div>
          <Label htmlFor="estimatedAge">Estimated Age</Label>
          <Input
            id="estimatedAge"
            placeholder="e.g. ~25 years (c.2000)"
            value={form.estimatedAge}
            onChange={set("estimatedAge")}
          />
        </div>

        <div>
          <Label htmlFor="relatedSystems">Related Systems</Label>
          <Input
            id="relatedSystems"
            placeholder="e.g. Shares framing with System 2"
            value={form.relatedSystems}
            onChange={set("relatedSystems")}
          />
        </div>

        {/* Context Photos */}
        <Card className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Context Photos (up to 4)</h3>
            {isEdit && photos.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={aiIdentifying}
                onClick={async () => {
                  setAiIdentifying(true);
                  try {
                    const photoIds = photos.map(p => p.id);
                    const res = await aiRequest("/api/ai/identify-system", { photoIds });
                    const data = await res.json();
                    
                    // Populate form fields with AI results
                    setForm(prev => ({
                      ...prev,
                      systemType: data.systemType || prev.systemType,
                      estimatedAge: data.estimatedAge || prev.estimatedAge,
                    }));
                    if (data.materials?.length) setMaterials(data.materials);
                    if (data.keyFeatures?.length) setKeyFeatures(data.keyFeatures);
                    
                    setOriginalAiIdentification(JSON.stringify(data));
                    toast({ title: "AI identification complete — review and adjust the results" });
                  } catch (err: any) {
                    toast({ title: err.message || "AI identification failed", variant: "destructive" });
                  } finally {
                    setAiIdentifying(false);
                  }
                }}
              >
                {aiIdentifying ? (
                  <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Identifying...</>
                ) : (
                  <><Sparkles className="w-4 h-4 mr-1" /> Identify System</>
                )}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {PHOTO_SLOTS.map((slot) => {
              const photo = getPhotoForSlot(slot.key);
              return (
                <div key={slot.key} className="space-y-2">
                  <Label className="text-xs">{slot.label}</Label>
                  {photo ? (
                    <div className="relative group">
                      <img
                        src={`${API_BASE}/api/uploads/${photo.filename}`}
                        alt={slot.label}
                        className="w-full h-32 object-cover rounded-lg border"
                      />
                      <button
                        type="button"
                        onClick={() => handleDeletePhoto(photo.id)}
                        className="absolute top-1 right-1 p-1 rounded-full bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="h-32 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-2 text-muted-foreground">
                      <ImageIcon className="w-8 h-8 opacity-40" />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => cameraInputRefs.current[slot.key]?.click()}
                          className="p-2 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          disabled={!isEdit || uploading === slot.key}
                        >
                          <Camera className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputRefs.current[slot.key]?.click()}
                          className="p-2 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          disabled={!isEdit || uploading === slot.key}
                        >
                          <Upload className="w-4 h-4" />
                        </button>
                      </div>
                      {!isEdit && <p className="text-xs">Save first to add photos</p>}
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
        </Card>

        {/* AI Description */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label htmlFor="aiDescription">System Description</Label>
            {isEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={aiDescribing}
                onClick={async () => {
                  setAiDescribing(true);
                  try {
                    const res = await aiRequest("/api/ai/generate-system-description", { systemId: Number(systemId) });
                    const data = await res.json();
                    setForm(prev => ({ ...prev, aiDescription: data.description }));
                    setOriginalAiDescription(data.description);
                    toast({ title: "Description generated — review and edit as needed" });
                  } catch (err: any) {
                    toast({ title: err.message || "Description generation failed", variant: "destructive" });
                  } finally {
                    setAiDescribing(false);
                  }
                }}
              >
                {aiDescribing ? (
                  <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="w-4 h-4 mr-1" /> Generate Description</>
                )}
              </Button>
            )}
          </div>
          <Textarea
            id="aiDescription"
            placeholder={isEdit ? "Click 'Generate Description' to create AI-generated prose" : "Save the system first, then generate a description"}
            value={form.aiDescription}
            onChange={set("aiDescription")}
            rows={6}
          />
        </div>

        {/* Save button */}
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
          <div className="max-w-2xl mx-auto">
            <Button type="submit" className="w-full" disabled={saveMutation.isPending}>
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? "Saving..." : isEdit ? "Update System" : "Create System"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
