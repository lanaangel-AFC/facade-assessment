import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Plus, ZoomIn, ZoomOut, RotateCcw, X, Trash2, Upload, ImageIcon, Move } from "lucide-react";
import { useState, useRef } from "react";
import type { Project, Drop } from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const DROP_COLOR = "#00B5B8";

function suggestNextNumber(last: string | null): string {
  if (!last) return "01";
  // Match a prefix + trailing number, e.g. "DR-1" -> "DR-2", "01" -> "02"
  const m = last.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return last;
  const prefix = m[1];
  const numStr = m[2];
  const suffix = m[3];
  const nextNum = (parseInt(numStr, 10) + 1).toString();
  // Preserve zero-padding if the old number was zero-padded
  const padded = numStr.length > nextNum.length && numStr.startsWith("0")
    ? nextNum.padStart(numStr.length, "0")
    : nextNum;
  return `${prefix}${padded}${suffix}`;
}

interface Props {
  project: Project;
}

export default function RoofPlanMarkup({ project }: Props) {
  const { toast } = useToast();
  const projectId = project.id;

  const { data: drops } = useQuery<Drop[]>({
    queryKey: [`/api/projects/${projectId}/drops`],
    enabled: !!project.roofPlanImagePath,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [addMode, setAddMode] = useState(false);
  const [selectedDropId, setSelectedDropId] = useState<number | null>(null);
  const [editNumber, setEditNumber] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageVersion, setImageVersion] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
  const draggingDrop = useRef<{ id: number; moved: boolean } | null>(null);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/roof-plan`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Upload failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId)] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/drops`] });
      setImageVersion(v => v + 1);
      toast({ title: "Roof plan uploaded" });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Upload failed", variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/projects/${projectId}/roof-plan`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId)] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/drops`] });
      setSelectedDropId(null);
      setAddMode(false);
      toast({ title: "Roof plan removed" });
    },
  });

  const createDropMutation = useMutation({
    mutationFn: async (data: { dropNumber: string; x: number; y: number }) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/drops`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/drops`] });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to add drop", variant: "destructive" });
    },
  });

  const updateDropMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Partial<Drop> }) => {
      const res = await apiRequest("PATCH", `/api/drops/${id}`, patch);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/drops`] });
    },
  });

  const deleteDropMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/drops/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/drops`] });
      setSelectedDropId(null);
    },
  });

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
    e.target.value = "";
  };

  const handleImageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!addMode) return;
    if (!imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 10000);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 10000);
    const lastDrop = (drops || []).length > 0 ? (drops || [])[(drops || []).length - 1] : null;
    const dropNumber = suggestNextNumber(lastDrop ? lastDrop.dropNumber : null);
    createDropMutation.mutate({ dropNumber, x, y });
    setAddMode(false);
  };

  // Pan/zoom handlers (disabled while dragging a drop or adding)
  const onMouseDown = (e: React.MouseEvent) => {
    if (addMode || draggingDrop.current) return;
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (draggingDrop.current && imageRef.current) {
      const rect = imageRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(10000, Math.round(((e.clientX - rect.left) / rect.width) * 10000)));
      const y = Math.max(0, Math.min(10000, Math.round(((e.clientY - rect.top) / rect.height) * 10000)));
      const { id } = draggingDrop.current;
      draggingDrop.current.moved = true;
      // Optimistic update
      queryClient.setQueryData<Drop[]>([`/api/projects/${projectId}/drops`], (old) =>
        (old || []).map((d) => (d.id === id ? { ...d, x, y } : d)),
      );
      return;
    }
    if (!dragStart.current) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  };
  const onMouseUp = () => {
    if (draggingDrop.current) {
      const { id, moved } = draggingDrop.current;
      if (moved) {
        const current = (drops || []).find((d) => d.id === id);
        if (current) {
          updateDropMutation.mutate({ id, patch: { x: current.x, y: current.y } });
        }
      }
      draggingDrop.current = null;
    }
    dragStart.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.5, Math.min(5, z * delta)));
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStart.current = { dist: Math.hypot(dx, dy), zoom };
    } else if (e.touches.length === 1 && !addMode && !draggingDrop.current) {
      dragStart.current = {
        x: e.touches[0].clientX, y: e.touches[0].clientY, panX: pan.x, panY: pan.y,
      };
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchStart.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / pinchStart.current.dist;
      setZoom(Math.max(0.5, Math.min(5, pinchStart.current.zoom * ratio)));
    } else if (e.touches.length === 1 && draggingDrop.current && imageRef.current) {
      const rect = imageRef.current.getBoundingClientRect();
      const touch = e.touches[0];
      const x = Math.max(0, Math.min(10000, Math.round(((touch.clientX - rect.left) / rect.width) * 10000)));
      const y = Math.max(0, Math.min(10000, Math.round(((touch.clientY - rect.top) / rect.height) * 10000)));
      const { id } = draggingDrop.current;
      draggingDrop.current.moved = true;
      queryClient.setQueryData<Drop[]>([`/api/projects/${projectId}/drops`], (old) =>
        (old || []).map((d) => (d.id === id ? { ...d, x, y } : d)),
      );
    } else if (e.touches.length === 1 && dragStart.current) {
      setPan({
        x: dragStart.current.panX + (e.touches[0].clientX - dragStart.current.x),
        y: dragStart.current.panY + (e.touches[0].clientY - dragStart.current.y),
      });
    }
  };
  const onTouchEnd = () => {
    if (draggingDrop.current) {
      const { id, moved } = draggingDrop.current;
      if (moved) {
        const current = (drops || []).find((d) => d.id === id);
        if (current) {
          updateDropMutation.mutate({ id, patch: { x: current.x, y: current.y } });
        }
      }
      draggingDrop.current = null;
    }
    dragStart.current = null;
    pinchStart.current = null;
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const selectedDrop = (drops || []).find((d) => d.id === selectedDropId);

  // Upload-only state
  if (!project.roofPlanImagePath) {
    return (
      <Card className="p-6 space-y-3">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-muted-foreground" />
          <h3 className="text-sm font-medium">Roof Plan</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Upload a roof plan to annotate drop locations. Supports image or PDF (first page only).
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={handleFileSelected}
        />
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
          size="sm"
        >
          <Upload className="w-4 h-4 mr-2" />
          {uploadMutation.isPending ? "Uploading..." : "Upload Roof Plan"}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-muted-foreground" />
          <h3 className="text-sm font-medium">Roof Plan</h3>
          {project.roofPlanOriginalName && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {project.roofPlanOriginalName}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            • {(drops || []).length} drop{(drops || []).length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={handleFileSelected}
          />
          <Button variant="outline" size="icon" onClick={() => setZoom(z => Math.max(0.5, z * 0.9))}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => setZoom(z => Math.min(5, z * 1.1))}>
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={resetView}>
            <RotateCcw className="w-4 h-4" />
          </Button>
          <Button
            variant={addMode ? "default" : "outline"}
            size="sm"
            onClick={() => { setAddMode(!addMode); setSelectedDropId(null); }}
          >
            {addMode ? <><X className="w-4 h-4 mr-1" /> Cancel</> : <><Plus className="w-4 h-4 mr-1" /> Add Drop</>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
          >
            <Upload className="w-4 h-4 mr-1" />
            Replace
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm("Remove the roof plan and all drops? This cannot be undone.")) {
                removeMutation.mutate();
              }
            }}
            disabled={removeMutation.isPending}
          >
            <Trash2 className="w-4 h-4 mr-1" />
            Remove
          </Button>
        </div>
      </div>

      {addMode && (
        <div className="px-4 py-2 bg-primary/10 text-primary text-sm text-center rounded">
          Tap on the plan to place a drop
        </div>
      )}

      <div
        ref={containerRef}
        className="relative overflow-hidden bg-muted/30 rounded border touch-none"
        style={{ height: "60vh", minHeight: 400 }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="absolute top-1/2 left-1/2 origin-center"
          style={{
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: dragStart.current || pinchStart.current || draggingDrop.current ? "none" : "transform 0.1s",
          }}
        >
          <div
            ref={imageRef}
            className="relative inline-block select-none"
            onClick={handleImageClick}
            style={{ cursor: addMode ? "crosshair" : "grab" }}
          >
            <img
              src={`${API_BASE}/api/projects/${projectId}/roof-plan/image?v=${imageVersion}`}
              alt="Roof plan"
              className="max-w-[90vw] max-h-[80vh] object-contain pointer-events-none block"
              draggable={false}
            />
            {(drops || []).map((drop) => (
              <button
                key={drop.id}
                onPointerDown={(e) => {
                  if (addMode) return;
                  e.stopPropagation();
                  draggingDrop.current = { id: drop.id, moved: false };
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (draggingDrop.current && draggingDrop.current.moved) {
                    return;
                  }
                  if (selectedDropId === drop.id) {
                    setSelectedDropId(null);
                  } else {
                    setSelectedDropId(drop.id);
                    setEditNumber(drop.dropNumber);
                  }
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md flex items-center justify-center text-white text-[10px] font-bold whitespace-nowrap transition-transform hover:scale-110"
                style={{
                  left: `${drop.x / 100}%`,
                  top: `${drop.y / 100}%`,
                  width: "34px",
                  height: "34px",
                  minWidth: "34px",
                  padding: "2px",
                  backgroundColor: DROP_COLOR,
                  cursor: "grab",
                }}
                title={`Drop ${drop.dropNumber}`}
              >
                {drop.dropNumber}
              </button>
            ))}
          </div>
        </div>

        {selectedDrop && (
          <Card className="absolute bottom-4 left-4 right-4 md:left-auto md:w-80 p-4 z-10 shadow-lg">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">Drop {selectedDrop.dropNumber}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <Move className="w-3 h-3" />
                  Drag marker on the plan to move
                </p>
              </div>
              <button onClick={() => setSelectedDropId(null)} className="p-1 rounded hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Drop number</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    value={editNumber}
                    onChange={(e) => setEditNumber(e.target.value)}
                    placeholder="e.g. 01, DR-1"
                    className="h-9"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const trimmed = editNumber.trim();
                      if (!trimmed) return;
                      if (trimmed !== selectedDrop.dropNumber) {
                        updateDropMutation.mutate({
                          id: selectedDrop.id,
                          patch: { dropNumber: trimmed },
                        });
                      }
                    }}
                    disabled={!editNumber.trim() || editNumber.trim() === selectedDrop.dropNumber}
                  >
                    Save
                  </Button>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  if (confirm(`Delete drop ${selectedDrop.dropNumber}?`)) {
                    deleteDropMutation.mutate(selectedDrop.id);
                  }
                }}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                Delete Drop
              </Button>
            </div>
          </Card>
        )}
      </div>
    </Card>
  );
}
