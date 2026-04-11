import { useState, useEffect, useCallback } from "react";

type Route =
  | { page: "diff" }
  | { page: "commits" }
  | { page: "plan" }
  | { page: "review" }
  | { page: "commit"; hash: string };

function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h === "commits") return { page: "commits" };
  if (h === "plan") return { page: "plan" };
  if (h === "review") return { page: "review" };
  if (h.startsWith("commit/")) {
    const commitHash = h.slice("commit/".length);
    if (commitHash) return { page: "commit", hash: commitHash };
  }
  return { page: "diff" };
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((path: string) => {
    window.location.hash = path;
  }, []);

  return { route, navigate };
}
