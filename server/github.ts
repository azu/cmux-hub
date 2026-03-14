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

export function createGitHubService(run: CommandRunner, cwd: string) {
  const gh = (args: string[]) => run(["gh", ...args], { cwd });

  return {
    // Use `gh pr list` instead of `gh pr view` to distinguish "no PR" from API errors.
    // `gh pr view` returns exit code 1 for both cases, making them indistinguishable.
    // `gh pr list` returns exit code 0 with empty array when no PR exists,
    // and exit code 1 only on real API errors (network, auth).
    // ref: https://github.com/cli/cli — `gh pr view` vs `gh pr list` exit code behavior
    async getCurrentPR(branch: string): Promise<PRInfo | null> {
      const raw = await gh([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,title,state,url,headRefName,baseRefName,body",
        "--limit",
        "1",
      ]);
      const results: PRInfo[] = JSON.parse(raw);
      return results.length > 0 ? (results[0] ?? null) : null;
    },

    async getPRComments(prNumber: number): Promise<PRComment[]> {
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
      // Resolve {owner}/{repo} via gh repo view
      const repoRaw = await gh(["repo", "view", "--json", "owner,name"]);
      const repo = JSON.parse(repoRaw) as { owner: { login: string }; name: string };
      const resolvedQuery = query.replace("{owner}", repo.owner.login).replace("{repo}", repo.name);

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
      const repoRaw = await gh(["repo", "view", "--json", "owner,name"]);
      const repo = JSON.parse(repoRaw) as { owner: { login: string }; name: string };
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
        `owner=${repo.owner.login}`,
        "-F",
        `name=${repo.name}`,
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
