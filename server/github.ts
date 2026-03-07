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

export function createGitHubService(run: CommandRunner, cwd: string) {
  const gh = (args: string[]) => run(["gh", ...args], { cwd });

  return {
    async getCurrentPR(): Promise<PRInfo | null> {
      try {
        const raw = await gh([
          "pr",
          "view",
          "--json",
          "number,title,state,url,headRefName,baseRefName,body",
        ]);
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    async getPRComments(prNumber: number): Promise<PRComment[]> {
      try {
        const query = `query($number: Int!) {
          repository(owner: "{owner}", name: "{repo}") {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  isResolved
                  comments(first: 100) {
                    nodes {
                      databaseId
                      body
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
        // Resolve {owner}/{repo} via gh repo view
        const repoRaw = await gh(["repo", "view", "--json", "owner,name"]);
        const repo = JSON.parse(repoRaw) as { owner: { login: string }; name: string };
        const resolvedQuery = query
          .replace("{owner}", repo.owner.login)
          .replace("{repo}", repo.name);

        const raw = await gh([
          "api",
          "graphql",
          "-f",
          `query=${resolvedQuery}`,
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
      } catch {
        return [];
      }
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

    async getCIChecks(): Promise<CICheck[]> {
      try {
        const raw = await gh(["pr", "checks", "--json", "name,state,conclusion,detailsUrl"]);
        const checks = JSON.parse(raw);
        return checks.map((c: Record<string, string>) => ({
          name: c.name,
          status: c.state,
          conclusion: c.conclusion,
          url: c.detailsUrl,
        }));
      } catch {
        return [];
      }
    },
  };
}
