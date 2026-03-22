import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Eye, EyeOff, Save, Download, Database, Key } from "lucide-react";
import { useState } from "react";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

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
