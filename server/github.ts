import type { CommandRunner } from "./git.ts";

export type GitHubService = ReturnType<typeof createGitHubService>;

type PRInfo = {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  body: string;
};

type PRComment = {
  id: number;
  body: string;
  bodyHtml: string;
  user: string;
  path: string;
  line: number;
  createdAt: string;
  updatedAt: string;
  isResolved: boolean;
};

type CICheck = {
  name: string;
  status: string;
  conclusion: string;
  url: string;
};

type RestPR = {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  body: string | null;
};

export function createGitHubService(run: CommandRunner, cwd: string) {
  const gh = (args: string[]) => run(["gh", ...args], { cwd });

  // Cache owner/repo — won't change during a session
  let cachedOwnerRepo: { owner: string; repo: string } | null = null;
  async function getOwnerRepo(): Promise<{ owner: string; repo: string }> {
    if (cachedOwnerRepo) return cachedOwnerRepo;
    const raw = await gh(["repo", "view", "--json", "owner,name"]);
    const data = JSON.parse(raw) as { owner: { login: string }; name: string };
    cachedOwnerRepo = { owner: data.owner.login, repo: data.name };
    return cachedOwnerRepo;
  }

  return {
    // Use REST API with --cache for conditional requests (ETag/304).
    // 304 responses don't count against GitHub's rate limit.
    // REST `gh api` returns exit code 0 with empty array when no PR exists,
    // and non-zero on real API errors, preserving the same error semantics
    // as the previous `gh pr list` approach.
    async getCurrentPR(branch: string): Promise<PRInfo | null> {
      const { owner, repo } = await getOwnerRepo();
      const raw = await gh([
        "api",
        `repos/${owner}/${repo}/pulls`,
        "--cache",
        "30s",
        "-f",
        `head=${owner}:${branch}`,
        "-f",
        "state=all",
        "-f",
        "per_page=1",
      ]);
      const results: RestPR[] = JSON.parse(raw);
      if (results.length === 0) return null;
      const pr = results[0];
      if (!pr) return null;
      // REST API uses lowercase state without "merged" — derive from merged_at
      const state = pr.merged_at ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN";
      return {
        number: pr.number,
        title: pr.title,
        state,
        url: pr.html_url,
        headRefName: pr.head.ref,
        baseRefName: pr.base.ref,
        body: pr.body ?? "",
      };
    },

    async getPRComments(prNumber: number): Promise<PRComment[]> {
      const { owner, repo } = await getOwnerRepo();
      const query = `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 100) {
                  nodes {
                    databaseId
                    body
                    bodyHTML
                    author { login }
                    path
                    line
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }
        }
      }`;

      const raw = await gh([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `number=${prNumber}`,
      ]);
      const data = JSON.parse(raw) as {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: Array<{
                  isResolved: boolean;
                  comments: {
                    nodes: Array<{
                      databaseId: number;
                      body: string;
                      bodyHTML: string;
                      author: { login: string };
                      path: string;
                      line: number;
                      createdAt: string;
                      updatedAt: string;
                    }>;
                  };
                }>;
              };
            };
          };
        };
      };
      const threads = data.data.repository.pullRequest.reviewThreads.nodes;
      const comments: PRComment[] = [];
      for (const thread of threads) {
        for (const c of thread.comments.nodes) {
          comments.push({
            id: c.databaseId,
            body: c.body,
            bodyHtml: c.bodyHTML,
            user: c.author.login,
            path: c.path,
            line: c.line,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            isResolved: thread.isResolved,
          });
        }
      }
      return comments;
    },

    async getPRReviewComments(prNumber: number): Promise<PRComment[]> {
      try {
        const raw = await gh([
          "api",
          `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
          "--jq",
          ".[] | {id: .id, body: .body, user: .user.login, state: .state}",
        ]);
        if (!raw.trim()) return [];
        return raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },

    async getCIChecks({ prNumber }: { prNumber: number }): Promise<CICheck[]> {
      const { owner, repo } = await getOwnerRepo();
      const query = `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    contexts(first: 100) {
                      nodes {
                        ... on CheckRun {
                          name
                          status
                          conclusion
                          detailsUrl
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`;
      const raw = await gh([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${repo}`,
        "-F",
        `number=${prNumber}`,
      ]);
      const data = JSON.parse(raw);
      const nodes =
        data.data.repository.pullRequest.commits.nodes[0]?.commit?.statusCheckRollup?.contexts
          ?.nodes ?? [];
      return nodes
        .filter((n: Record<string, string>) => n.name)
        .map((n: Record<string, string>) => ({
          name: n.name,
          status: n.status,
          conclusion: n.conclusion ?? "",
          url: n.detailsUrl ?? "",
        }));
    },
  };
}
