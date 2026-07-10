import { useState, useEffect, useCallback } from "react";
import { setApiProject } from "../lib/api.ts";

type Route =
  | { page: "home"; project: null }
  | { page: "diff"; project: string | null }
  | { page: "commits"; project: string | null }
  | { page: "plan"; project: string | null }
  | { page: "review"; project: string | null }
  | { page: "commit"; hash: string; project: string | null };

function parsePage(h: string, project: string | null): Route {
  if (h === "commits") return { page: "commits", project };
  if (h === "plan") return { page: "plan", project };
  if (h === "review") return { page: "review", project };
  if (h.startsWith("commit/")) {
    const commitHash = h.slice("commit/".length);
    if (commitHash) return { page: "commit", hash: commitHash, project };
  }
  return { page: "diff", project };
}

function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  // Hub mode project routes: p/<id>[/<page>]
  if (h.startsWith("p/")) {
    const rest = h.slice(2);
    const slash = rest.indexOf("/");
    const project = slash === -1 ? rest : rest.slice(0, slash);
    const sub = slash === -1 ? "" : rest.slice(slash + 1);
    if (project) return parsePage(sub, project);
  }
  if (h === "") return { page: "home", project: null };
  return parsePage(h, null);
}

/** Parse and sync the API project scope before React re-renders */
function parseAndSync(hash: string): Route {
  const route = parseHash(hash);
  setApiProject(route.project);
  return route;
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseAndSync(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseAndSync(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((path: string) => {
    window.location.hash = path;
  }, []);

  return { route, navigate };
}
