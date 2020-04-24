# sweep 🧹

1. Search for URLs of package.json files across GitHub
1. Download those package.json files and persist them in SQLite 

## usage (probably don't use)
- Requires `SWEEP_TOKEN` env var (GH personal access token).
- Dies on errors, but hopefully with enough info to start back up

GH only provides 10 pages worth of results -- about 1000 package.json's. There are >6MM package.json's on GitHub. How can we find them? For now, we mess with the search params so that the "window" of 1000 results is hopefully looking at a different part of those >6MM results each time.

There aren't many search params, and text searches have to have exact matches (searching for "d filename:package.json" has 0 results, but searching for "dependencies filename:package.json" has millions). The other knobs we can turn are `sort` and `order`. `sort` only allows two states: `undefined` and `indexed`, meaning "best match" and "by time of last index" respectively. `order` only allows two states: `asc` and `desc`, both self-explanatory. Normally searching using the same query and only adjusting the sort or order would be a waste of time, but since we are only accessing a window of the results, those parameters do end up affecting where the window ends up. 

All together, you get something snurgly like this:

```
function * getHelpfulParams () {
  const sortParams = ['indexed', undefined]
  const orderParams = ['asc', 'desc']
  
  // valid fields in a package.json; ref: https://docs.npmjs.com/files/package.json
  const searchTerms = [
    'name', 'version', 'description', 'keywords', 'homepage',
    'bugs', 'license', 'author', 'contributors', 'files',
    'main', 'browser', 'bin', 'man', 'directories', 'repository',
    'scripts', 'config', 'dependencies', 'devDependencies', 'peerDependencies',
    'bundledDependencies', 'optionalDependencies', 'engines', 'engineStrict', 'os',
    'cpu', 'preferGlobal', 'private', 'publishConfig'
  ]

  for (const sortParam of sortParams) {
    for (const orderParam of orderParams) {
      for (const searchTerm of searchTerms) {
        yield { sortParam, orderParam, searchTerm }
      }
    }
  }
}
```

Since each search results in 10 pages of 100 results, you get about 120,000 package.json's (with many duplicates). Sweep ignores dupes and at the time of writing ends up with about 45,000 unique package.json's. Since GitHub's internal indexing state is a variable at play, more unique package.json's are potentially available on subsequent runs.

```shell
$ npm install
$ node . | tee sweep.log | npx pino-pretty
# or just node .
```
