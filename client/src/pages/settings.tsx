import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Save,
  Download,
  Database,
  Key,
  BookOpen,
  Upload,
  Trash2,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { useState, useRef } from "react";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface ReportDocument {
  id: string;
  originalName: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
  extractionStatus: string;
  extractionError: string;
  passageCount: number;
}

interface ReportPassage {
  id: string;
  documentId: string;
  category: string;
  text: string;
  sourceSection: string;
  embedding: string | null;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "complete") {
    return <Badge variant="outline" className="border-green-500 text-green-700 dark:text-green-400">Complete</Badge>;
  }
  if (status === "error") {
    return <Badge variant="destructive">Error</Badge>;
  }
  if (status === "processing") {
    return (
      <Badge variant="outline" className="border-blue-500 text-blue-700 dark:text-blue-400">
        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
        Processing
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
      Pending
    </Badge>
  );
}

function categoryColor(category: string): string {
  switch (category) {
    case "description": return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "narrative": return "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300";
    case "recommendation": return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    case "risk": return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    default: return "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";
  }
}

function DocumentRow({ doc }: { doc: ReportDocument }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const { data: passages } = useQuery<ReportPassage[]>({
    queryKey: ["/api/report-library/documents", doc.id, "passages"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/report-library/documents/${doc.id}/passages`);
      if (!r.ok) throw new Error("Failed to load passages");
      return r.json();
    },
    enabled: open,
  });

  const deleteDocMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/report-library/documents/${doc.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-library/documents"] });
      toast({ title: "Report deleted" });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Delete failed", variant: "destructive" });
    },
  });

  const deletePassageMutation = useMutation({
    mutationFn: async (passageId: string) => {
      await apiRequest("DELETE", `/api/report-library/passages/${passageId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-library/documents", doc.id, "passages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/report-library/documents"] });
      toast({ title: "Passage removed" });
    },
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border rounded-md">
        <div className="flex items-center gap-3 p-3">
          <CollapsibleTrigger asChild>
            <button
              className="flex-1 flex items-center gap-2 text-left hover:bg-accent/50 rounded-md -mx-2 px-2 py-1 transition-colors"
              disabled={doc.extractionStatus !== "complete"}
            >
              <ChevronRight
                className={`w-4 h-4 transition-transform ${open ? "rotate-90" : ""}`}
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{doc.originalName}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  <span>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
                  <span>•</span>
                  <span>{formatBytes(doc.fileSize)}</span>
                  <span>•</span>
                  <span>{doc.passageCount} passage{doc.passageCount === 1 ? "" : "s"}</span>
                </div>
              </div>
            </button>
          </CollapsibleTrigger>
          <StatusBadge status={doc.extractionStatus} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm(`Delete "${doc.originalName}" and all its extracted passages?`)) {
                deleteDocMutation.mutate();
              }
            }}
            disabled={deleteDocMutation.isPending}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {doc.extractionStatus === "error" && doc.extractionError && (
          <div className="px-3 pb-3 text-xs text-destructive">
            Error: {doc.extractionError}
          </div>
        )}

        <CollapsibleContent>
          <div className="border-t px-3 py-2 space-y-2 bg-muted/30">
            {passages && passages.length === 0 && (
              <p className="text-xs text-muted-foreground py-2">No passages extracted.</p>
            )}
            {passages?.map((p) => (
              <div key={p.id} className="flex items-start gap-2 p-2 rounded bg-background border">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-2 py-0.5 rounded ${categoryColor(p.category)}`}>
                      {p.category}
                    </span>
                    {p.sourceSection && (
                      <span className="text-xs text-muted-foreground truncate">
                        {p.sourceSection}
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed line-clamp-4">{p.text}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => deletePassageMutation.mutate(p.id)}
                  disabled={deletePassageMutation.isPending}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ReportLibrarySection() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: documents } = useQuery<ReportDocument[]>({
    queryKey: ["/api/report-library/documents"],
    refetchInterval: (query) => {
      const docs = query.state.data as ReportDocument[] | undefined;
      if (!docs) return false;
      const hasActive = docs.some(
        (d) => d.extractionStatus === "pending" || d.extractionStatus === "processing"
      );
      return hasActive ? 2500 : false;
    },
  });

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE}/api/report-library/upload`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Upload failed");
      }
      toast({ title: "Report uploaded", description: "Extraction is running in the background." });
      queryClient.invalidateQueries({ queryKey: ["/api/report-library/documents"] });
    } catch (err: any) {
      toast({ title: err.message || "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card className="p-6 space-y-4 mb-6">
      <div className="flex items-center gap-2">
        <BookOpen className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-medium">Report Library</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Upload past inspection reports (PDF or DOCX). The AI will extract passages by section and use
        them as style exemplars to match your writing style in all generated text.
      </p>

      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />
        <Button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading...
            </>
          ) : (
            <>
              <Upload className="w-4 h-4 mr-2" /> Upload Report
            </>
          )}
        </Button>
        <span className="text-xs text-muted-foreground">PDF or DOCX up to 100 MB</span>
      </div>

      <div className="space-y-2">
        {documents && documents.length === 0 && (
          <div className="text-sm text-muted-foreground italic py-4 text-center border border-dashed rounded-md">
            No reports uploaded yet. Upload one to start building your style library.
          </div>
        )}
        {documents?.map((d) => (
          <DocumentRow key={d.id} doc={d} />
        ))}
      </div>
    </Card>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  // Fetch current API key status
  const { data: keyData } = useQuery<{ value: string | null; hasKey?: boolean }>({
    queryKey: ["/api/settings/openai_api_key"],
  });

  // Fetch training data count
  const { data: trainingCount } = useQuery<{ count: number }>({
    queryKey: ["/api/ai/training-data/count"],
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/settings", {
        key: "openai_api_key",
        value: apiKey,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/openai_api_key"] });
      toast({ title: "API key saved" });
      setApiKey("");
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to save", variant: "destructive" });
    },
  });

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <Link href="/">
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" />
          Back to Projects
        </button>
      </Link>

      <h1 className="text-xl font-semibold tracking-tight mb-6">Settings</h1>

      {/* OpenAI API Key */}
      <Card className="p-6 space-y-4 mb-6">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-medium">OpenAI API Key</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Required for AI-powered features: system identification from photos, description generation,
          observation narratives, and recommendation drafting.
        </p>
        <p className="text-sm text-muted-foreground">
          Get your API key from{" "}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            platform.openai.com/api-keys
          </a>
        </p>

        {keyData?.hasKey && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-sm text-green-700 dark:text-green-400">
              API key configured: {keyData.value}
            </span>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="apiKey">
            {keyData?.hasKey ? "Replace API Key" : "API Key"}
          </Label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                id="apiKey"
                type={showKey ? "text" : "password"}
                placeholder="sk-proj-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!apiKey.startsWith("sk-") || saveMutation.isPending}
            >
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
          {apiKey && !apiKey.startsWith("sk-") && (
            <p className="text-xs text-destructive">API key should start with &quot;sk-&quot;</p>
          )}
        </div>
      </Card>

      {/* Report Library (RAG) */}
      <ReportLibrarySection />

      {/* Training Data */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-medium">AI Training Data</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Every time you correct an AI-generated description or narrative, the correction is saved.
          After 50-100 corrections, this data can be exported for fine-tuning a custom model
          that learns your writing style and terminology.
        </p>
        <div className="flex items-center justify-between p-3 rounded-md bg-accent/50">
          <span className="text-sm font-medium">
            Corrections saved: {trainingCount?.count ?? 0}
          </span>
          {(trainingCount?.count ?? 0) > 0 && (
            <a href={`${API_BASE}/api/ai/training-data/export`} download>
              <Button variant="outline" size="sm">
                <Download className="w-4 h-4 mr-2" />
                Export JSONL
              </Button>
            </a>
          )}
        </div>
        {(trainingCount?.count ?? 0) > 0 && (trainingCount?.count ?? 0) < 50 && (
          <p className="text-xs text-muted-foreground">
            {50 - (trainingCount?.count ?? 0)} more corrections needed before fine-tuning is recommended.
          </p>
        )}
        {(trainingCount?.count ?? 0) >= 50 && (
          <p className="text-xs text-green-600 dark:text-green-400">
            You have enough training data for a fine-tuning job. Export the JSONL file and upload
            it at platform.openai.com/finetune.
          </p>
        )}
      </Card>
    </div>
  );
}
