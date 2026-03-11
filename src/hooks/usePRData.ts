import { api } from "../lib/api.ts";
import { useWSFetch } from "./useWSFetch.ts";

type PR = {
  url?: string;
  title?: string;
  state?: string;
  number?: number;
};

type Check = {
  name: string;
  status: string;
  conclusion: string;
  url: string;
};

type PRComment = {
  id: number;
  body: string;
  user: string;
  path: string;
  line: number;
  createdAt: string;
  isResolved: boolean;
};

type PRData = {
  pr: PR | null;
  checks: Check[];
  comments: PRComment[];
};

async function fetchPRData(): Promise<PRData> {
  const { pr } = await api.getPR();
  const prData = pr as PR | null;
  if (!prData?.number) {
    return { pr: prData, checks: [], comments: [] };
  }
  const [ci, commentsRes] = await Promise.all([api.getCI(), api.getPRComments()]);
  return {
    pr: prData,
    checks: (ci.checks as Check[]) ?? [],
    comments: (commentsRes.comments as PRComment[]) ?? [],
  };
}

export function usePRData() {
  const { data } = useWSFetch({
    fetch: fetchPRData,
    wsMessageType: ["diff-updated", "pr-updated"],
  });

  return {
    prUrl: data?.pr?.url ?? null,
    prTitle: data?.pr?.title ?? null,
    prState: data?.pr?.state ?? null,
    checks: data?.checks ?? [],
    prComments: data?.comments ?? [],
  };
}
