# Contributing

Issues and pull requests are welcome. The default branch is `development`; open pull requests against it.

```bash
docker compose -f dev/docker-compose.yml -p hu-mm-av up -d   # local Mattermost on :8065
./dev/seed.sh
make test            # Go tests (in Docker, no local Go needed)
make deploy-local    # build and install on the local server
```

- Keep the webapp dependency-free. React, ReactDOM and React-Redux come from Mattermost.
- Use only documented Mattermost plugin APIs. The original voice plugin broke when it relied on webapp internals.
- Use fictional speech in tests and examples, never real voice recordings of other people.
- By contributing, you agree that your contribution is licensed under the MIT License.
