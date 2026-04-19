import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import ProjectList from "@/pages/project-list";
import ProjectDetail from "@/pages/project-detail";
import SystemForm from "@/pages/system-form";
import ObservationForm from "@/pages/observation-form";
import ElevationView from "@/pages/elevation-view";
import Settings from "@/pages/settings";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={ProjectList} />
      <Route path="/projects/:id" component={ProjectDetail} />
      <Route path="/projects/:projectId/systems/new" component={SystemForm} />
      <Route path="/projects/:projectId/systems/:systemId" component={SystemForm} />
      <Route path="/projects/:projectId/observations/new" component={ObservationForm} />
      <Route path="/projects/:projectId/observations/:observationId" component={ObservationForm} />
      <Route path="/projects/:id/elevations/:elevationId" component={ElevationView} />
      <Route path="/settings" component={Settings} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <div className="min-h-screen flex flex-col">
            <main className="flex-1">
              <AppRouter />
            </main>
            <footer className="py-3 px-4 text-center border-t">
              <PerplexityAttribution />
            </footer>
          </div>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
