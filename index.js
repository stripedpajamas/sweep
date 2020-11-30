require('dotenv').config()

const log = require('pino')({ base: null })
const sqlite = require('sqlite3')
const github = require('@octokit/rest')
const got = require('got')
const HttpAgent = require('agentkeepalive')
const parseLinks = require('parse-link-header')

const { HttpsAgent } = HttpAgent

async function setup (tableName) {
  const db = new sqlite.Database('db.sqlite')
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (
      url text NOT NULL,
      data blob NOT NULL,
      git_hash text NOT NULL
    );`)
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_git_hash_pkg_jsons ON ${tableName} (git_hash)`)
  })

  const octokit = new github.Octokit({
    auth: process.env.SWEEP_TOKEN,
    agent: new HttpsAgent()
  })

  const client = got.extend({
    agent: {
      http: new HttpAgent(),
      https: new HttpsAgent()
    }
  })
  return { db, octokit, client }
}

async function cleanup (db) {
  db.close()
}

function getRateLimits (headers) {
  const resetTimestamp = parseInt(headers['x-ratelimit-reset'] || '0', 10) * 1000
  const requestsRemaining = parseInt(headers['x-ratelimit-remaining'] || '0', 10)
  return { resetTimestamp, requestsRemaining }
}

function getLastPageNumber (headers) {
  if (!headers.link) return 0
  const links = parseLinks(headers.link)
  if (!links.last) return 0
  return parseInt(links.last.page, 10)
}

function * getHelpfulParams (fileName) {
  const orderParams = ['asc', 'desc']

  switch (fileName) {
    case 'package.json': {
      // valid fields in a package.json; ref: https://docs.npmjs.com/files/package.json
      const searchTerms = [
        'name', 'version', 'description', 'keywords', 'homepage',
        'bugs', 'license', 'author', 'contributors', 'files',
        'main', 'browser', 'bin', 'man', 'directories', 'repository',
        'scripts', 'config', 'dependencies', 'devDependencies', 'peerDependencies',
        'bundledDependencies', 'optionalDependencies', 'engines', 'engineStrict', 'os',
        'cpu', 'preferGlobal', 'private', 'publishConfig'
      ]

      for (const searchTerm of searchTerms) {
        yield { sortParam: undefined, searchTerm } // 30,000
      }

      for (const orderParam of orderParams) {
        for (const searchTerm of searchTerms) {
          yield { sortParam: 'indexed', orderParam, searchTerm } // 60,000
        }
      }
      break
    }
    default: {
      yield { sortParam: undefined, searchTerm: '' }

      for (const orderParam of orderParams) {
        yield { sortParam: 'indexed', orderParam, searchTerm: '' }
      }

      break
    }
  }
}

async function getSearchResults (api, fileName, page, params) {
  const { sortParam, orderParam, searchTerm } = params
  const res = await api.search.code({
    q: `${searchTerm} filename:${fileName}`,
    per_page: 100,
    page,
    sort: sortParam,
    order: orderParam
  })

  const { data, headers } = res
  const rateLimits = getRateLimits(headers)
  const lastPageNumber = getLastPageNumber(headers)

  return { data, rateLimits, lastPageNumber }
}

function saveFileData (db, tableName, { url, content, githash }) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO ${tableName} VALUES (?, ?, ?)`, [url, content, githash], (err, res) => {
      if (err) {
        if (err.errno === 19) {
          // if we've seen it before, don't worry about it
          return resolve(0)
        }
        return reject(err)
      }
      return resolve(1)
    })
  })
}

async function downloadFile (client, url) {
  const rawUrl = url.replace(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/$2/')
  const res = await client(rawUrl)
  log.info('Downloaded %d byte file from %s', res.body.length, rawUrl)
  return res.body
}

async function haveSeenGitHash (db, tableName, githash) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT git_hash FROM ${tableName} WHERE git_hash = ?`, [githash], (err, row) => {
      if (err) {
        return reject(err)
      }
      return resolve(!!row)
    })
  })
}

async function processSearchResults (db, tableName, client, items) {
  const work = items.map(async (item) => {
    
    const { html_url: url, sha: githash } = item
    if (await haveSeenGitHash(db, tableName, githash)) {
      log.info('Have already seen git hash %s, skipping download/save', githash)
      return 0
    }

    const content = await downloadFile(client, url)
    const savedCount = await saveFileData(db, tableName, { url, content, githash })

    return savedCount
  })

  return (await Promise.all(work)).reduce((sum, res) => sum + res, 0)
}

function sleepUntil (timestamp, buffer = 2000) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), timestamp - Date.now() + buffer)
  })
}

function sleepFor (ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}

async function main () {
  const [_, __, fileName] = process.argv

  const tableName = fileName.replace(/\./g, '_')

  log.info(`Setting up DB (table name: ${tableName}) and API access`)
  const { db, octokit, client } = await setup(tableName)

  try {
    for (const params of getHelpfulParams(fileName)) {
      let lastPage = Number.POSITIVE_INFINITY
      for (let page = 0; page < lastPage; page++) {
        let res
        try {
          res = await getSearchResults(octokit, fileName, page, params)
        } catch (e) {
          if (e.status === 403 && e.headers && e.headers['retry-after']) {
          // abuse detection mechanism triggered :(
            await sleepFor(parseInt(e.headers['retry-after'], 10) * 1000)
            page--
            continue
          }
        }
        const { data, rateLimits, lastPageNumber } = res
        const lastCallTimestamp = Date.now()
        lastPage = lastPageNumber
        log.info(
          'Received %d results on page %d; last page is %d; requests remaining: %d',
          data.items.length, page, lastPage, rateLimits.requestsRemaining
        )

        const insertedCount = await processSearchResults(db, tableName, client, data.items)
        log.info('Inserted %d URLs into DB', insertedCount)

        const timeSinceLastCall = Date.now() - lastCallTimestamp
        if (rateLimits.requestsRemaining < 1) {
          log.info('Requests used up; sleeping until %d', rateLimits.resetTimestamp)
          await sleepUntil(rateLimits.resetTimestamp)
        } else if (timeSinceLastCall < 3000) {
          const timeToSleep = 3000 - timeSinceLastCall
          log.info('Sleeping %d ms to avoid abuse detection', timeToSleep)
          await sleepFor(timeToSleep)
        }
      }
    }
  } catch (e) {
    log.error(e)
  } finally {
    log.info('Closing database connection')

    await cleanup(db)
  }
}

main()
