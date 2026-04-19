import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, ZoomIn, ZoomOut, RotateCcw, X, Trash2, Eye } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import type { Elevation, Observation } from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface EnrichedPin {
  id: number;
  elevationId: number;
  observationId: number;
  x: number;
  y: number;
  createdAt: string;
  observationIdText: string;
  defectCategory: string;
  severity: string;
  location: string;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "Safety/Risk": return "bg-red-500";
    case "Essential": return "bg-orange-500";
    case "Desirable": return "bg-yellow-500";
    case "Monitor": return "bg-green-500";
    default: return "bg-gray-500";
  }
}

export default function ElevationView() {
  const { id: projectId, elevationId } = useParams<{ id: string; elevationId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: elevation } = useQuery<Elevation>({
    queryKey: [`/api/elevations/${elevationId}`],
  });

  const { data: pins } = useQuery<EnrichedPin[]>({
    queryKey: [`/api/elevations/${elevationId}/pins`],
  });

  const { data: observations } = useQuery<Observation[]>({
    queryKey: [`/api/projects/${projectId}/observations`],
  });

  const [addPinMode, setAddPinMode] = useState(false);
  const [selectedPinId, setSelectedPinId] = useState<number | null>(null);
  const [pendingPin, setPendingPin] = useState<{ x: number; y: number } | null>(null);
  const [observationDialog, setObservationDialog] = useState(false);
  const [selectedObsId, setSelectedObsId] = useState<string>("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);

  // Touch & mouse state
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);

  const handleImageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!addPinMode) return;
    if (!imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 10000;
    const y = ((e.clientY - rect.top) / rect.height) * 10000;
    setPendingPin({ x: Math.round(x), y: Math.round(y) });
    setObservationDialog(true);
  };

  const createPinMutation = useMutation({
    mutationFn: async (data: { observationId: number; x: number; y: number }) => {
      const res = await apiRequest("POST", `/api/elevations/${elevationId}/pins`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/elevations/${elevationId}/pins`] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/observations`] });
      setAddPinMode(false);
      setPendingPin(null);
      setObservationDialog(false);
      setSelectedObsId("");
      toast({ title: "Pin added" });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to add pin", variant: "destructive" });
    },
  });

  const deletePinMutation = useMutation({
    mutationFn: async (pinId: number) => {
      await apiRequest("DELETE", `/api/elevation-pins/${pinId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/elevations/${elevationId}/pins`] });
      queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/observations`] });
      setSelectedPinId(null);
      toast({ title: "Pin removed" });
    },
  });

  const confirmPendingPin = () => {
    if (!pendingPin || !selectedObsId) return;
    createPinMutation.mutate({ observationId: Number(selectedObsId), x: pendingPin.x, y: pendingPin.y });
  };

  // Pan/zoom handlers
  const onMouseDown = (e: React.MouseEvent) => {
    if (addPinMode) return;
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragStart.current) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  };
  const onMouseUp = () => { dragStart.current = null; };

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
    } else if (e.touches.length === 1 && !addPinMode) {
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
    } else if (e.touches.length === 1 && dragStart.current) {
      setPan({
        x: dragStart.current.panX + (e.touches[0].clientX - dragStart.current.x),
        y: dragStart.current.panY + (e.touches[0].clientY - dragStart.current.y),
      });
    }
  };
  const onTouchEnd = () => {
    dragStart.current = null;
    pinchStart.current = null;
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Observations available for pinning (not already pinned on any elevation)
  const availableObservations = (observations || []).filter(
    (o) => !(pins || []).some((p) => p.observationId === o.id),
  );

  const selectedPin = (pins || []).find((p) => p.id === selectedPinId);

  if (!elevation) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <Link href={`/projects/${projectId}`}>
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
            <ArrowLeft className="w-4 h-4" />
            Back to Project
          </button>
        </Link>
        <p className="text-sm text-muted-foreground">Loading elevation...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh]">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-2 shrink-0 bg-background">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/projects/${projectId}`}>
            <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div className="min-w-0">
            <h1 className="text-base font-semibold truncate">{elevation.name}</h1>
            <p className="text-xs text-muted-foreground">
              {elevation.type === "roof_plan" ? "Roof Plan" : "Elevation"} • {(pins || []).length} pins
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
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
            variant={addPinMode ? "default" : "outline"}
            size="sm"
            onClick={() => { setAddPinMode(!addPinMode); setSelectedPinId(null); }}
          >
            {addPinMode ? <><X className="w-4 h-4 mr-1" /> Cancel</> : <><Plus className="w-4 h-4 mr-1" /> Add Pin</>}
          </Button>
        </div>
      </div>

      {addPinMode && (
        <div className="px-4 py-2 bg-primary/10 text-primary text-sm text-center shrink-0">
          Tap on the drawing to place a pin
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative bg-muted/30 touch-none"
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
            transition: dragStart.current || pinchStart.current ? "none" : "transform 0.1s",
          }}
        >
          <div
            ref={imageRef}
            className="relative inline-block select-none"
            onClick={handleImageClick}
            style={{ cursor: addPinMode ? "crosshair" : "grab" }}
          >
            <img
              src={`${API_BASE}/api/elevations/${elevationId}/image`}
              alt={elevation.name}
              className="max-w-[90vw] max-h-[80vh] object-contain pointer-events-none"
              draggable={false}
            />
            {(pins || []).map((pin) => (
              <button
                key={pin.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedPinId(pin.id === selectedPinId ? null : pin.id);
                }}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md flex items-center justify-center text-white text-[10px] font-bold whitespace-nowrap transition-transform hover:scale-110 ${severityColor(pin.severity)}`}
                style={{
                  left: `${pin.x / 100}%`,
                  top: `${pin.y / 100}%`,
                  width: "32px",
                  height: "32px",
                  minWidth: "32px",
                  padding: "2px",
                }}
                title={`${pin.observationIdText} - ${pin.defectCategory}`}
              >
                {pin.observationIdText}
              </button>
            ))}
          </div>
        </div>

        {/* Selected pin popup */}
        {selectedPin && (
          <Card className="absolute bottom-4 left-4 right-4 md:left-auto md:w-96 p-4 z-10 shadow-lg">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{selectedPin.observationIdText}</span>
                  <Badge variant="secondary" className="text-xs">{selectedPin.defectCategory}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{selectedPin.severity} • {selectedPin.location}</p>
              </div>
              <button onClick={() => setSelectedPinId(null)} className="p-1 rounded hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex gap-2 mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/projects/${projectId}/observations/${selectedPin.observationId}`)}
              >
                <Eye className="w-3.5 h-3.5 mr-1" />
                View Observation
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm("Remove this pin?")) {
                    deletePinMutation.mutate(selectedPin.id);
                  }
                }}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                Remove Pin
              </Button>
            </div>
          </Card>
        )}
      </div>

      {/* Observation selector dialog for pending pin */}
      <Dialog open={observationDialog} onOpenChange={(open) => {
        setObservationDialog(open);
        if (!open) { setPendingPin(null); setSelectedObsId(""); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link to Observation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {availableObservations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No unpinned observations available. Create a new observation first, or remove existing pins.
              </p>
            ) : (
              <div>
                <Label>Observation</Label>
                <Select value={selectedObsId} onValueChange={setSelectedObsId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an observation" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableObservations.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.observationId} — {o.defectCategory}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setObservationDialog(false); setPendingPin(null); setSelectedObsId("");
            }}>
              Cancel
            </Button>
            <Button onClick={confirmPendingPin} disabled={!selectedObsId || createPinMutation.isPending}>
              Add Pin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
