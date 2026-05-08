import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Upload, Trash2, Download, Loader2, FileText, ClipboardList } from "lucide-react";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const DOCUMENT_TYPES = [
  "Specification",
  "Drawing",
  "BCA document",
  "Maintenance log",
  "Prior report",
  "Warranty",
  "Standard",
  "Other",
];

interface ProjectDocument {
  id: number;
  projectId: number;
  originalName: string;
  filePath: string;
  mimeType: string | null;
  fileSize: number | null;
  uploadedAt: string;
  author: string | null;
  year: string | null;
  title: string | null;
  publisher: string | null;
  documentType: string | null;
  notes: string | null;
  extractionStatus: string | null;
  extractionError: string | null;
  extractedText: string | null;
}

function StatusBadge({ status }: { status: string | null }) {
  const s = (status || "").toLowerCase();
  if (s === "complete") return <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Complete</Badge>;
  if (s === "processing") return <Badge variant="secondary" className="bg-blue-100 text-blue-800 hover:bg-blue-100"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Processing</Badge>;
  if (s === "pending") return <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-100">Pending</Badge>;
  if (s === "skipped") return <Badge variant="secondary">Skipped (image)</Badge>;
  if (s === "error") return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="secondary">{status || "—"}</Badge>;
}

export default function ProjectDataTab({ projectId }: { projectId: number }) {
  const { toast } = useToast();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadMeta, setUploadMeta] = useState({
    author: "",
    year: "",
    title: "",
    publisher: "",
    documentType: "",
    notes: "",
  });
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Local edits for inline editing — keyed by document id
  const [edits, setEdits] = useState<Record<number, Partial<ProjectDocument>>>({});
  const debounceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const docsKey = [`/api/projects/${projectId}/documents`] as const;
  const { data: docs = [], refetch } = useQuery<ProjectDocument[]>({
    queryKey: docsKey,
    refetchInterval: (q) => {
      const arr = (q.state.data as ProjectDocument[] | undefined) || [];
      const stillWorking = arr.some(
        (d) => d.extractionStatus === "pending" || d.extractionStatus === "processing"
      );
      return stillWorking ? 2500 : false;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE}/api/project-documents/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("Delete failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: docsKey });
      toast({ title: "Document deleted" });
    },
    onError: (err: any) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  const patchMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Record<string, string> }) => {
      const res = await fetch(`${API_BASE}/api/project-documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Update failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: docsKey });
    },
  });

  const valueFor = (d: ProjectDocument, field: keyof ProjectDocument): string => {
    const e = edits[d.id]?.[field];
    if (typeof e === "string") return e;
    const v = d[field];
    return typeof v === "string" ? v : "";
  };

  const handleFieldChange = (d: ProjectDocument, field: keyof ProjectDocument, value: string) => {
    setEdits((prev) => ({ ...prev, [d.id]: { ...prev[d.id], [field]: value } }));
    if (debounceTimers.current[d.id]) clearTimeout(debounceTimers.current[d.id]);
    debounceTimers.current[d.id] = setTimeout(() => {
      patchMutation.mutate({ id: d.id, patch: { [field]: value } });
    }, 700);
  };

  // Cleanup on unmount: flush any pending timers
  useEffect(() => {
    return () => {
      Object.values(debounceTimers.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  const submitUpload = async () => {
    if (!uploadFile) {
      toast({ title: "No file selected", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      if (uploadMeta.author) fd.append("author", uploadMeta.author);
      if (uploadMeta.year) fd.append("year", uploadMeta.year);
      if (uploadMeta.title) fd.append("title", uploadMeta.title);
      if (uploadMeta.publisher) fd.append("publisher", uploadMeta.publisher);
      if (uploadMeta.documentType) fd.append("documentType", uploadMeta.documentType);
      if (uploadMeta.notes) fd.append("notes", uploadMeta.notes);

      const res = await fetch(`${API_BASE}/api/projects/${projectId}/documents`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Upload failed");
      }
      toast({ title: "Uploaded", description: "Text extraction running in the background." });
      setUploadOpen(false);
      setUploadFile(null);
      setUploadMeta({ author: "", year: "", title: "", publisher: "", documentType: "", notes: "" });
      if (fileInputRef.current) fileInputRef.current.value = "";
      refetch();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Project Data</h2>
          <p className="text-sm text-muted-foreground max-w-2xl mt-1">
            Upload project-specific documents (drawings, specifications, BCA documents, maintenance logs, prior reports, warranties) for the AI to reference. These will appear as Harvard-style references in Section 2.5 of the exported report.
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)} size="sm">
          <Upload className="w-4 h-4 mr-2" />
          Upload document
        </Button>
      </div>

      {docs.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          <FileText className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
          <p>No project documents uploaded yet. Upload PDF, DOCX, JPG or PNG files.</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">File</TableHead>
                <TableHead className="w-40">Document type</TableHead>
                <TableHead className="min-w-[180px]">Title</TableHead>
                <TableHead className="w-40">Author</TableHead>
                <TableHead className="w-20">Year</TableHead>
                <TableHead className="w-36">Publisher</TableHead>
                <TableHead className="min-w-[160px]">Notes</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="text-xs break-all" title={d.originalName}>
                    {d.originalName}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={valueFor(d, "documentType")}
                      onValueChange={(v) => handleFieldChange(d, "documentType", v)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {DOCUMENT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-xs"
                      value={valueFor(d, "title")}
                      placeholder={d.originalName}
                      onChange={(e) => handleFieldChange(d, "title", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-xs"
                      value={valueFor(d, "author")}
                      placeholder='e.g. "Smith, J."'
                      onChange={(e) => handleFieldChange(d, "author", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-xs"
                      value={valueFor(d, "year")}
                      placeholder="2024"
                      onChange={(e) => handleFieldChange(d, "year", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-xs"
                      value={valueFor(d, "publisher")}
                      onChange={(e) => handleFieldChange(d, "publisher", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-xs"
                      value={valueFor(d, "notes")}
                      onChange={(e) => handleFieldChange(d, "notes", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <StatusBadge status={d.extractionStatus} />
                      {d.extractionStatus === "error" && d.extractionError ? (
                        <span className="text-xs text-destructive truncate max-w-[10rem]" title={d.extractionError}>
                          {d.extractionError}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <a
                        href={`${API_BASE}/api/project-documents/${d.id}/file`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button size="icon" variant="ghost" className="h-7 w-7">
                          <Download className="w-4 h-4" />
                        </Button>
                      </a>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => {
                          if (confirm(`Delete "${d.originalName}"?`)) {
                            deleteMutation.mutate(d.id);
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={uploadOpen} onOpenChange={(v) => !uploading && setUploadOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Upload project document
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>File (PDF, DOCX, JPG, PNG)</Label>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  setUploadFile(f);
                  if (f && !uploadMeta.title) {
                    setUploadMeta((m) => ({ ...m, title: f.name.replace(/\.[^.]+$/, "") }));
                  }
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Document type</Label>
                <Select
                  value={uploadMeta.documentType}
                  onValueChange={(v) => setUploadMeta((m) => ({ ...m, documentType: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Year</Label>
                <Input
                  value={uploadMeta.year}
                  onChange={(e) => setUploadMeta((m) => ({ ...m, year: e.target.value }))}
                  placeholder="2024"
                />
              </div>
            </div>
            <div>
              <Label>Title</Label>
              <Input
                value={uploadMeta.title}
                onChange={(e) => setUploadMeta((m) => ({ ...m, title: e.target.value }))}
                placeholder="e.g. As-built facade specification"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Author</Label>
                <Input
                  value={uploadMeta.author}
                  onChange={(e) => setUploadMeta((m) => ({ ...m, author: e.target.value }))}
                  placeholder='e.g. "Smith, J." or firm name'
                />
              </div>
              <div>
                <Label>Publisher</Label>
                <Input
                  value={uploadMeta.publisher}
                  onChange={(e) => setUploadMeta((m) => ({ ...m, publisher: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={uploadMeta.notes}
                onChange={(e) => setUploadMeta((m) => ({ ...m, notes: e.target.value }))}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={uploading}>
              Cancel
            </Button>
            <Button onClick={submitUpload} disabled={uploading || !uploadFile}>
              {uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading…</> : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
