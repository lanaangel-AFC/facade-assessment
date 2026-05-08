import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, X } from "lucide-react";
import type { ProjectRoofLevel } from "@shared/schema";

const ADD_ROOF_VALUE = "__add_roof__";
const CUSTOM_VALUE = "__custom__";
const GROUND_VALUE = "Ground";

const COMMON_LEVEL_SUGGESTIONS = [
  "B2", "B1", "G", "M",
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
];

export interface LevelFieldProps {
  projectId: string | number;
  value: string;
  onChange: (next: string) => void;
  /** Optional callback when a typing-blur happens (used by additional-locations to flush). */
  onBlur?: (next: string) => void;
  className?: string;
}

/**
 * Level field with project-scoped roof descriptors.
 * Options: Ground | <project roof labels> | "+ Add Roof level..." | "Custom..."
 * - Ground / saved roof level: selected directly.
 * - "+ Add Roof level...": inline text input + Save → POST → label "Roof – {descriptor}" stored.
 * - "Custom...": free-text input (datalist with B2..20) — value is set on the field but not persisted.
 */
export function LevelField({ projectId, value, onChange, onBlur, className }: LevelFieldProps) {
  const { toast } = useToast();
  const datalistId = useMemo(() => `level-suggestions-${Math.random().toString(36).slice(2, 8)}`, []);

  const { data: roofLevels } = useQuery<ProjectRoofLevel[]>({
    queryKey: [`/api/projects/${projectId}/roof-levels`],
    enabled: !!projectId,
  });

  const knownValues = useMemo(() => {
    const set = new Set<string>();
    set.add(GROUND_VALUE);
    for (const r of roofLevels || []) set.add(r.label);
    return set;
  }, [roofLevels]);

  // Mode state — drives which inline input (if any) shows.
  // 'select' = pure dropdown; 'addRoof' = descriptor input; 'custom' = free-text input.
  type Mode = "select" | "addRoof" | "custom";
  const [mode, setMode] = useState<Mode>("select");
  const [descriptorDraft, setDescriptorDraft] = useState("");
  const [savingRoof, setSavingRoof] = useState(false);

  // When the external value is something not in known list and not empty, switch to custom mode.
  useEffect(() => {
    if (!value) {
      // empty value — stay in select mode unless user already chose addRoof/custom
      return;
    }
    if (knownValues.has(value)) {
      setMode("select");
    } else {
      // Free-text legacy value (e.g. "B1", "12", or older custom string)
      if (mode !== "custom") setMode("custom");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, roofLevels]);

  const selectValue: string = (() => {
    if (mode === "addRoof") return ADD_ROOF_VALUE;
    if (mode === "custom") return CUSTOM_VALUE;
    if (value && knownValues.has(value)) return value;
    return "";
  })();

  const handleSelectChange = (v: string) => {
    if (v === ADD_ROOF_VALUE) {
      setMode("addRoof");
      setDescriptorDraft("");
      return;
    }
    if (v === CUSTOM_VALUE) {
      setMode("custom");
      // Don't clobber existing free-text — but if value is a known label, clear it.
      if (knownValues.has(value)) {
        onChange("");
      }
      return;
    }
    setMode("select");
    onChange(v);
    onBlur?.(v);
  };

  const saveRoof = async () => {
    const descriptor = descriptorDraft.trim();
    if (!descriptor) return;
    setSavingRoof(true);
    try {
      const res = await apiRequest("POST", `/api/projects/${projectId}/roof-levels`, { descriptor });
      const created: ProjectRoofLevel = await res.json();
      await queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/roof-levels`] });
      onChange(created.label);
      onBlur?.(created.label);
      setDescriptorDraft("");
      setMode("select");
      toast({ title: "Roof level added", description: created.label });
    } catch (err: any) {
      toast({ title: err?.message || "Failed to add roof level", variant: "destructive" });
    } finally {
      setSavingRoof(false);
    }
  };

  const deleteRoof = async (id: number, label: string) => {
    if (!confirm(`Delete "${label}"? Existing observations using this level will keep their stored value.`)) return;
    try {
      await apiRequest("DELETE", `/api/project-roof-levels/${id}`, undefined);
      await queryClient.invalidateQueries({ queryKey: [`/api/projects/${projectId}/roof-levels`] });
      // If the currently-selected value was the deleted one, leave it alone
      // (it's still valid as a free-text fallback) — round-trip will treat it as Custom.
      toast({ title: "Roof level removed" });
    } catch (err: any) {
      toast({ title: err?.message || "Delete failed", variant: "destructive" });
    }
  };

  return (
    <div className={className}>
      <Select value={selectValue} onValueChange={handleSelectChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select level" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={GROUND_VALUE}>Ground</SelectItem>
            {(roofLevels || []).map((rl) => (
              <SelectItem key={rl.id} value={rl.label}>
                <div className="flex items-center justify-between gap-2 w-full">
                  <span>{rl.label}</span>
                  <button
                    type="button"
                    aria-label={`Delete ${rl.label}`}
                    className="ml-2 rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onMouseDown={(e) => {
                      // Prevent the Select from interpreting this as an item-select
                      e.preventDefault();
                      e.stopPropagation();
                      deleteRoof(rl.id, rl.label);
                    }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </SelectItem>
            ))}
            <SelectItem value={ADD_ROOF_VALUE}>+ Add Roof level...</SelectItem>
            <SelectItem value={CUSTOM_VALUE}>Custom...</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>

      {mode === "addRoof" && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            autoFocus
            value={descriptorDraft}
            onChange={(e) => setDescriptorDraft(e.target.value.slice(0, 32))}
            placeholder="e.g. level 10, mid-rise, podium"
            maxLength={32}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveRoof();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setMode("select");
                setDescriptorDraft("");
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void saveRoof()}
            disabled={savingRoof || !descriptorDraft.trim()}
          >
            {savingRoof ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setMode("select");
              setDescriptorDraft("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {mode === "custom" && (
        <div className="mt-2">
          <Input
            list={datalistId}
            value={value}
            placeholder="e.g. 12, B1, M2"
            maxLength={40}
            onChange={(e) => onChange(e.target.value.slice(0, 40))}
            onBlur={(e) => onBlur?.(e.target.value.slice(0, 40))}
            className="font-mono text-center"
          />
          <datalist id={datalistId}>
            {COMMON_LEVEL_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
      )}
    </div>
  );
}

export default LevelField;
