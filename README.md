# sweep 🧹

1. Search for URLs of package.json files across GitHub
1. Download those package.json files and persist them in SQLite 

## running (don't)
- Requires `SWEEP_TOKEN` env var (GH personal access token).
- Dies on errors, but hopefully with enough info to start back up
- GH only provides 10 pages worth of results -- about 1000 package.json's
- Results are somewhat random, so multiple runs aren't unhelpful

```shell
npm install
node . [page]
```
