function parseSummary(summary) {
    let pullRequest;
    const sentence = summary
        .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)\s*$/im, (_match, number) => {
            pullRequest = Number(number);
            return '';
        })
        .trim();

    return { pullRequest, sentence };
}

async function queryGitHub(query) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return undefined;

    try {
        const response = await fetch(process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query }),
        });
        if (!response.ok) return undefined;

        const result = await response.json();
        if (result.errors) return undefined;

        return result.data?.repository;
    } catch {
        return undefined;
    }
}

async function resolvePullRequest(repository, commit, pullRequest) {
    const [owner, name] = repository.split('/');
    if (!owner || !name) return undefined;

    if (pullRequest) {
        const data = await queryGitHub(`query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    pullRequest(number: ${pullRequest}) {
      number
      url
      author { login url }
    }
  }
}`);
        return data?.pullRequest;
    }

    if (!commit) return undefined;
    const data = await queryGitHub(`query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    object(expression: ${JSON.stringify(commit)}) {
      ... on Commit {
        associatedPullRequests(first: 50) {
          nodes {
            number
            url
            mergedAt
            author { login url }
          }
        }
      }
    }
  }
}`);

    return data?.object?.associatedPullRequests?.nodes?.sort((left, right) => {
        if (!left.mergedAt && !right.mergedAt) return 0;
        if (!left.mergedAt) return 1;
        if (!right.mergedAt) return -1;
        return new Date(left.mergedAt) - new Date(right.mergedAt);
    })[0];
}

// noinspection JSUnusedGlobalSymbols
export default {
    async getReleaseLine(changeset, _type, options) {
        const { pullRequest, sentence } = parseSummary(changeset.summary);
        const repository = options?.repo || process.env.GITHUB_REPOSITORY;
        const pull = repository ? await resolvePullRequest(repository, changeset.commit, pullRequest) : undefined;

        if (!pull?.number || !pull.url || !pull.author?.login || !pull.author.url) {
            return `- ${sentence}`;
        }

        return `- ${sentence.replace(/\.$/, '')} by [@${pull.author.login}](${pull.author.url}) in [#${pull.number}](${pull.url})`;
    },

    getDependencyReleaseLine() {
        return '';
    },
};
